import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneDocumentFromSceneSyncState } from './export-scene-document.js';

function vec(values) {
  return { toArray: () => [...values] };
}

test('exports scene and object physics state', () => {
  const managedObjects = new Map([
    ['ball', {
      name: 'Ball',
      visible: true,
      position: vec([0, 2, 0]),
      quaternion: vec([0, 0, 0, 1]),
      scale: vec([1, 1, 1]),
      userData: {
        name: 'Ball',
        asset: {
          type: 'primitive',
          primitive: 'sphere',
          color: '#44aaff',
        },
        physics: {
          enabled: true,
          bodyType: 'dynamic',
          shape: 'sphere',
          mass: 1,
          restitution: 0.4,
          friction: 0.5,
          velocity: [0, 0, 0],
        },
      },
    }],
  ]);

  const physicsState = {
    version: 1,
    enabled: true,
    duration: 4,
    worldOptions: {
      gravity: -9.81,
      ground: null,
      timestep: 1 / 60,
    },
  };

  const doc = createSceneDocumentFromSceneSyncState({
    managedObjects,
    physicsState,
  });

  assert.deepEqual(doc.physics, physicsState);
  assert.equal(doc.objects.length, 1);
  assert.deepEqual(doc.objects[0].physics, managedObjects.get('ball').userData.physics);
});
