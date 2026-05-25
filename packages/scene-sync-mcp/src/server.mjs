#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { SceneSyncClient } from './scene-sync-client.mjs'
import { SessionStore } from './session-store.mjs'
import {
  ValidationError,
  assertLinked,
  assertObjectId,
  assertVec3,
  normalizeVec3,
  normalizeQuat,
  normalizeScale,
  normalizeColor,
  normalizePrimitive,
  primitiveToName,
  normalizeName,
  makeObjectId,
  assertBoundsWorld,
  computeAlignedPosition,
  computeFitScale
} from './validators.mjs'
import { jsonResult, errorResult, successResult, imageResult } from './tool-results.mjs'

const client = new SceneSyncClient()
const store = new SessionStore()
const server = new McpServer({
  name: 'scene-sync-mcp',
  version: '0.1.0'
})

// Helper to get current session or throw error
function getSession() {
  const session = store.get()
  assertLinked(session)
  return session
}

// Helper to check aiCommand response for errors
function assertAiCommandOk(response) {
  const nested = response?.result
  const error = response?.error || nested?.error
  if (response?.ok === false || nested?.ok === false || error) {
    throw new Error(error || 'ai-command failed')
  }

  return response
}

// Helper to run AI commands
async function runAiCommand(action, params = {}, options = {}) {
  const session = getSession()
  const response = await client.aiCommand(
    session.roomId,
    session.sessionId,
    action,
    params,
    options
  )

  assertAiCommandOk(response)
  return response
}

// Helper to sanitize screenshot response (recursively handles nested dataUrl fields)
function sanitizeScreenshotResult(value) {
  if (!value || typeof value !== 'object') return value

  if (Array.isArray(value)) {
    return value.map(sanitizeScreenshotResult)
  }

  const copy = { ...value }

  for (const key of Object.keys(copy)) {
    const v = copy[key]
    const keyLower = key.toLowerCase()

    if (
      typeof v === 'string' &&
      (keyLower === 'dataurl' || keyLower.endsWith('dataurl')) &&
      v.length > 1000
    ) {
      copy[`${key}Preview`] = v.slice(0, 80)
      copy[`${key}Length`] = v.length
      copy.hasDataUrl = true
      delete copy[key]
      continue
    }

    if (v && typeof v === 'object') {
      copy[key] = sanitizeScreenshotResult(v)
    }
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
      bounds: obj.bounds,
      asset: obj.asset
    })),
    truncated: true
  }
}

function listSceneObjects(scene) {
  return normalizeObjects(scene?.objects)
}

function findSceneObject(scene, objectId) {
  return listSceneObjects(scene).find((obj) => obj.objectId === objectId) || null
}

function getWorldBounds(object) {
  const bounds = object?.bounds?.world
  if (!bounds) {
    throw new ValidationError(`Object ${object?.objectId || '(unknown)'} has no bounds.world`)
  }
  assertBoundsWorld(bounds, `Object ${object?.objectId || '(unknown)'}.bounds.world`)
  return bounds
}

function getObjectPosition(object) {
  const position = object?.position
  if (position === undefined) {
    throw new ValidationError(`Object ${object?.objectId || '(unknown)'} has no position`)
  }
  assertVec3(position, `Object ${object?.objectId || '(unknown)'}.position`)
  return position
}

function getObjectScale(object) {
  return normalizeScale(object?.scale, [1, 1, 1])
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
      return errorResult(e)
    }
    return errorResult(e)
  }
}

const httpUrlSchema = z.string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'url must be an HTTP(S) URL'
  })

const urlTransformInputSchema = z.object({
  url: httpUrlSchema.describe('Publicly fetchable HTTP(S) URL. Must be accessible from the browser.'),
  objectId: z.string().optional().describe('Unique object ID. Auto-generated if omitted.'),
  name: z.string().optional().describe('Display name. If omitted, browser may infer from URL filename.'),
  position: z.array(z.number()).length(3).optional().describe('[x, y, z] position in meters'),
  rotation: z.array(z.number()).length(4).optional().describe('[x, y, z, w] quaternion'),
  scale: z.array(z.number()).length(3).optional().describe('[x, y, z] scale')
})

function makeUrlAssetToolHandler(action, options = {}) {
  const {
    objectIdPrefix = 'ai-asset',
    defaultName = 'Remote Asset',
    timeout = 60000
  } = options

  return async ({ url, objectId, name, position, rotation, scale }) => {
    try {
      const finalObjectId = objectId || makeObjectId(objectIdPrefix)
      assertObjectId(finalObjectId)

      const params = {
        url,
        objectId: finalObjectId,
        position: normalizeVec3(position, [0, 0, 0]),
        rotation: normalizeQuat(rotation),
        scale: normalizeScale(scale)
      }

      if (name) {
        params.name = normalizeName(name, defaultName)
      }

      const response = await runAiCommand(action, params, { timeout })

      return jsonResult({
        ...response,
        ok: true,
        objectId: finalObjectId,
        action
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
    }
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
        return errorResult(e)
      }
      return errorResult(e)
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
      return errorResult(e)
    }
  }
)

// scene_sync_get_scene
server.registerTool(
  'scene_sync_get_scene',
  {
    title: 'Get Scene Sync scene state',
    description: 'Get the current scene state (objects and environment settings). Returns a summary if objects exceed 50 items. May take up to 5 seconds.',
    inputSchema: z.object({
      selectedOnly: z.boolean().optional().describe(
        'If true, return only currently selected objects from the linked browser.'
      )
    })
  },
  async ({ selectedOnly } = {}) => {
    try {
      if (selectedOnly) {
        const response = await runAiCommand(
          'getSelection',
          {},
          { timeout: 10000 }
        )

        return jsonResult({
          ...response,
          ok: response?.ok !== false,
          selectedOnly: true
        })
      }

      const session = getSession()
      const response = await client.getScene(session.roomId, session.sessionId)
      const summarized = summarizeScene(response)

      return jsonResult({
        ...summarized,
        ok: true
      })
    } catch (e) {
      return errorResult(e)
    }
  }
)

// scene_sync_get_selection
server.registerTool(
  'scene_sync_get_selection',
  {
    title: 'Get current Scene Sync selection',
    description: 'Get the objects currently selected in the linked Scene Sync browser. This is a generic current-selection API for external tools, not AI-specific. Use this before scoped operations such as aligning, distributing, randomizing, transforming, or applying Loomlet graphs to selected objects.',
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async () => {
    try {
      const response = await runAiCommand(
        'getSelection',
        {},
        { timeout: 10000 }
      )

      return jsonResult({
        ...response,
        ok: response?.ok !== false,
        action: 'getSelection'
      })
    } catch (e) {
      return errorResult(e)
    }
  }
)

// scene_sync_set_animation_clip
const animationClipInputSchema = z.object({
  objectId: z.string().describe('Target animated GLB object ID'),
  clipName: z.string().optional().describe('Animation clip name, such as idle, laugh, talk, or attack_1'),
  name: z.string().optional().describe('Alias for clipName'),
  clip: z.number().int().min(0).optional().describe('Animation clip index. Takes priority over clipName.'),
  mode: z.enum(['loop', 'once']).optional().describe('Playback mode. Defaults to loop.'),
  speed: z.number().min(0).optional().describe('Playback speed. Omit to keep current speed.'),
  enabled: z.boolean().optional().describe('Whether animation playback is enabled. Defaults to true.')
}).refine((value) => (
  value.clip !== undefined ||
  typeof value.clipName === 'string' ||
  typeof value.name === 'string'
), {
  message: 'clip, clipName, or name is required'
})

server.registerTool(
  'scene_sync_set_animation_clip',
  {
    title: 'Set GLB animation clip',
    description: 'Switch an animated GLB object to a specific animation clip by name or index. Use scene_sync_get_selection or scene_sync_get_scene first to inspect available animationClips.',
    inputSchema: animationClipInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ objectId, clipName, name, clip, mode, speed, enabled }) => {
    try {
      assertObjectId(objectId)

      const params = { objectId }

      if (clip !== undefined) params.clip = clip
      if (clipName !== undefined) params.clipName = clipName
      if (name !== undefined) params.name = name
      if (mode !== undefined) params.mode = mode
      if (speed !== undefined) params.speed = speed
      if (enabled !== undefined) params.enabled = enabled

      const response = await runAiCommand(
        'setAnimationClip',
        params,
        { timeout: 10000 }
      )

      return jsonResult({
        ...response,
        ok: response?.ok !== false,
        action: 'setAnimationClip',
        objectId
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
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

// scene_sync_add_glb_from_url
server.registerTool(
  'scene_sync_add_glb_from_url',
  {
    title: 'Add a GLB model from URL',
    description: 'Add a GLB/glTF model to the Scene Sync scene from a publicly fetchable HTTP(S) URL. The URL must be fetchable by the browser and may require CORS headers.',
    inputSchema: urlTransformInputSchema.extend({
      url: httpUrlSchema.describe('Publicly fetchable GLB/glTF URL. Must be accessible from the browser.')
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  makeUrlAssetToolHandler('uploadGlbFromUrl', {
    objectIdPrefix: 'ai-model',
    defaultName: 'GLB Model'
  })
)

// scene_sync_add_image_from_url
server.registerTool(
  'scene_sync_add_image_from_url',
  {
    title: 'Add an image from URL',
    description: 'Add an image panel to the Scene Sync scene from a publicly fetchable HTTP(S) URL. The URL must be fetchable by the browser and may require CORS headers.',
    inputSchema: urlTransformInputSchema.extend({
      url: httpUrlSchema.describe('Publicly fetchable image URL. Must be accessible from the browser.')
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  makeUrlAssetToolHandler('addImageFromUrl', {
    objectIdPrefix: 'ai-image',
    defaultName: 'Image Panel'
  })
)

// scene_sync_add_video_from_url
server.registerTool(
  'scene_sync_add_video_from_url',
  {
    title: 'Add a video from URL',
    description: 'Add a video panel to the Scene Sync scene from a publicly fetchable HTTP(S) URL. The URL must be fetchable by the browser and may require CORS headers.',
    inputSchema: urlTransformInputSchema.extend({
      url: httpUrlSchema.describe('Publicly fetchable video URL. Must be accessible from the browser.')
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  makeUrlAssetToolHandler('addVideoFromUrl', {
    objectIdPrefix: 'ai-video',
    defaultName: 'Video Panel'
  })
)

// scene_sync_add_text_from_url
server.registerTool(
  'scene_sync_add_text_from_url',
  {
    title: 'Add text from URL',
    description: 'Fetch text content from a publicly fetchable HTTP(S) URL and add it to the Scene Sync scene as a text panel. The URL must be fetchable by the browser and may require CORS headers.',
    inputSchema: urlTransformInputSchema.extend({
      url: httpUrlSchema.describe('Publicly fetchable text URL. Must be accessible from the browser.')
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  makeUrlAssetToolHandler('addTextFromUrl', {
    objectIdPrefix: 'ai-text',
    defaultName: 'Text Panel'
  })
)

// scene_sync_set_skybox_from_image_url
server.registerTool(
  'scene_sync_set_skybox_from_image_url',
  {
    title: 'Set skybox from image URL',
    description: 'Set the Scene Sync skybox from a publicly fetchable HTTP(S) image URL. This replaces the current skybox/environment image in the browser scene.',
    inputSchema: z.object({
      url: httpUrlSchema.describe('Publicly fetchable skybox image URL. Must be accessible from the browser.')
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async ({ url }) => {
    try {
      const response = await runAiCommand(
        'setSkyboxFromImageUrl',
        { url },
        { timeout: 60000 }
      )

      return jsonResult({
        ...response,
        ok: true,
        action: 'setSkyboxFromImageUrl',
        url
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
    }
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
        return errorResult(e)
      }
      return errorResult(e)
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
        return errorResult(e)
      }
      return errorResult(e)
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
        return errorResult(e)
      }
      return errorResult(e)
    }
  }
)

const alignAxisRuleSchema = z.object({
  source: z.enum(['min', 'center', 'max']).describe('Source bounds anchor'),
  target: z.enum(['min', 'center', 'max']).optional().describe('Target bounds anchor'),
  value: z.number().optional().describe('Explicit world-space value to align to'),
  offset: z.number().optional().describe('Optional offset in meters after alignment')
})

// scene_sync_set_transform
server.registerTool(
  'scene_sync_set_transform',
  {
    title: 'Set object transform',
    description: 'Set object position, rotation, and/or scale in one scene-delta update. Use this when multiple transform fields should be updated together.',
    inputSchema: z.object({
      objectId: z.string().describe('Target object ID'),
      position: z.array(z.number()).length(3).optional().describe('[x, y, z] position in meters'),
      rotation: z.array(z.number()).length(4).optional().describe('[x, y, z, w] quaternion'),
      scale: z.array(z.number()).length(3).optional().describe('[x, y, z] scale')
    }).refine((value) => (
      value.position !== undefined ||
      value.rotation !== undefined ||
      value.scale !== undefined
    ), {
      message: 'At least one of position, rotation, or scale is required'
    })
  },
  async ({ objectId, position, rotation, scale }) => {
    try {
      const session = getSession()
      assertObjectId(objectId)

      const payload = {
        kind: 'scene-delta',
        objectId
      }

      if (position !== undefined) {
        payload.position = normalizeVec3(position)
      }
      if (rotation !== undefined) {
        payload.rotation = normalizeQuat(rotation)
      }
      if (scale !== undefined) {
        payload.scale = normalizeScale(scale)
      }

      await client.broadcast(session.roomId, session.sessionId, payload)

      return successResult({
        objectId,
        ...(payload.position !== undefined ? { position: payload.position } : {}),
        ...(payload.rotation !== undefined ? { rotation: payload.rotation } : {}),
        ...(payload.scale !== undefined ? { scale: payload.scale } : {})
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
    }
  }
)

// scene_sync_align_bounds
server.registerTool(
  'scene_sync_align_bounds',
  {
    title: 'Align object bounds',
    description: 'Move a source object by aligning one or more world-bounds anchors to a target object or world coordinate. Useful for floor contact, wall fitting, and center alignment.',
    inputSchema: z.object({
      sourceObjectId: z.string().describe('Object to move'),
      targetObjectId: z.string().optional().describe('Object to align against. If omitted, use explicit axis values.'),
      axes: z.object({
        x: alignAxisRuleSchema.optional(),
        y: alignAxisRuleSchema.optional(),
        z: alignAxisRuleSchema.optional()
      }).describe('Per-axis alignment rules. Each axis uses either targetObjectId+target or explicit value.')
    })
  },
  async ({ sourceObjectId, targetObjectId, axes }) => {
    try {
      const session = getSession()
      assertObjectId(sourceObjectId)
      if (targetObjectId !== undefined) {
        assertObjectId(targetObjectId)
      }

      const scene = await client.getScene(session.roomId, session.sessionId)
      const sourceObject = findSceneObject(scene, sourceObjectId)
      if (!sourceObject) {
        throw new ValidationError(`Source object not found: ${sourceObjectId}`)
      }

      const targetObject = targetObjectId ? findSceneObject(scene, targetObjectId) : null
      if (targetObjectId && !targetObject) {
        throw new ValidationError(`Target object not found: ${targetObjectId}`)
      }

      const sourcePosition = getObjectPosition(sourceObject)
      const sourceBounds = getWorldBounds(sourceObject)
      const targetBounds = targetObject ? getWorldBounds(targetObject) : null

      const nextPosition = computeAlignedPosition({
        sourcePosition,
        sourceBounds,
        targetBounds,
        axes
      })

      await client.broadcast(session.roomId, session.sessionId, {
        kind: 'scene-delta',
        objectId: sourceObjectId,
        position: nextPosition
      })

      return successResult({
        objectId: sourceObjectId,
        position: nextPosition,
        aligned: axes,
        sourceBounds,
        targetObjectId: targetObjectId || null,
        targetBounds
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
    }
  }
)

// scene_sync_fit_bounds_size
server.registerTool(
  'scene_sync_fit_bounds_size',
  {
    title: 'Fit object bounds size',
    description: 'Scale an object so its world bounds size matches a target size on one or more axes. Useful for making panels or GLB models a real-world size.',
    inputSchema: z.object({
      objectId: z.string().describe('Target object ID'),
      size: z.object({
        x: z.number().positive().optional(),
        y: z.number().positive().optional(),
        z: z.number().positive().optional()
      }).refine((value) => (
        value.x !== undefined ||
        value.y !== undefined ||
        value.z !== undefined
      ), {
        message: 'At least one target size axis is required'
      }).describe('Target world bounds size in meters for each axis. Omitted axes keep proportional scale unless preserveAspect is false.'),
      preserveAspect: z.boolean().optional().describe('If true, use a uniform scale factor based on the first specified axis. Defaults to true.')
    })
  },
  async ({ objectId, size, preserveAspect = true }) => {
    try {
      const session = getSession()
      assertObjectId(objectId)

      const scene = await client.getScene(session.roomId, session.sessionId)
      const object = findSceneObject(scene, objectId)
      if (!object) {
        throw new ValidationError(`Object not found: ${objectId}`)
      }

      const bounds = getWorldBounds(object)
      const currentScale = getObjectScale(object)
      const currentBoundsSize = normalizeVec3(bounds.size, [
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2]
      ])

      const nextScale = computeFitScale({
        currentScale,
        currentBoundsSize,
        targetSize: size,
        preserveAspect
      })

      await client.broadcast(session.roomId, session.sessionId, {
        kind: 'scene-delta',
        objectId,
        scale: nextScale
      })

      return successResult({
        objectId,
        scale: nextScale,
        previousScale: currentScale,
        previousBoundsSize: currentBoundsSize,
        targetSize: size,
        preserveAspect
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
    }
  }
)

// scene_sync_set_color
server.registerTool(
  'scene_sync_set_color',
  {
    title: 'Change object color',
    description: 'Change the color of a primitive object. Primitive type is required. If the primitive type is unknown, call scene_sync_get_scene first and inspect the object\'s asset.primitive field.',
    inputSchema: z.object({
      objectId: z.string().describe('Target object ID'),
      color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).describe('#RGB or #RRGGBB color'),
      primitive: z.enum(['box', 'sphere', 'cylinder', 'plane']).describe('Existing primitive type (required). If unknown, call scene_sync_get_scene first.')
    })
  },
  async ({ objectId, color, primitive }) => {
    try {
      const session = getSession()
      assertObjectId(objectId)
      const finalColor = normalizeColor(color)

      const payload = {
        kind: 'scene-delta',
        objectId,
        asset: {
          type: 'primitive',
          primitive,
          color: finalColor
        }
      }

      await client.broadcast(session.roomId, session.sessionId, payload)

      return successResult({
        objectId,
        primitive,
        color: finalColor
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
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

      const response = await client.aiCommand(session.roomId, session.sessionId, 'focusObject', {
        objectId
      })

      assertAiCommandOk(response)

      return jsonResult({
        ...response,
        ok: true,
        objectId,
        action: 'focusObject'
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
    }
  }
)

// scene_sync_screenshot
server.registerTool(
  'scene_sync_screenshot',
  {
    title: 'Take screenshot',
    description: 'Request a screenshot from the browser. Defaults to returning MCP image content for visual verification. Use mode=url for a temporary URL instead.',
    inputSchema: z.object({
      mode: z.enum(['image', 'url']).optional().describe('Return mode. image returns MCP image content. url uploads to temporary Scene Sync blob and returns URL metadata. Defaults to image.'),
      maxWidth: z.number().int().min(128).max(2048).optional().describe('Maximum screenshot width in pixels for image mode. Browser may downscale before returning. Default 768. Can specify up to 2048 for higher quality.'),
      quality: z.number().min(0.1).max(1).optional().describe('JPEG quality. Default 0.7 for image mode.')
    })
  },
  async ({ mode = 'image', maxWidth = 768, quality } = {}) => {
    try {
      const session = getSession()

      const response = await client.aiCommand(
        session.roomId,
        session.sessionId,
        'screenshot',
        {
          mode,
          maxWidth,
          quality: quality ?? (mode === 'image' ? 0.7 : 0.92)
        },
        { timeout: 15000 }
      )

      assertAiCommandOk(response)

      const result = response?.result || response

      if (mode === 'image') {
        const base64 = result?.base64 || result?.data || null
        const mimeType = result?.mimeType || 'image/jpeg'

        if (!base64 || typeof base64 !== 'string') {
          return errorResult(new Error('screenshot did not return base64 image data'))
        }

        return imageResult({
          data: base64,
          mimeType,
          metadata: {
            ok: true,
            action: 'screenshot',
            mode: 'image',
            mimeType,
            width: result.width ?? null,
            height: result.height ?? null,
            room: response.room || session.roomId,
            userPresent: response.userPresent !== false,
            targetPeerId: response.targetPeerId || null
          }
        })
      }

      const sanitized = sanitizeScreenshotResult(response)

      return jsonResult({
        ...sanitized,
        ok: true,
        action: 'screenshot',
        mode: 'url'
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
    }
  }
)

// scene_sync_get_camera_pose
server.registerTool(
  'scene_sync_get_camera_pose',
  {
    title: 'Get camera pose',
    description: 'Get the current browser camera position and quaternion.',
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async () => {
    try {
      const response = await runAiCommand(
        'getCameraPose',
        {},
        { timeout: 10000 }
      )

      return jsonResult({
        ...response,
        ok: true,
        action: 'getCameraPose'
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
    }
  }
)

// scene_sync_get_history
server.registerTool(
  'scene_sync_get_history',
  {
    title: 'Get Scene Sync history',
    description: 'Get recent Scene Sync operation history from the browser.',
    inputSchema: z.object({
      count: z.number().int().min(1).max(50).optional().describe('Number of history entries to return, default 10')
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ count }) => {
    try {
      const response = await runAiCommand(
        'getHistory',
        { count: count || 10 },
        { timeout: 10000 }
      )

      return jsonResult({
        ...response,
        ok: true,
        action: 'getHistory'
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
    }
  }
)

// scene_sync_undo
server.registerTool(
  'scene_sync_undo',
  {
    title: 'Undo last Scene Sync operation',
    description: 'Undo the last operation recorded in the browser Scene Sync history.',
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async () => {
    try {
      const response = await runAiCommand(
        'undo',
        {},
        { timeout: 10000 }
      )

      return jsonResult({
        ...response,
        ok: true,
        action: 'undo'
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
    }
  }
)

// scene_sync_redo
server.registerTool(
  'scene_sync_redo',
  {
    title: 'Redo Scene Sync operation',
    description: 'Redo the last undone operation recorded in the browser Scene Sync history.',
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async () => {
    try {
      const response = await runAiCommand(
        'redo',
        {},
        { timeout: 10000 }
      )

      return jsonResult({
        ...response,
        ok: true,
        action: 'redo'
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
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
      return errorResult(e)
    }
  }
)

// scene_sync_replace_media
server.registerTool(
  'scene_sync_replace_media',
  {
    title: 'Replace media panel content',
    description: 'Replace the content of a media panel with an image or video URL. If objectId is omitted, the currently selected object is used.',
    inputSchema: z.object({
      objectId: z.string().optional().describe('Target object ID. If omitted, the single selected object is used.'),
      url: z.string().url().describe('Image or video URL.'),
      mediaType: z.enum(['image', 'video']).describe('Type of the URL media.'),
      name: z.string().optional().describe('Optional new object name.')
    })
  },
  async ({ objectId, url, mediaType, name }) => {
    try {
      const response = await runAiCommand('replaceMediaFromUrl', {
        objectId,
        url,
        mediaType,
        name
      }, { timeout: 30000 })

      return jsonResult({
        ...response,
        action: 'replaceMediaFromUrl'
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
    }
  }
)

// scene_sync_replace_text
server.registerTool(
  'scene_sync_replace_text',
  {
    title: 'Replace text panel content',
    description: 'Replace the text content of a text panel. If objectId is omitted, the currently selected object is used.',
    inputSchema: z.object({
      objectId: z.string().optional().describe('Target object ID. If omitted, the single selected object is used.'),
      text: z.string().describe('New text content.'),
      name: z.string().optional().describe('Optional new object name.'),
      fontFamily: z.enum(['system-sans', 'serif', 'monospace', 'japanese-sans', 'japanese-serif']).optional().describe('Optional font preset.'),
      fontSize: z.number().optional().describe('Optional font size in pixels.'),
      fontWeight: z.union([z.string(), z.number()]).optional().describe('Optional font weight.'),
      fontStyle: z.enum(['normal', 'italic']).optional().describe('Optional font style.'),
      color: z.string().optional().describe('Optional text color.'),
      backgroundColor: z.string().optional().describe('Optional background color.'),
      align: z.enum(['left', 'center', 'right']).optional().describe('Optional text alignment.')
    })
  },
  async ({ objectId, text, name, fontFamily, fontSize, fontWeight, fontStyle, color, backgroundColor, align }) => {
    try {
      const response = await runAiCommand('replaceTextContent', {
        objectId,
        text,
        name,
        fontFamily,
        fontSize,
        fontWeight,
        fontStyle,
        color,
        backgroundColor,
        align
      }, { timeout: 30000 })

      return jsonResult({
        ...response,
        action: 'replaceTextContent'
      })
    } catch (e) {
      if (e instanceof ValidationError) {
        return errorResult(e)
      }
      return errorResult(e)
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
          ...response,
          ok: true
        })
      } catch (e) {
        if (e instanceof ValidationError) {
          return errorResult(e)
        }
        return errorResult(e)
      }
    }
  )
}

export async function startServer() {
  await store.load()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
