#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { SceneSyncClient, SceneSyncApiError } from './scene-sync-client.mjs'
import { SessionStore } from './session-store.mjs'
import {
  ValidationError,
  assertLinked,
  assertCode,
  assertObjectId,
  normalizeVec3,
  normalizeQuat,
  normalizeScale,
  normalizeColor,
  normalizePrimitive,
  primitiveToName,
  normalizeName,
  makeObjectId
} from './validators.mjs'
import { jsonResult, errorResult, successResult } from './tool-results.mjs'

const client = new SceneSyncClient()
const store = new SessionStore()
const server = new McpServer({
  name: 'scene-sync-mcp',
  version: '0.1.0'
})

// Initialize session from file if configured
await store.load()

// Helper to get current session or throw error
function getSession() {
  const session = store.get()
  assertLinked(session)
  return session
}

// Helper to format API errors for users
function formatApiError(error) {
  if (error instanceof SceneSyncApiError) {
    return `API error (${error.status}): ${error.message}`
  }
  return error.message
}

// Helper to sanitize screenshot response
function sanitizeScreenshotResult(result) {
  if (!result || typeof result !== 'object') return result

  const copy = { ...result }

  if (typeof copy.dataUrl === 'string' && copy.dataUrl.length > 1000) {
    copy.dataUrlPreview = copy.dataUrl.slice(0, 80)
    copy.dataUrlLength = copy.dataUrl.length
    copy.hasDataUrl = true
    delete copy.dataUrl
  }

  return copy
}

// Helper to normalize objects (array or map)
function normalizeObjects(objects) {
  if (Array.isArray(objects)) return objects

  if (objects && typeof objects === 'object') {
    return Object.entries(objects).map(([objectId, value]) => ({
      objectId,
      ...value
    }))
  }

  return []
}

// Helper to summarize large scene
function summarizeScene(scene) {
  const objects = normalizeObjects(scene?.objects)
  const maxObjects = 50

  if (objects.length <= maxObjects) {
    return {
      ok: scene?.ok ?? true,
      ...scene
    }
  }

  return {
    ok: scene?.ok ?? true,
    roomId: scene?.roomId,
    userPresent: scene?.userPresent,
    objectCount: objects.length,
    objects: objects.slice(0, maxObjects).map((obj) => ({
      objectId: obj.objectId,
      name: obj.name,
      position: obj.position,
      rotation: obj.rotation,
      scale: obj.scale,
      asset: obj.asset
    })),
    truncated: true
  }
}

// Helper to add primitive objects
async function addPrimitiveHandler(primitive, args) {
  try {
    const session = getSession()

    const prim = normalizePrimitive(primitive)
    const objectId = args.objectId || makeObjectId(`ai-${prim}`)
    const name = normalizeName(args.name, primitiveToName(prim))
    const position = normalizeVec3(args.position)
    const rotation = normalizeQuat(args.rotation)
    const scale = normalizeScale(args.scale)
    const color = normalizeColor(args.color, process.env.SCENE_SYNC_DEFAULT_COLOR || '#ff8800')

    const payload = {
      kind: 'scene-add',
      objectId,
      name,
      position,
      rotation,
      scale,
      asset: {
        type: 'primitive',
        primitive: prim,
        color
      }
    }

    const response = await client.broadcast(session.roomId, session.sessionId, payload)

    return successResult({
      room: response.room || session.roomId,
      objectId,
      primitive: prim,
      userPresent: response.userPresent !== false
    })
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResult(e.message)
    }
    return errorResult(formatApiError(e))
  }
}

// scene_sync_redeem
server.registerTool(
  'scene_sync_redeem',
  {
    title: 'Redeem Scene Sync AI link code',
    description: 'Redeem a 6-digit Scene Sync pairing code and store the session locally. Call this after the user opens Scene Sync, presses "AIにリンク", and provides the code.',
    inputSchema: z.object({
      code: z.string().regex(/^\d{6}$/).describe('6-digit pairing code from Scene Sync')
    })
  },
  async ({ code }) => {
    try {
      const response = await client.redeem(code)
      const expiresAt = response.expiresAt || (response.expiresIn ? Date.now() + response.expiresIn * 1000 : null)

      const session = {
        sessionId: response.sessionId,
        roomId: response.roomId || response.room,
        expiresAt,
        linkedAt: Date.now()
      }
      store.set(session)
      await store.save(session)

      return successResult({
        roomId: session.roomId,
        expiresAt,
        message: 'Scene Sync linked.'
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e.message)
      }
      return errorResult(formatApiError(e))
    }
  }
)

// scene_sync_status
server.registerTool(
  'scene_sync_status',
  {
    title: 'Scene Sync link status',
    description: 'Get the current Scene Sync link status and expiration time.',
    inputSchema: z.object({})
  },
  async () => {
    try {
      const session = store.get()
      if (!session.sessionId || !session.roomId) {
        return jsonResult({
          linked: false,
          message: 'Not linked. Ask the user to press AIにリンク in Scene Sync and provide the 6-digit code.'
        })
      }

      if (session.expiresAt && session.expiresAt <= Date.now()) {
        return jsonResult({
          linked: false,
          message: 'Link expired. Ask the user to redeem a new code.'
        })
      }

      const expiresInSec = session.expiresAt ? Math.ceil((session.expiresAt - Date.now()) / 1000) : null
      return jsonResult({
        linked: true,
        roomId: session.roomId,
        expiresAt: session.expiresAt,
        expiresInSec
      })
    } catch (e) {
      return errorResult(e.message)
    }
  }
)

// scene_sync_get_scene
server.registerTool(
  'scene_sync_get_scene',
  {
    title: 'Get Scene Sync scene state',
    description: 'Get the current scene state (objects and environment settings). Returns a summary if objects exceed 50 items. May take up to 5 seconds.',
    inputSchema: z.object({})
  },
  async () => {
    try {
      const session = getSession()
      const response = await client.getScene(session.roomId, session.sessionId)
      const summarized = summarizeScene(response)

      return jsonResult({
        ok: true,
        ...summarized
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e.message)
      }
      return errorResult(formatApiError(e))
    }
  }
)

// scene_sync_add_primitive
server.registerTool(
  'scene_sync_add_primitive',
  {
    title: 'Add a primitive object',
    description: 'Add a primitive object (box, sphere, cylinder, or plane) to the scene. Prefer scene_sync_add_box or scene_sync_add_sphere for common cases.',
    inputSchema: z.object({
      primitive: z.enum(['box', 'sphere', 'cylinder', 'plane']).describe('Shape type'),
      objectId: z.string().optional().describe('Unique object ID (auto-generated if omitted)'),
      name: z.string().optional().describe('Display name (auto-generated if omitted)'),
      position: z.array(z.number()).length(3).optional().describe('[x, y, z] position in meters'),
      rotation: z.array(z.number()).length(4).optional().describe('[x, y, z, w] quaternion'),
      scale: z.array(z.number()).length(3).optional().describe('[x, y, z] scale'),
      color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional().describe('#RGB or #RRGGBB color')
    })
  },
  async ({ primitive, objectId, name, position, rotation, scale, color }) => {
    return addPrimitiveHandler(primitive, { objectId, name, position, rotation, scale, color })
  }
)

// scene_sync_add_box
server.registerTool(
  'scene_sync_add_box',
  {
    title: 'Add a box',
    description: 'Add a box to the scene. Use directly for clear requests like "add a red cube".',
    inputSchema: z.object({
      objectId: z.string().optional().describe('Unique object ID (auto-generated if omitted)'),
      name: z.string().optional().describe('Display name (auto-generated if omitted)'),
      position: z.array(z.number()).length(3).optional().describe('[x, y, z] position'),
      rotation: z.array(z.number()).length(4).optional().describe('[x, y, z, w] quaternion'),
      scale: z.array(z.number()).length(3).optional().describe('[x, y, z] scale'),
      color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional().describe('#RGB or #RRGGBB color')
    })
  },
  async ({ objectId, name, position, rotation, scale, color }) => {
    return addPrimitiveHandler('box', { objectId, name, position, rotation, scale, color })
  }
)

// scene_sync_add_sphere
server.registerTool(
  'scene_sync_add_sphere',
  {
    title: 'Add a sphere',
    description: 'Add a sphere to the scene.',
    inputSchema: z.object({
      objectId: z.string().optional().describe('Unique object ID (auto-generated if omitted)'),
      name: z.string().optional().describe('Display name (auto-generated if omitted)'),
      position: z.array(z.number()).length(3).optional().describe('[x, y, z] position'),
      rotation: z.array(z.number()).length(4).optional().describe('[x, y, z, w] quaternion'),
      scale: z.array(z.number()).length(3).optional().describe('[x, y, z] scale'),
      color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional().describe('#RGB or #RRGGBB color')
    })
  },
  async ({ objectId, name, position, rotation, scale, color }) => {
    return addPrimitiveHandler('sphere', { objectId, name, position, rotation, scale, color })
  }
)

// scene_sync_move_object
server.registerTool(
  'scene_sync_move_object',
  {
    title: 'Move an object',
    description: 'Move an object to a new absolute position.',
    inputSchema: z.object({
      objectId: z.string().describe('Target object ID'),
      position: z.array(z.number()).length(3).describe('[x, y, z] new position')
    })
  },
  async ({ objectId, position }) => {
    try {
      const session = getSession()
      assertObjectId(objectId)
      const finalPosition = normalizeVec3(position)

      const payload = {
        kind: 'scene-delta',
        objectId,
        position: finalPosition
      }

      await client.broadcast(session.roomId, session.sessionId, payload)

      return successResult({
        objectId,
        position: finalPosition
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e.message)
      }
      return errorResult(formatApiError(e))
    }
  }
)

// scene_sync_rotate_object
server.registerTool(
  'scene_sync_rotate_object',
  {
    title: 'Rotate an object',
    description: 'Rotate an object using a quaternion.',
    inputSchema: z.object({
      objectId: z.string().describe('Target object ID'),
      rotation: z.array(z.number()).length(4).describe('[x, y, z, w] quaternion')
    })
  },
  async ({ objectId, rotation }) => {
    try {
      const session = getSession()
      assertObjectId(objectId)
      const finalRotation = normalizeQuat(rotation)

      const payload = {
        kind: 'scene-delta',
        objectId,
        rotation: finalRotation
      }

      await client.broadcast(session.roomId, session.sessionId, payload)

      return successResult({
        objectId,
        rotation: finalRotation
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e.message)
      }
      return errorResult(formatApiError(e))
    }
  }
)

// scene_sync_scale_object
server.registerTool(
  'scene_sync_scale_object',
  {
    title: 'Scale an object',
    description: 'Scale an object.',
    inputSchema: z.object({
      objectId: z.string().describe('Target object ID'),
      scale: z.array(z.number()).length(3).describe('[x, y, z] scale')
    })
  },
  async ({ objectId, scale }) => {
    try {
      const session = getSession()
      assertObjectId(objectId)
      const finalScale = normalizeScale(scale)

      const payload = {
        kind: 'scene-delta',
        objectId,
        scale: finalScale
      }

      await client.broadcast(session.roomId, session.sessionId, payload)

      return successResult({
        objectId,
        scale: finalScale
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e.message)
      }
      return errorResult(formatApiError(e))
    }
  }
)

// scene_sync_set_color
server.registerTool(
  'scene_sync_set_color',
  {
    title: 'Change object color',
    description: 'Change the color of a primitive object.',
    inputSchema: z.object({
      objectId: z.string().describe('Target object ID'),
      color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).describe('#RGB or #RRGGBB color'),
      primitive: z.enum(['box', 'sphere', 'cylinder', 'plane']).optional().default('box').describe('Primitive type (defaults to box if unknown)')
    })
  },
  async ({ objectId, color, primitive }) => {
    try {
      const session = getSession()
      assertObjectId(objectId)
      const finalColor = normalizeColor(color)
      const prim = primitive || 'box'

      const payload = {
        kind: 'scene-delta',
        objectId,
        asset: {
          type: 'primitive',
          primitive: prim,
          color: finalColor
        }
      }

      await client.broadcast(session.roomId, session.sessionId, payload)

      return successResult({
        objectId,
        color: finalColor
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e.message)
      }
      return errorResult(formatApiError(e))
    }
  }
)

// scene_sync_focus_object
server.registerTool(
  'scene_sync_focus_object',
  {
    title: 'Focus camera on object',
    description: 'Focus the browser camera on an object. Requires objectId.',
    inputSchema: z.object({
      objectId: z.string().describe('Target object ID (required)')
    })
  },
  async ({ objectId }) => {
    try {
      const session = getSession()
      assertObjectId(objectId)

      await client.aiCommand(session.roomId, session.sessionId, 'focusObject', {
        objectId
      })

      return jsonResult({
        ok: true,
        objectId,
        action: 'focusObject'
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e.message)
      }
      return errorResult(formatApiError(e))
    }
  }
)

// scene_sync_screenshot
server.registerTool(
  'scene_sync_screenshot',
  {
    title: 'Take screenshot',
    description: 'Request a screenshot from the browser. May take a few seconds.',
    inputSchema: z.object({})
  },
  async () => {
    try {
      const session = getSession()

      const response = await client.aiCommand(session.roomId, session.sessionId, 'screenshot', {}, {
        timeout: 10000
      })

      const sanitized = sanitizeScreenshotResult(response)

      return jsonResult({
        ok: true,
        ...sanitized
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e.message)
      }
      return errorResult(formatApiError(e))
    }
  }
)

// scene_sync_revoke
server.registerTool(
  'scene_sync_revoke',
  {
    title: 'Revoke Scene Sync link',
    description: 'Revoke the current Scene Sync link.',
    inputSchema: z.object({})
  },
  async () => {
    try {
      const session = store.get()
      if (session.sessionId) {
        try {
          await client.revoke(session.sessionId)
        } catch (e) {
          // API error on revoke is not critical; clear session anyway
          console.error('[scene-sync-mcp] Revoke API error:', e.message)
        }
      }

      await store.clear()

      return successResult({
        message: 'Scene Sync link revoked.'
      })
    } catch (e) {
      return errorResult(e.message)
    }
  }
)

// Optional raw broadcast tool
if (process.env.SCENE_SYNC_ENABLE_RAW_TOOLS === 'true') {
  server.registerTool(
    'scene_sync_raw_broadcast',
    {
      title: 'Raw broadcast (developer only)',
      description: 'Raw broadcast tool (developer only). Send any payload to /broadcast. Unsafe - disabled by default.',
      inputSchema: z.object({
        payload: z.record(z.any()).describe('Raw broadcast payload')
      })
    },
    async ({ payload }) => {
      try {
        const session = getSession()

        const response = await client.broadcast(session.roomId, session.sessionId, payload)

        return jsonResult({
          ok: true,
          ...response
        })
      } catch (e) {
        if (e instanceof ValidationError) {
          return errorResult(e.message)
        }
        return errorResult(formatApiError(e))
      }
    }
  )
}

// Connect stdio transport
const transport = new StdioServerTransport()
await server.connect(transport)
