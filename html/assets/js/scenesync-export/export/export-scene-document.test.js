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

test('omits empty exported behavior state', () => {
  const doc = createSceneDocumentFromSceneSyncState({
    managedObjects: new Map(),
    behaviorState: {
      scene: null,
      objects: {},
      bases: {
        'scene:box': {
          target: 'box',
          position: { x: 0, y: 0, z: 0 },
        },
      },
    },
  });

  assert.equal(Object.hasOwn(doc, 'behaviors'), false);
});

test('exports only behavior graphs with nodes', () => {
  const sceneGraph = {
    nodes: [{ id: 'time', type: 'time' }],
    edges: [],
  };
  const objectGraph = {
    nodes: [{ id: 'move', type: 'scene.setPosition' }],
    edges: [],
  };

  const doc = createSceneDocumentFromSceneSyncState({
    managedObjects: new Map(),
    behaviorState: {
      scene: sceneGraph,
      objects: {
        empty: { nodes: [], edges: [] },
        box: objectGraph,
      },
    },
  });

  assert.deepEqual(doc.behaviors, {
    scene: sceneGraph,
    objects: {
      box: objectGraph,
    },
  });
});

test('exports provided scene metadata', () => {
  const doc = createSceneDocumentFromSceneSyncState({
    managedObjects: new Map(),
    exportMetadata: {
      title: 'Candy Rock Star',
      description: 'Unity-chan stage',
      tags: 'unity-chan, music, scene-sync',
      author: 'afjk',
    },
  });

  assert.equal(doc.title, 'Candy Rock Star');
  assert.equal(doc.description, 'Unity-chan stage');
  assert.deepEqual(doc.tags, ['unity-chan', 'music', 'scene-sync']);
  assert.equal(doc.author, 'afjk');
});

test('preserves temporary carrier encoding metadata until export collection', () => {
  const managedObjects = new Map([
    ['splat', {
      name: 'Capture',
      visible: true,
      position: vec([0, 0, 0]),
      quaternion: vec([0, 0, 0, 1]),
      scale: vec([1, 1, 1]),
      userData: {
        name: 'Capture',
        meshPath: 'carrier-gzip',
        asset: {
          type: 'mesh',
          source: 'carrier',
          assetId: 'sha256-capture',
          meshPath: 'carrier-gzip',
          size: 225736504,
          carrierEncoding: 'gzip',
          carrierSize: 66581444,
          mime: 'model/gltf-binary',
          originalName: 'capture.glb',
        },
      },
    }],
  ]);

  const doc = createSceneDocumentFromSceneSyncState({ managedObjects });
  assert.equal(doc.objects[0].asset.size, 225736504);
  assert.equal(doc.objects[0].asset.carrierEncoding, 'gzip');
  assert.equal(doc.objects[0].asset.carrierSize, 66581444);
});
