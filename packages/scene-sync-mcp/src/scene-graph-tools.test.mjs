import test from 'node:test'
import assert from 'node:assert/strict'
import {
  graphSchema,
  supportedGraphNodeTypes,
  validateGraph
} from './scene-graph-tools.mjs'

test('scene graph tools allow Loomlet pointer event graph nodes', () => {
  assert.ok(supportedGraphNodeTypes.includes('onEvent'))
  assert.ok(supportedGraphNodeTypes.includes('list.length'))
  assert.ok(supportedGraphNodeTypes.includes('list.at'))

  const graph = {
    nodes: [
      { id: 'click', type: 'onEvent', params: { channel: 'pointer.click' } },
      { id: 'count', type: 'list.length' },
      { id: 'set', type: 'sceneSetPosition', params: { y: 1, z: 0 } }
    ],
    edges: [
      { from: 'click.event', to: 'count.list' },
      { from: 'count.out', to: 'set.x' }
    ]
  }

  const parsed = graphSchema.parse(graph)
  assert.deepEqual(parsed, graph)
  assert.equal(validateGraph(parsed), parsed)
})

test('scene graph tools reject unsupported graph node types', () => {
  assert.throws(() => {
    graphSchema.parse({
      nodes: [{ id: 'bad', type: 'pointerClick' }],
      edges: []
    })
  }, /Invalid enum value/)
})

test('scene graph tools validate event graph edge references', () => {
  assert.throws(() => {
    validateGraph({
      nodes: [
        { id: 'click', type: 'onEvent', params: { channel: 'pointer.click' } }
      ],
      edges: [
        { from: 'click.event', to: 'missing.list' }
      ]
    })
  }, /missing destination node/)
})
