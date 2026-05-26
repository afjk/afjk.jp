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

test('Scene Sync Loomlet integration runs object-scoped legacy graphs', () => {
  const object = makeObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (id) => id === 'box-1' ? object : null,
    send: () => {},
    getServerTime: () => 2,
    getObjectRuntimeTime: () => 2,
    isObjectBeingEdited: () => false,
  });

  integration.handlePayload({
    type: 'scene-graph-set',
    scope: { object: 'box-1' },
    graph: {
      nodes: [
        { id: 'clock', type: 'serverClock' },
        { id: 'set', type: 'sceneSetPosition', params: { y: 1, z: 2 } },
      ],
      edges: [{ from: 'clock.t', to: 'set.x' }],
    },
  });
  integration.tickObjectGraphs(2000);

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
    getServerTime: () => 0,
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

  integration.tickObjectGraphs(0);
  integration.tickObjectGraphs(1000);

  assert.deepEqual(
    { x: object.position.x, y: object.position.y, z: object.position.z },
    { x: 11, y: 22, z: 33 }
  );
});
