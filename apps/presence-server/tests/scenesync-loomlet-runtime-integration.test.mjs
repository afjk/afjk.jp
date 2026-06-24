import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSceneSyncLoomIntegration,
  LOOMLET_RUNTIME_METADATA,
} from '../../../html/assets/js/scenesync/loomlet-runtime-integration.js';

function makeObject() {
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

test('Scene Sync Loomlet integration uses vendored runtime metadata', () => {
  assert.deepEqual(LOOMLET_RUNTIME_METADATA, {
    version: '0.1.2',
    graphVersion: 'scene-sync-graph-json-v1',
    adapter: 'scenesync',
  });
});

test('Scene Sync Loomlet integration runs object-scoped graphs', () => {
  const object = makeObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (id) => id === 'box-1' ? object : null,
    send: () => {},
    getHostTime: () => 2,
    getObjectRuntimeTime: () => 2,
    isObjectBeingEdited: () => false,
  });

  integration.handlePayload({
    type: 'scene-graph-set',
    scope: { object: 'box-1' },
    graph: {
      nodes: [
        { id: 'clock', type: 'clock' },
        { id: 'set', type: 'sceneSetPosition', params: { y: 1, z: 2 } },
      ],
      edges: [{ from: 'clock.t', to: 'set.x' }],
    },
  });
  integration.tickObjectGraphs(null, 2000);

  assert.deepEqual(
    { x: object.position.x, y: object.position.y, z: object.position.z },
    { x: 2, y: 1, z: 2 }
  );
  assert.deepEqual(integration.exportState().objects['box-1'].nodes[1].params, { y: 1, z: 2 });
});

test('Scene Sync Loomlet integration keeps offsetPosition relative to captured base', () => {
  const object = makeObject();
  object.position.set(10, 20, 30);
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (id) => id === 'box-1' ? object : null,
    send: () => {},
    getHostTime: () => 0,
    getObjectRuntimeTime: () => 0,
    isObjectBeingEdited: () => false,
  });

  integration.handlePayload({
    type: 'scene-graph-set',
    scope: { object: 'box-1' },
    graph: {
      nodes: [
        { id: 'move', type: 'sceneOffsetPosition', params: { x: 1, y: 2, z: 3 } },
      ],
      edges: [],
    },
  });

  integration.tickObjectGraphs(null, 0);
  integration.tickObjectGraphs(null, 1000);

  assert.deepEqual(
    { x: object.position.x, y: object.position.y, z: object.position.z },
    { x: 11, y: 22, z: 33 }
  );
});

test('Scene Sync Loomlet integration ignores removed sceneSetAudio graph nodes', () => {
  // scene.setAudio / sceneSetAudio graph nodes are no longer object-target node types.
  // Such a node must not move the object position or throw.
  const object = makeObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (id) => id === 'box-1' ? object : null,
    send: () => {},
    getHostTime: () => 0,
    getObjectRuntimeTime: () => 0,
    isObjectBeingEdited: () => false,
  });

  integration.handlePayload({
    type: 'scene-graph-set',
    scope: { object: 'box-1' },
    graph: {
      nodes: [
        {
          id: 'audio',
          type: 'sceneSetAudio',
          params: { url: 'https://example.com/sound.mp3', playOnAwake: true, loop: true },
        },
      ],
      edges: [],
    },
  });

  assert.doesNotThrow(() => integration.tickObjectGraphs(null, 0));
  assert.deepEqual(
    { x: object.position.x, y: object.position.y, z: object.position.z },
    { x: 0, y: 0, z: 0 }
  );
});

test('Scene Sync Loomlet integration records event evaluations for debug smoke tests', () => {
  const object = makeObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (id) => id === 'box-1' ? object : null,
    send: () => {},
    getHostTime: () => 1,
    getObjectRuntimeTime: () => 1,
    isObjectBeingEdited: () => false,
    getLoomletHostEvents: () => [{
      channel: 'pointer.click',
      eventId: 'click-1',
      target: 'box-1',
    }],
    clearLoomletHostEvents: () => {},
    enableDebug: true,
  });

  integration.handlePayload({
    type: 'scene-graph-set',
    scope: { object: 'box-1' },
    graph: {
      nodes: [
        { id: 'click', type: 'onEvent', params: { channel: 'pointer.click' } },
        { id: 'count', type: 'list.length' },
        { id: 'set', type: 'sceneSetPosition', params: { y: 2, z: 3 } },
      ],
      edges: [
        { from: 'click.event', to: 'count.list' },
        { from: 'count.out', to: 'set.x' },
      ],
    },
  });
  integration.tickObjectGraphs({ t: 1, deltaTime: 1, tick: 4 }, 1000);

  assert.deepEqual(
    { x: object.position.x, y: object.position.y, z: object.position.z },
    { x: 1, y: 2, z: 3 }
  );
  const debug = integration.debugState();
  const records = debug.eventEvaluations['object:box-1'];
  assert.equal(records.length, 1);
  assert.equal(records[0].events[0].eventId, 'click-1');
  assert.equal(records[0].effects[0].type, 'scene.setPosition');
  assert.deepEqual(records[0].effects[0].position, [1, 2, 3]);
});
