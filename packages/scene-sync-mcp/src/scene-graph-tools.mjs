import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { SceneSyncClient } from './scene-sync-client.mjs'
import { SessionStore } from './session-store.mjs'
import { ValidationError, assertLinked, assertObjectId } from './validators.mjs'
import { jsonResult, errorResult } from './tool-results.mjs'

const client = new SceneSyncClient()
const store = new SessionStore()

const GRAPH_TOOL_PATCHED = Symbol.for('scene-sync-mcp.scene-graph-tools.patched')
const GRAPH_TOOLS_REGISTERED = Symbol.for('scene-sync-mcp.scene-graph-tools.registered')

export const supportedGraphNodeTypes = [
  'clock',
  'sine',
  'cosine',
  'add',
  'multiply',
  'constant',
  'onEvent',
  'list.length',
  'list.at',
  'sceneSetPosition',
  'sceneOffsetPosition',
  'sceneSetRotation',
  'sceneSetScale',
  'sceneSetColor',
  'sceneSetVisible'
]

const graphNodeSchema = z.object({
  id: z.string().min(1).describe('Unique node ID within this graph'),
  type: z.enum(supportedGraphNodeTypes).describe('Scene Sync graph node type'),
  params: z.record(z.unknown()).optional().describe('Node parameters')
}).passthrough()

const graphEdgeSchema = z.object({
  from: z.string().min(1).describe('Source endpoint, for example "clock.t"'),
  to: z.string().min(1).describe('Destination endpoint, for example "sine.t"')
}).passthrough()

export const graphSchema = z.object({
  nodes: z.array(graphNodeSchema).max(100).describe('Scene Sync graph nodes'),
  edges: z.array(graphEdgeSchema).max(300).describe('Scene Sync graph edges')
}).passthrough()

function endpointNodeId(endpoint) {
  const index = endpoint.indexOf('.')
  return index === -1 ? endpoint : endpoint.slice(0, index)
}

export function validateGraph(graph) {
  if (!graph || typeof graph !== 'object') {
    throw new ValidationError('graph must be an object with nodes and edges arrays.')
  }

  const ids = new Set()

  for (const node of graph.nodes || []) {
    if (ids.has(node.id)) {
      throw new ValidationError(`Duplicate graph node id: ${node.id}`)
    }
    ids.add(node.id)
  }

  for (const edge of graph.edges || []) {
    const fromId = endpointNodeId(edge.from)
    const toId = endpointNodeId(edge.to)
    if (!ids.has(fromId)) {
      throw new ValidationError(`Graph edge references missing source node: ${edge.from}`)
    }
    if (!ids.has(toId)) {
      throw new ValidationError(`Graph edge references missing destination node: ${edge.to}`)
    }
  }

  return graph
}

async function getSession() {
  await store.load()
  const session = store.get()
  assertLinked(session)
  return session
}

async function broadcastGraphPayload(payload, { dryRun = false } = {}) {
  if (dryRun) {
    return jsonResult({
      ok: true,
      dryRun: true,
      payload
    })
  }

  const session = await getSession()
  const response = await client.broadcast(session.roomId, session.sessionId, payload)

  return jsonResult({
    ...response,
    ok: true,
    dryRun: false,
    payload
  })
}

function registerSceneGraphTools(server) {
  if (server[GRAPH_TOOLS_REGISTERED]) return

  Object.defineProperty(server, GRAPH_TOOLS_REGISTERED, {
    value: true,
    enumerable: false
  })

  server.registerTool(
    'scene_sync_set_object_graph',
    {
      title: 'Set an object behavior graph',
      description: 'Set a Scene Sync behavior graph for a single object. This accepts Scene Sync graph JSON, not Loomlet DSL. Use this for persistent object behavior such as bouncing, spinning, pulsing, or procedural motion.',
      inputSchema: z.object({
        objectId: z.string().min(1).describe('Target Scene Sync object ID'),
        graph: graphSchema.describe('Scene Sync graph JSON'),
        dryRun: z.boolean().optional().describe('If true, return the payload without broadcasting it')
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ objectId, graph, dryRun }) => {
      try {
        assertObjectId(objectId)
        validateGraph(graph)

        const payload = {
          type: 'scene-graph-set',
          scope: { object: objectId },
          graph
        }

        return await broadcastGraphPayload(payload, { dryRun })
      } catch (e) {
        return errorResult(e)
      }
    }
  )

  server.registerTool(
    'scene_sync_clear_object_graph',
    {
      title: 'Clear an object behavior graph',
      description: 'Clear the Scene Sync behavior graph for a single object. Use this to stop an object behavior such as bouncing or spinning.',
      inputSchema: z.object({
        objectId: z.string().min(1).describe('Target Scene Sync object ID'),
        dryRun: z.boolean().optional().describe('If true, return the payload without broadcasting it')
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ objectId, dryRun }) => {
      try {
        assertObjectId(objectId)

        const payload = {
          type: 'scene-graph-clear',
          scope: { object: objectId }
        }

        return await broadcastGraphPayload(payload, { dryRun })
      } catch (e) {
        return errorResult(e)
      }
    }
  )

  server.registerTool(
    'scene_sync_set_scene_graph',
    {
      title: 'Set the scene behavior graph',
      description: 'Set the room-level Scene Sync behavior graph. This accepts Scene Sync graph JSON, not Loomlet DSL. Prefer object graph tools for object-specific behavior.',
      inputSchema: z.object({
        graph: graphSchema.describe('Scene Sync graph JSON'),
        dryRun: z.boolean().optional().describe('If true, return the payload without broadcasting it')
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ graph, dryRun }) => {
      try {
        validateGraph(graph)

        const payload = {
          type: 'scene-graph-set',
          scope: 'scene',
          graph
        }

        return await broadcastGraphPayload(payload, { dryRun })
      } catch (e) {
        return errorResult(e)
      }
    }
  )

  server.registerTool(
    'scene_sync_clear_scene_graph',
    {
      title: 'Clear the scene behavior graph',
      description: 'Clear the room-level Scene Sync behavior graph.',
      inputSchema: z.object({
        dryRun: z.boolean().optional().describe('If true, return the payload without broadcasting it')
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ dryRun }) => {
      try {
        const payload = {
          type: 'scene-graph-clear',
          scope: 'scene'
        }

        return await broadcastGraphPayload(payload, { dryRun })
      } catch (e) {
        return errorResult(e)
      }
    }
  )
}

export function installSceneGraphToolPatch() {
  if (McpServer.prototype[GRAPH_TOOL_PATCHED]) return

  const originalConnect = McpServer.prototype.connect

  Object.defineProperty(McpServer.prototype, GRAPH_TOOL_PATCHED, {
    value: true,
    enumerable: false
  })

  McpServer.prototype.connect = async function patchedConnect(...args) {
    registerSceneGraphTools(this)
    return originalConnect.apply(this, args)
  }
}

installSceneGraphToolPatch()
