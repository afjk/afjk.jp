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
      'serverClock', 'sceneSetPosition', 'sceneOffsetPosition', 'sceneSetRotation',
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

describe('LoomSceneSync - sceneOffsetPosition', () => {
  it('should accept sceneOffsetPosition in object scope', () => {
    const adapter = new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget: (targetId) => ({
        position: { set: () => {}, clone: () => ({ x: 3, y: 1, z: -2 }) }
      })
    });

    const msg = {
      type: 'scene-graph-set',
      scope: { object: 'sample-cube' },
      graph: {
        nodes: [
          { id: 'offset', type: 'sceneOffsetPosition', params: { y: 0.5 } }
        ],
        edges: []
      }
    };

    assert.doesNotThrow(() => {
      adapter.handleMessage(msg);
    }, 'sceneOffsetPosition should be accepted');
  });

  it('should apply offset to base position on evaluate', () => {
    const positions = new Map();
    positions.set('sample-cube', { x: 3, y: 1, z: -2 });

    const adapter = new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget: (targetId) => {
        const pos = positions.get(targetId);
        return {
          position: {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            set: function(x, y, z) {
              this.x = x;
              this.y = y;
              this.z = z;
              positions.set(targetId, { x, y, z });
            },
            clone: function() {
              return { x: this.x, y: this.y, z: this.z };
            }
          }
        };
      }
    });

    const msg = {
      type: 'scene-graph-set',
      scope: { object: 'sample-cube' },
      graph: {
        nodes: [
          { id: 'offset', type: 'sceneOffsetPosition', params: { y: 0.5 } }
        ],
        edges: []
      }
    };

    adapter.handleMessage(msg);

    // Let the graph evaluate at time 0
    adapter._objectGraphs.get('sample-cube').evaluateAt(0);

    const finalPos = positions.get('sample-cube');
    assert.strictEqual(finalPos.x, 3, 'x should remain unchanged');
    assert.strictEqual(finalPos.y, 1.5, 'y should be offset from base (1 + 0.5)');
    assert.strictEqual(finalPos.z, -2, 'z should remain unchanged');
  });

  it('should restore base position on clear', () => {
    const positions = new Map();
    positions.set('sample-cube', { x: 3, y: 1, z: -2 });

    const adapter = new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget: (targetId) => {
        const pos = positions.get(targetId);
        return {
          position: {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            set: function(x, y, z) {
              this.x = x;
              this.y = y;
              this.z = z;
              positions.set(targetId, { x, y, z });
            },
            clone: function() {
              return { x: this.x, y: this.y, z: this.z };
            },
            copy: function(other) {
              this.x = other.x;
              this.y = other.y;
              this.z = other.z;
              positions.set(targetId, { x: this.x, y: this.y, z: this.z });
            }
          }
        };
      }
    });

    const msg = {
      type: 'scene-graph-set',
      scope: { object: 'sample-cube' },
      graph: {
        nodes: [
          { id: 'offset', type: 'sceneOffsetPosition', params: { y: 0.5 } }
        ],
        edges: []
      }
    };

    adapter.handleMessage(msg);

    // Evaluate to apply offset
    adapter._objectGraphs.get('sample-cube').evaluateAt(0);
    let pos = positions.get('sample-cube');
    assert.strictEqual(pos.y, 1.5, 'offset should be applied before clear');

    // Clear the graph
    const clearMsg = {
      type: 'scene-graph-clear',
      scope: { object: 'sample-cube' }
    };
    adapter.handleMessage(clearMsg);

    // Verify position is restored
    pos = positions.get('sample-cube');
    assert.strictEqual(pos.x, 3, 'x should be restored');
    assert.strictEqual(pos.y, 1, 'y should be restored to base position (1)');
    assert.strictEqual(pos.z, -2, 'z should be restored');
  });

  it('should restore base position on graph replace', () => {
    const positions = new Map();
    positions.set('sample-cube', { x: 3, y: 1, z: -2 });

    const adapter = new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget: (targetId) => {
        const pos = positions.get(targetId);
        return {
          position: {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            set: function(x, y, z) {
              this.x = x;
              this.y = y;
              this.z = z;
              positions.set(targetId, { x, y, z });
            },
            clone: function() {
              return { x: this.x, y: this.y, z: this.z };
            },
            copy: function(other) {
              this.x = other.x;
              this.y = other.y;
              this.z = other.z;
              positions.set(targetId, { x: this.x, y: this.y, z: this.z });
            }
          }
        };
      }
    });

    // Apply graph A with y offset 0.5
    adapter.handleMessage({
      type: 'scene-graph-set',
      scope: { object: 'sample-cube' },
      graph: {
        nodes: [
          { id: 'offset', type: 'sceneOffsetPosition', params: { y: 0.5 } }
        ],
        edges: []
      }
    });
    adapter._objectGraphs.get('sample-cube').evaluateAt(0);

    let pos = positions.get('sample-cube');
    assert.strictEqual(pos.y, 1.5, 'graph A: y offset 0.5 applied');

    // Replace with graph B with y offset 1.0
    adapter.handleMessage({
      type: 'scene-graph-set',
      scope: { object: 'sample-cube' },
      graph: {
        nodes: [
          { id: 'offset', type: 'sceneOffsetPosition', params: { y: 1.0 } }
        ],
        edges: []
      }
    });
    adapter._objectGraphs.get('sample-cube').evaluateAt(0);

    pos = positions.get('sample-cube');
    assert.strictEqual(pos.y, 2, 'graph B: should use restored base (1) + 1.0 = 2, NOT (1.5 + 1.0 = 2.5)');
    assert.strictEqual(pos.x, 3, 'x should remain 3');
    assert.strictEqual(pos.z, -2, 'z should remain -2');
  });

  it('should work with scene scope and explicit target', () => {
    const positions = new Map();
    positions.set('sample-cube', { x: 3, y: 1, z: -2 });

    const adapter = new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget: (targetId) => {
        const pos = positions.get(targetId);
        return {
          position: {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            set: function(x, y, z) {
              this.x = x;
              this.y = y;
              this.z = z;
              positions.set(targetId, { x, y, z });
            },
            clone: function() {
              return { x: this.x, y: this.y, z: this.z };
            }
          }
        };
      }
    });

    const msg = {
      type: 'scene-graph-set',
      scope: 'scene',
      graph: {
        nodes: [
          { id: 'offset', type: 'sceneOffsetPosition', params: { target: 'sample-cube', x: 1 } }
        ],
        edges: []
      }
    };

    adapter.handleMessage(msg);

    // Let the graph evaluate
    adapter._sceneGraph.evaluateAt(0);

    const finalPos = positions.get('sample-cube');
    assert.strictEqual(finalPos.x, 4, 'x should be offset from base (3 + 1)');
    assert.strictEqual(finalPos.y, 1, 'y should remain unchanged');
    assert.strictEqual(finalPos.z, -2, 'z should remain unchanged');
  });

  it('should restore scene scope offset on clear', () => {
    const positions = new Map();
    positions.set('sample-cube', { x: 3, y: 1, z: -2 });

    const adapter = new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget: (targetId) => {
        const pos = positions.get(targetId);
        return {
          position: {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            set: function(x, y, z) {
              this.x = x;
              this.y = y;
              this.z = z;
              positions.set(targetId, { x, y, z });
            },
            clone: function() {
              return { x: this.x, y: this.y, z: this.z };
            },
            copy: function(other) {
              this.x = other.x;
              this.y = other.y;
              this.z = other.z;
              positions.set(targetId, { x: this.x, y: this.y, z: this.z });
            }
          }
        };
      }
    });

    const msg = {
      type: 'scene-graph-set',
      scope: 'scene',
      graph: {
        nodes: [
          { id: 'offset', type: 'sceneOffsetPosition', params: { target: 'sample-cube', x: 1 } }
        ],
        edges: []
      }
    };

    adapter.handleMessage(msg);

    // Evaluate to apply offset
    adapter._sceneGraph.evaluateAt(0);
    let pos = positions.get('sample-cube');
    assert.strictEqual(pos.x, 4, 'offset should be applied before clear (3 + 1)');

    // Clear the scene graph
    const clearMsg = {
      type: 'scene-graph-clear',
      scope: 'scene'
    };
    adapter.handleMessage(clearMsg);

    // Verify position is restored
    pos = positions.get('sample-cube');
    assert.strictEqual(pos.x, 3, 'x should be restored to base position (3)');
    assert.strictEqual(pos.y, 1, 'y should remain unchanged');
    assert.strictEqual(pos.z, -2, 'z should remain unchanged');
  });
});
