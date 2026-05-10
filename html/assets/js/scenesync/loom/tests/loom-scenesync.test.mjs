import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Loom, LoomError } from '../loom.js';
import { LoomSceneSync } from '../loom-scenesync.js';

describe('LoomSceneSync - Graph Validation', () => {
  let adapter;

  function createAdapter() {
    return new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget: (targetId) => ({ position: { set: () => {} } })
    });
  }

  it('should accept cosine in scene-graph-set', () => {
    adapter = createAdapter();

    const msg = {
      type: 'scene-graph-set',
      scope: 'scene',
      graph: {
        nodes: [
          { id: 'c', type: 'cosine', params: { freq: 1, amplitude: 1 } }
        ],
        edges: []
      }
    };

    assert.doesNotThrow(() => {
      adapter.handleMessage(msg);
    }, 'cosine should be allowed in SceneSync graphs');
  });

  it('should accept cosine with sine for circular motion', () => {
    adapter = createAdapter();

    const msg = {
      type: 'scene-graph-set',
      scope: 'scene',
      graph: {
        nodes: [
          { id: 't', type: 'serverClock', params: {} },
          { id: 'x', type: 'cosine', params: { freq: 0.2, amplitude: 2, offset: 0 } },
          { id: 'z', type: 'sine', params: { freq: 0.2, amplitude: 2, offset: 0 } },
          { id: 'set', type: 'sceneSetPosition', params: { target: 'dog-123', y: 0 } }
        ],
        edges: [
          { from: 't.t', to: 'x.t' },
          { from: 't.t', to: 'z.t' },
          { from: 'x.out', to: 'set.x' },
          { from: 'z.out', to: 'set.z' }
        ]
      }
    };

    assert.doesNotThrow(() => {
      adapter.handleMessage(msg);
    }, 'circular motion graph with cosine should be accepted');
  });

  it('should accept cosine in object scope with auto-injected target', () => {
    adapter = createAdapter();

    const msg = {
      type: 'scene-graph-set',
      scope: { object: 'sample-cube' },
      graph: {
        nodes: [
          { id: 't', type: 'serverClock', params: {} },
          { id: 'x', type: 'cosine', params: { freq: 0.2, amplitude: 2, offset: 0 } },
          { id: 'z', type: 'sine', params: { freq: 0.2, amplitude: 2, offset: 0 } },
          { id: 'set', type: 'sceneSetPosition', params: { y: 0.5 } }
        ],
        edges: [
          { from: 't.t', to: 'x.t' },
          { from: 't.t', to: 'z.t' },
          { from: 'x.out', to: 'set.x' },
          { from: 'z.out', to: 'set.z' }
        ]
      }
    };

    assert.doesNotThrow(() => {
      adapter.handleMessage(msg);
    }, 'object scope graph with cosine should be accepted');
  });

  it('should reject unknown node type', () => {
    adapter = createAdapter();

    const msg = {
      type: 'scene-graph-set',
      scope: 'scene',
      graph: {
        nodes: [
          { id: 'unknown', type: 'eval', params: {} }
        ],
        edges: []
      }
    };

    assert.throws(() => {
      adapter.handleMessage(msg);
    }, (err) => err.code === 'DISALLOWED_NODE_TYPE', 'unknown node type should be rejected');
  });

  it('should reject DOM manipulation nodes', () => {
    adapter = createAdapter();

    const msg = {
      type: 'scene-graph-set',
      scope: 'scene',
      graph: {
        nodes: [
          { id: 'setText', type: 'setText', params: { target: '#output' } }
        ],
        edges: []
      }
    };

    assert.throws(() => {
      adapter.handleMessage(msg);
    }, (err) => err.code === 'DISALLOWED_NODE_TYPE', 'setText should be rejected');
  });

  it('should reject input event nodes', () => {
    adapter = createAdapter();

    const msg = {
      type: 'scene-graph-set',
      scope: 'scene',
      graph: {
        nodes: [
          { id: 'click', type: 'pointerClick', params: {} }
        ],
        edges: []
      }
    };

    assert.throws(() => {
      adapter.handleMessage(msg);
    }, (err) => err.code === 'DISALLOWED_NODE_TYPE', 'pointerClick should be rejected');
  });

  it('should accept all Phase 1 allowed node types', () => {
    adapter = createAdapter();

    const allowedTypes = [
      'constant', 'sine', 'cosine', 'add', 'multiply',
      'serverClock', 'sceneSetPosition', 'sceneSetRotation',
      'sceneSetScale', 'sceneSetColor', 'sceneSetVisible'
    ];

    for (const nodeType of allowedTypes) {
      const msg = {
        type: 'scene-graph-set',
        scope: 'scene',
        graph: {
          nodes: [
            { id: 'test', type: nodeType, params: {} }
          ],
          edges: []
        }
      };

      assert.doesNotThrow(() => {
        adapter.handleMessage(msg);
      }, `${nodeType} should be allowed in Phase 1 node set`);
    }
  });

  it('should reject local clock in remote Scene Sync graphs', () => {
    adapter = createAdapter();

    const msg = {
      type: 'scene-graph-set',
      scope: { object: 'sample-cube' },
      graph: {
        nodes: [
          { id: 'clock', type: 'clock', params: {} },
          { id: 'pos', type: 'sceneSetPosition', params: { y: 0.5 } }
        ],
        edges: [
          { from: 'clock.t', to: 'pos.x' }
        ]
      }
    };

    assert.throws(() => {
      adapter.handleMessage(msg);
    }, (err) => err.code === 'DISALLOWED_NODE_TYPE' && err.message.includes('clock'),
    'local clock should be rejected in remote Scene Sync graphs');
  });
});

describe('LoomSceneSync - Object Behavior Graph', () => {
  let adapter;

  function createAdapter() {
    return new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget: (targetId) => ({
        position: { set: () => {} },
        visible: true
      })
    });
  }

  it('should auto-inject target in object scope', () => {
    adapter = createAdapter();

    const msg = {
      type: 'scene-graph-set',
      scope: { object: 'cube-1' },
      graph: {
        nodes: [
          { id: 'const', type: 'constant', params: { value: 1 } },
          { id: 'set', type: 'sceneSetPosition', params: { y: 0 } }
        ],
        edges: [
          { from: 'const.out', to: 'set.x' }
        ]
      }
    };

    assert.doesNotThrow(() => {
      adapter.handleMessage(msg);
    }, 'target should be auto-injected');

    // Verify the graph is stored
    const state = adapter.exportState();
    assert.ok(state.objects['cube-1'], 'object graph should be stored');
  });
});
