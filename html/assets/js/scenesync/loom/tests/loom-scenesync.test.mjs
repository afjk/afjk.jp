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

describe('LoomSceneSync - exportState / importState with bases', () => {
  function makePositionTracker(objectId, initial) {
    const positions = new Map();
    positions.set(objectId, { ...initial });

    const resolveTarget = (targetId) => {
      const pos = positions.get(targetId);
      if (!pos) return null;
      return {
        position: {
          get x() { return positions.get(targetId).x; },
          get y() { return positions.get(targetId).y; },
          get z() { return positions.get(targetId).z; },
          set(x, y, z) { positions.set(targetId, { x, y, z }); },
          clone() { const p = positions.get(targetId); return { x: p.x, y: p.y, z: p.z }; },
          copy(other) { positions.set(targetId, { x: other.x, y: other.y, z: other.z }); },
        },
      };
    };

    return { positions, resolveTarget };
  }

  it('exportState includes bases when sceneOffsetPosition has run', () => {
    const { positions, resolveTarget } = makePositionTracker('box-1', { x: 0, y: 0.5, z: 0 });

    const adapter = new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget,
    });

    adapter.handleMessage({
      type: 'scene-graph-set',
      scope: { object: 'box-1' },
      graph: {
        nodes: [{ id: 'off', type: 'sceneOffsetPosition', params: { y: 1 } }],
        edges: [],
      },
    });

    // Evaluate to capture base and apply offset
    adapter._objectGraphs.get('box-1').evaluateAt(0);
    assert.strictEqual(positions.get('box-1').y, 1.5, 'offset applied');

    const state = adapter.exportState();
    assert.ok(state.bases, 'bases should be exported');
    const baseEntry = Object.values(state.bases)[0];
    assert.strictEqual(baseEntry.target, 'box-1');
    assert.strictEqual(baseEntry.position.y, 0.5, 'base y should be original pre-behavior value');
  });

  it('exportState has no bases when no sceneOffsetPosition has run', () => {
    const adapter = new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget: () => null,
    });

    adapter.handleMessage({
      type: 'scene-graph-set',
      scope: { object: 'box-1' },
      graph: {
        nodes: [{ id: 'set', type: 'sceneSetPosition', params: { target: 'box-1' } }],
        edges: [],
      },
    });

    const state = adapter.exportState();
    assert.equal('bases' in state, false, 'bases should not be present when no offset behavior ran');
  });

  it('importState with bases restores object to base position and prevents double-apply', () => {
    // Simulate what the viewer sees: object loaded at "moved" export position
    const exportedPos = { x: 0.99, y: 0.5, z: 0 }; // sin(some t) ≈ 0.99
    const { positions, resolveTarget } = makePositionTracker('box-1', { ...exportedPos });

    // Build a behavior state as if exportState() was called mid-animation
    const behaviorState = {
      scene: null,
      objects: {
        'box-1': {
          nodes: [
            { id: 't', type: 'serverClock', params: {} },
            { id: 'sine', type: 'sine', params: { freq: 1, amplitude: 1, phase: 0, offset: 0 } },
            { id: 'set', type: 'sceneOffsetPosition', params: {} },
          ],
          edges: [
            { from: 't.t', to: 'sine.t' },
            { from: 'sine.out', to: 'set.x' },
          ],
        },
      },
      // Original pre-behavior base position
      bases: {
        'object:box-1:box-1': {
          scopeKey: 'object:box-1',
          target: 'box-1',
          position: { x: 0, y: 0.5, z: 0 },
        },
      },
    };

    const adapter = new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget,
    });

    adapter.importState(behaviorState);

    // After importState, object should be at the base position (not the moved exported position)
    assert.strictEqual(positions.get('box-1').x, 0, 'position restored to base x');
    assert.strictEqual(positions.get('box-1').y, 0.5, 'position restored to base y');
    assert.strictEqual(positions.get('box-1').z, 0, 'position restored to base z');

    // Evaluate via evaluateObjectGraphAt so _evaluationContext.time is set for serverClock
    // Evaluate at t=0: sin(0) = 0, so offset x = 0
    adapter.evaluateObjectGraphAt('box-1', 0, { reason: 'test' });
    assert.strictEqual(positions.get('box-1').x, 0, 'at t=0, sin=0, x offset = 0');

    // Evaluate at t=0.25: sin(2π*0.25) = 1
    adapter.evaluateObjectGraphAt('box-1', 0.25, { reason: 'test' });
    const pos = positions.get('box-1');
    assert.ok(Math.abs(pos.x - 1) < 0.001, `at t=0.25, x should be ~1 (got ${pos.x})`);
    assert.strictEqual(pos.y, 0.5, 'y unchanged by x-axis offset behavior');
  });

  it('importState without bases does not crash', () => {
    const adapter = new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget: () => null,
    });

    assert.doesNotThrow(() => {
      adapter.importState({
        scene: null,
        objects: {},
      });
    });
  });

  it('importState with sceneSetPosition (no offset) works without bases', () => {
    const { positions, resolveTarget } = makePositionTracker('box-1', { x: 0, y: 0, z: 0 });

    const adapter = new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => 0,
      resolveTarget,
    });

    adapter.importState({
      scene: null,
      objects: {
        'box-1': {
          nodes: [
            { id: 'cx', type: 'constant', params: { value: 5 } },
            { id: 'set', type: 'sceneSetPosition', params: {} },
          ],
          edges: [{ from: 'cx.out', to: 'set.x' }],
        },
      },
    });

    adapter._objectGraphs.get('box-1').evaluateAt(0);
    assert.strictEqual(positions.get('box-1').x, 5, 'sceneSetPosition sets x to 5');
  });
});
