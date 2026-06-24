import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareLoomletRuntimeScopeKeys,
  createSceneSyncLoomIntegration,
  normalizeLoomletHostEventsForRuntime,
  resolveLoomletRuntimeDeltaTime,
  resolveLoomletRuntimeTick,
} from './loomlet-runtime-integration.js';

test('normalizeLoomletHostEventsForRuntime keeps legacy channel sets compatible', () => {
  const events = normalizeLoomletHostEventsForRuntime(new Set(['object.hover.enter']), {
    target: 'box-1',
    timestamp: 1.25,
  });

  assert.deepEqual(events, [{
    channel: 'object.hover.enter',
    type: 'object.hover.enter',
    target: 'box-1',
    timestamp: 1.25,
    time: 1.25,
    objectId: 'box-1',
  }]);
});

test('normalizeLoomletHostEventsForRuntime preserves synchronized scene event fields', () => {
  const events = normalizeLoomletHostEventsForRuntime([{
    channel: 'pointer.click',
    eventId: 'drag-1:event:000002',
    eventRevision: 2,
    applyTick: 18,
    target: 'box-1',
    timestamp: 2,
    payload: { pointerId: 5, clientX: 10, clientY: 20 },
  }], {
    target: 'box-1',
    timestamp: 1,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].channel, 'pointer.click');
  assert.equal(events[0].type, 'pointer.click');
  assert.equal(events[0].target, 'box-1');
  assert.equal(events[0].objectId, 'box-1');
  assert.equal(events[0].timestamp, 2);
  assert.equal(events[0].eventId, 'drag-1:event:000002');
  assert.equal(events[0].applyTick, 18);
  assert.deepEqual(events[0].payload, { pointerId: 5, clientX: 10, clientY: 20 });
});

test('normalizeLoomletHostEventsForRuntime sorts events in canonical replay order', () => {
  const events = normalizeLoomletHostEventsForRuntime([
    { channel: 'pointer.drag.end', eventId: 'c', applyTick: 2, eventRevision: 1, sequence: 0, timestamp: 2 },
    { channel: 'pointer.click', eventId: 'b', applyTick: 1, eventRevision: 2, sequence: 0, timestamp: 1 },
    { channel: 'pointer.drag.start', eventId: 'a', applyTick: 1, eventRevision: 1, sequence: 0, timestamp: 1 },
  ], {
    target: 'box-1',
    timestamp: 0,
  });

  assert.deepEqual(events.map(event => event.eventId), ['a', 'b', 'c']);
});

test('resolveLoomletRuntimeDeltaTime and tick prefer deterministic clock fields', () => {
  assert.equal(resolveLoomletRuntimeDeltaTime({ deltaTime: 1 / 60, delta: 9 }), 1 / 60);
  assert.equal(resolveLoomletRuntimeDeltaTime({ delta: 0.25 }), 0.25);
  assert.equal(resolveLoomletRuntimeDeltaTime({}, 0.5), 0.5);
  assert.equal(resolveLoomletRuntimeTick({ tick: 12.9 }), 12);
  assert.equal(resolveLoomletRuntimeTick({}), undefined);
});

test('compareLoomletRuntimeScopeKeys evaluates scene before object scopes', () => {
  const keys = ['object:z', 'scene', 'object:a'].sort(compareLoomletRuntimeScopeKeys);
  assert.deepEqual(keys, ['scene', 'object:a', 'object:z']);
});

function createPositionObject() {
  return {
    position: {
      x: 0,
      y: 0,
      z: 0,
      set(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    },
  };
}

test('Loomlet integration passes explicit deltaTime instead of frame timestamp delta', () => {
  const object = createPositionObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (objectId) => (objectId === 'box-1' ? object : null),
  });
  const graph = {
    nodes: [
      { id: 'speed', type: 'constant', params: { value: 2 } },
      { id: 'integrator', type: 'integrate', params: { initial: 0 } },
      { id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', y: 0, z: 0 } },
    ],
    edges: [
      { from: 'speed.out', to: 'integrator.value' },
      { from: 'integrator.out', to: 'move.x' },
    ],
  };

  integration.handlePayload({ type: 'scene-graph-set', scope: { object: 'box-1' }, graph });
  integration.tickObjectGraphs({ t: 0, deltaTime: 0.25 }, 1000);
  assert.equal(object.position.x, 0.5);
  integration.tickObjectGraphs({ t: 0.25, deltaTime: 0.25 }, 1_000_000);
  assert.equal(object.position.x, 1);
});

test('Loomlet integration evaluates scopes in deterministic key order', () => {
  const object = createPositionObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (objectId) => (objectId === 'box-1' ? object : null),
  });
  const sceneGraph = {
    nodes: [{ id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', x: 2, y: 0, z: 0 } }],
    edges: [],
  };
  const objectGraph = {
    nodes: [{ id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', x: 1, y: 0, z: 0 } }],
    edges: [],
  };

  integration.handlePayload({ type: 'scene-graph-set', scope: { object: 'box-1' }, graph: objectGraph });
  integration.handlePayload({ type: 'scene-graph-set', scope: 'scene', graph: sceneGraph });
  integration.tickObjectGraphs({ t: 0, deltaTime: 0 }, 0);

  assert.equal(object.position.x, 1);
});
