#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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
const server = new Server({
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

// scene_sync_redeem
server.tool('scene_sync_redeem', {
  description: 'Redeem a 6-digit Scene Sync AI pairing code. Call this after the user opens Scene Sync, presses "AIにリンク", and provides the code.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: '6-digit code from Scene Sync'
      }
    },
    required: ['code']
  }
}, async (request) => {
  try {
    const code = request.params.arguments.code
    assertCode(code)

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
})

// scene_sync_status
server.tool('scene_sync_status', {
  description: 'Get the current Scene Sync link status.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
}, async (request) => {
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
})

// scene_sync_get_scene
server.tool('scene_sync_get_scene', {
  description: 'Get the current scene state. Returns object list and environment settings. May take up to 5 seconds.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
}, async (request) => {
  try {
    const session = getSession()
    const response = await client.getScene(session.roomId, session.sessionId)

    // If objects array is very large, summarize it
    let result = response
    if (response.objects && Array.isArray(response.objects) && response.objects.length > 50) {
      result = {
        ...response,
        objectCount: response.objects.length,
        objectIds: response.objects.map(o => o.id || o.objectId).slice(0, 50),
        _note: `Showing first 50 of ${response.objects.length} objects`
      }
    }

    return jsonResult({
      ok: true,
      ...result
    })
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResult(e.message)
    }
    return errorResult(formatApiError(e))
  }
})

// scene_sync_add_primitive
server.tool('scene_sync_add_primitive', {
  description: 'Add a primitive object to the scene. Internal tool; use add_box/add_sphere instead.',
  inputSchema: {
    type: 'object',
    properties: {
      primitive: {
        type: 'string',
        enum: ['box', 'sphere', 'cylinder', 'plane'],
        description: 'Shape type'
      },
      objectId: {
        type: 'string',
        description: 'Unique object ID (auto-generated if omitted)'
      },
      name: {
        type: 'string',
        description: 'Display name (auto-generated if omitted)'
      },
      position: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y, z] position in meters'
      },
      rotation: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y, z, w] quaternion'
      },
      scale: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y, z] scale'
      },
      color: {
        type: 'string',
        description: '#RRGGBB or #RGB color'
      }
    },
    required: ['primitive']
  }
}, async (request) => {
  try {
    const session = getSession()
    const args = request.params.arguments

    const primitive = normalizePrimitive(args.primitive)
    const objectId = args.objectId || makeObjectId(`ai-${primitive}`)
    const name = normalizeName(args.name, primitiveToName(primitive))
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
        primitive,
        color
      }
    }

    const response = await client.broadcast(session.roomId, session.sessionId, payload)

    return successResult({
      room: response.room || session.roomId,
      objectId,
      primitive,
      userPresent: response.userPresent !== false
    })
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResult(e.message)
    }
    return errorResult(formatApiError(e))
  }
})

// scene_sync_add_box
server.tool('scene_sync_add_box', {
  description: 'Add a box to the scene. Use directly for clear requests like "add a red cube".',
  inputSchema: {
    type: 'object',
    properties: {
      objectId: {
        type: 'string',
        description: 'Unique object ID (auto-generated if omitted)'
      },
      name: {
        type: 'string',
        description: 'Display name (auto-generated if omitted)'
      },
      position: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y, z] position'
      },
      rotation: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y, z, w] quaternion'
      },
      scale: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y, z] scale'
      },
      color: {
        type: 'string',
        description: '#RRGGBB or #RGB color'
      }
    }
  }
}, async (request) => {
  const args = request.params.arguments
  return server.callTool('scene_sync_add_primitive', {
    ...args,
    primitive: 'box'
  })
})

// scene_sync_add_sphere
server.tool('scene_sync_add_sphere', {
  description: 'Add a sphere to the scene.',
  inputSchema: {
    type: 'object',
    properties: {
      objectId: {
        type: 'string',
        description: 'Unique object ID (auto-generated if omitted)'
      },
      name: {
        type: 'string',
        description: 'Display name (auto-generated if omitted)'
      },
      position: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y, z] position'
      },
      rotation: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y, z, w] quaternion'
      },
      scale: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y, z] scale'
      },
      color: {
        type: 'string',
        description: '#RRGGBB or #RGB color'
      }
    }
  }
}, async (request) => {
  const args = request.params.arguments
  return server.callTool('scene_sync_add_primitive', {
    ...args,
    primitive: 'sphere'
  })
})

// scene_sync_move_object
server.tool('scene_sync_move_object', {
  description: 'Move an object to a new position.',
  inputSchema: {
    type: 'object',
    properties: {
      objectId: {
        type: 'string',
        description: 'Target object ID'
      },
      position: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y, z] new position'
      }
    },
    required: ['objectId', 'position']
  }
}, async (request) => {
  try {
    const session = getSession()
    const args = request.params.arguments

    assertObjectId(args.objectId)
    const position = normalizeVec3(args.position)

    const payload = {
      kind: 'scene-delta',
      objectId: args.objectId,
      position
    }

    const response = await client.broadcast(session.roomId, session.sessionId, payload)

    return successResult({
      objectId: args.objectId,
      position
    })
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResult(e.message)
    }
    return errorResult(formatApiError(e))
  }
})

// scene_sync_rotate_object
server.tool('scene_sync_rotate_object', {
  description: 'Rotate an object.',
  inputSchema: {
    type: 'object',
    properties: {
      objectId: {
        type: 'string',
        description: 'Target object ID'
      },
      rotation: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y, z, w] quaternion'
      }
    },
    required: ['objectId', 'rotation']
  }
}, async (request) => {
  try {
    const session = getSession()
    const args = request.params.arguments

    assertObjectId(args.objectId)
    const rotation = normalizeQuat(args.rotation)

    const payload = {
      kind: 'scene-delta',
      objectId: args.objectId,
      rotation
    }

    await client.broadcast(session.roomId, session.sessionId, payload)

    return successResult({
      objectId: args.objectId,
      rotation
    })
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResult(e.message)
    }
    return errorResult(formatApiError(e))
  }
})

// scene_sync_scale_object
server.tool('scene_sync_scale_object', {
  description: 'Scale an object.',
  inputSchema: {
    type: 'object',
    properties: {
      objectId: {
        type: 'string',
        description: 'Target object ID'
      },
      scale: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y, z] scale'
      }
    },
    required: ['objectId', 'scale']
  }
}, async (request) => {
  try {
    const session = getSession()
    const args = request.params.arguments

    assertObjectId(args.objectId)
    const scale = normalizeScale(args.scale)

    const payload = {
      kind: 'scene-delta',
      objectId: args.objectId,
      scale
    }

    await client.broadcast(session.roomId, session.sessionId, payload)

    return successResult({
      objectId: args.objectId,
      scale
    })
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResult(e.message)
    }
    return errorResult(formatApiError(e))
  }
})

// scene_sync_set_color
server.tool('scene_sync_set_color', {
  description: 'Change the color of a primitive object.',
  inputSchema: {
    type: 'object',
    properties: {
      objectId: {
        type: 'string',
        description: 'Target object ID'
      },
      color: {
        type: 'string',
        description: '#RRGGBB or #RGB color'
      },
      primitive: {
        type: 'string',
        enum: ['box', 'sphere', 'cylinder', 'plane', 'cone', 'torus'],
        description: 'Primitive type (defaults to box if unknown)'
      }
    },
    required: ['objectId', 'color']
  }
}, async (request) => {
  try {
    const session = getSession()
    const args = request.params.arguments

    assertObjectId(args.objectId)
    const color = normalizeColor(args.color)
    const primitive = args.primitive || 'box'

    const payload = {
      kind: 'scene-delta',
      objectId: args.objectId,
      asset: {
        type: 'primitive',
        primitive,
        color
      }
    }

    await client.broadcast(session.roomId, session.sessionId, payload)

    return successResult({
      objectId: args.objectId,
      color
    })
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResult(e.message)
    }
    return errorResult(formatApiError(e))
  }
})

// scene_sync_focus_object
server.tool('scene_sync_focus_object', {
  description: 'Focus the camera on an object. Requires objectId.',
  inputSchema: {
    type: 'object',
    properties: {
      objectId: {
        type: 'string',
        description: 'Target object ID (required)'
      }
    },
    required: ['objectId']
  }
}, async (request) => {
  try {
    const session = getSession()
    const args = request.params.arguments

    assertObjectId(args.objectId)

    const response = await client.aiCommand(session.roomId, session.sessionId, 'focusObject', {
      objectId: args.objectId
    })

    return jsonResult({
      ok: true,
      objectId: args.objectId,
      action: 'focusObject'
    })
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResult(e.message)
    }
    return errorResult(formatApiError(e))
  }
})

// scene_sync_screenshot
server.tool('scene_sync_screenshot', {
  description: 'Request a screenshot from the browser. May take a few seconds.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
}, async (request) => {
  try {
    const session = getSession()

    const response = await client.aiCommand(session.roomId, session.sessionId, 'screenshot', {}, {
      timeout: 10000
    })

    // If response has a large data URL, just mention it rather than returning it
    const hasImage = response.result || response.dataUrl || response.image
    if (hasImage && typeof hasImage === 'string' && hasImage.length > 1000) {
      return jsonResult({
        ok: true,
        screenshot: true,
        note: 'Screenshot captured (data URL too large to display in response)'
      })
    }

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
})

// scene_sync_revoke
server.tool('scene_sync_revoke', {
  description: 'Revoke the current Scene Sync link.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
}, async (request) => {
  try {
    const session = store.get()
    if (session.sessionId) {
      try {
        await client.revoke(session.sessionId)
      } catch (e) {
        // API error on revoke is not critical; clear session anyway
        console.error('Revoke API error:', e.message)
      }
    }

    await store.clear()

    return successResult({
      message: 'Scene Sync link revoked.'
    })
  } catch (e) {
    return errorResult(e.message)
  }
})

// Optional raw broadcast tool
if (process.env.SCENE_SYNC_ENABLE_RAW_TOOLS === 'true') {
  server.tool('scene_sync_raw_broadcast', {
    description: 'Raw broadcast tool (developer only). Send any payload to /broadcast. Unsafe - disabled by default.',
    inputSchema: {
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          description: 'Raw broadcast payload'
        }
      },
      required: ['payload']
    }
  }, async (request) => {
    try {
      const session = getSession()
      const payload = request.params.arguments.payload

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
  })
}

// Connect stdio transport
const transport = new StdioServerTransport()
await server.connect(transport)
