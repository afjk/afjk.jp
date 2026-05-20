import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSceneDocumentFromSceneSyncState,
} from '../../../html/assets/js/scenesync-export/export/export-scene-document.js';
import { SCENE_DOCUMENT_FORMAT, SCENE_DOCUMENT_VERSION, isValidSceneDocument } from '../../../html/assets/js/scenesync-export/viewer/scene-document.js';

// Minimal THREE.js-like mock object
function makeMockObject(objectId, overrides = {}) {
  return {
    userData: {
      objectId,
      name: overrides.name || objectId,
      asset: overrides.asset || null,
      meshPath: overrides.meshPath || null,
      animationState: overrides.animationState || null,
      role: overrides.role || undefined,
      nonSerializable: overrides.nonSerializable || false,
      _temporary: overrides._temporary || false,
    },
    position: { toArray: () => overrides.position || [0, 0, 0] },
    quaternion: { toArray: () => overrides.rotation || [0, 0, 0, 1] },
    scale: { toArray: () => overrides.scale || [1, 1, 1] },
    visible: overrides.visible !== undefined ? overrides.visible : true,
    name: overrides.name || objectId,
  };
}

test('createSceneDocumentFromSceneSyncState', async (t) => {
  await t.test('produces valid SceneDocument format', () => {
    const managedObjects = new Map();
    managedObjects.set('box-1', makeMockObject('box-1', {
      asset: { type: 'primitive', primitive: 'box', color: '#ff0000' },
    }));

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: null,
      envId: null,
    });

    assert.equal(doc.format, SCENE_DOCUMENT_FORMAT);
    assert.equal(doc.version, SCENE_DOCUMENT_VERSION);
    assert.ok(Array.isArray(doc.objects));
    assert.ok(isValidSceneDocument(doc));
  });

  await t.test('includes object id, name, transform, visible, asset', () => {
    const managedObjects = new Map();
    managedObjects.set('sphere-1', makeMockObject('sphere-1', {
      name: 'My Sphere',
      asset: { type: 'primitive', primitive: 'sphere', color: '#00ff00' },
      position: [1, 2, 3],
      rotation: [0, 0.707, 0, 0.707],
      scale: [2, 2, 2],
      visible: true,
    }));

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: null,
      envId: null,
    });

    const obj = doc.objects.find(o => o.id === 'sphere-1');
    assert.ok(obj, 'object should be in output');
    assert.equal(obj.name, 'My Sphere');
    assert.deepEqual(obj.position, [1, 2, 3]);
    assert.deepEqual(obj.rotation, [0, 0.707, 0, 0.707]);
    assert.deepEqual(obj.scale, [2, 2, 2]);
    assert.equal(obj.visible, true);
    assert.equal(obj.asset.type, 'primitive');
    assert.equal(obj.asset.primitive, 'sphere');
  });

  await t.test('includes animation state when present', () => {
    const managedObjects = new Map();
    managedObjects.set('model-1', makeMockObject('model-1', {
      asset: { type: 'mesh', meshPath: 'abc123' },
      animationState: { enabled: true, clip: 1, mode: 'loop', speed: 1.5 },
    }));

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: null,
      envId: null,
    });

    const obj = doc.objects.find(o => o.id === 'model-1');
    assert.ok(obj?.animation, 'animation state should be present');
    assert.equal(obj.animation.enabled, true);
    assert.equal(obj.animation.clip, 1);
    assert.equal(obj.animation.speed, 1.5);
  });

  await t.test('excludes nonSerializable objects', () => {
    const managedObjects = new Map();
    managedObjects.set('skip-me', makeMockObject('skip-me', { nonSerializable: true }));
    managedObjects.set('keep-me', makeMockObject('keep-me', {
      asset: { type: 'primitive', primitive: 'box', color: '#fff' },
    }));

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: null,
      envId: null,
    });

    assert.equal(doc.objects.some(o => o.id === 'skip-me'), false);
    assert.equal(doc.objects.some(o => o.id === 'keep-me'), true);
  });

  await t.test('excludes _temporary objects', () => {
    const managedObjects = new Map();
    managedObjects.set('temp-obj', makeMockObject('temp-obj', { _temporary: true }));

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: null,
      envId: null,
    });

    assert.equal(doc.objects.some(o => o.id === 'temp-obj'), false);
  });

  await t.test('excludes objects with skip roles', () => {
    const managedObjects = new Map();
    managedObjects.set('pivot', makeMockObject('pivot', { role: 'multi-transform-pivot' }));
    managedObjects.set('preview', makeMockObject('preview', { role: 'paste-preview' }));
    managedObjects.set('floor', makeMockObject('floor', { role: 'placement-floor' }));
    managedObjects.set('real-obj', makeMockObject('real-obj', {
      asset: { type: 'primitive', primitive: 'box', color: '#fff' },
    }));

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: null,
      envId: null,
    });

    assert.equal(doc.objects.some(o => o.id === 'pivot'), false);
    assert.equal(doc.objects.some(o => o.id === 'preview'), false);
    assert.equal(doc.objects.some(o => o.id === 'floor'), false);
    assert.equal(doc.objects.some(o => o.id === 'real-obj'), true);
  });

  await t.test('does NOT include room, peers, locks, selection, history', () => {
    const managedObjects = new Map();

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: null,
      envId: null,
    });

    assert.equal('room' in doc, false);
    assert.equal('peers' in doc, false);
    assert.equal('locks' in doc, false);
    assert.equal('selection' in doc, false);
    assert.equal('history' in doc, false);
    assert.equal('indexedDb' in doc, false);
    assert.equal('presence' in doc, false);
  });

  await t.test('includes skybox with envId', () => {
    const managedObjects = new Map();

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: null,
      envId: 'outdoor_day',
    });

    assert.ok(doc.skybox, 'skybox should be present');
    assert.equal(doc.skybox.envId, 'outdoor_day');
  });

  await t.test('includes bgm when bgmState provided', () => {
    const managedObjects = new Map();

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: { url: 'https://example.com/bgm.mp3', name: 'track1', loop: true, volume: 0.8 },
      envId: null,
    });

    assert.ok(doc.bgm, 'bgm should be present');
    assert.equal(doc.bgm.url, 'https://example.com/bgm.mp3');
    assert.equal(doc.bgm.loop, true);
  });

  await t.test('throws when managedObjects is not a Map', () => {
    assert.throws(
      () => createSceneDocumentFromSceneSyncState({ managedObjects: null, bgmState: null }),
      /managedObjects must be a Map/
    );
  });

  await t.test('excludes objects with null asset (no renderable representation)', () => {
    const managedObjects = new Map();
    managedObjects.set('no-asset', makeMockObject('no-asset', { asset: null }));
    managedObjects.set('has-asset', makeMockObject('has-asset', {
      asset: { type: 'primitive', primitive: 'box', color: '#fff' },
    }));

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: null,
      envId: null,
    });

    assert.equal(doc.objects.some(o => o.id === 'no-asset'), false, 'asset-less object must be excluded');
    assert.equal(doc.objects.some(o => o.id === 'has-asset'), true);
  });
});

test('isValidSceneDocument validation', async (t) => {
  await t.test('accepts a well-formed document', () => {
    assert.ok(isValidSceneDocument({
      format: 'scene-sync-export-scene',
      version: 1,
      units: 'meters',
      objects: [{
        id: 'obj-1',
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      }],
      skybox: null,
      bgm: null,
    }));
  });

  await t.test('rejects non-string object id', () => {
    assert.equal(isValidSceneDocument({
      format: 'scene-sync-export-scene',
      version: 1,
      objects: [{ id: 123, position: [0,0,0], rotation: [0,0,0,1], scale: [1,1,1] }],
    }), false);
  });

  await t.test('rejects object with wrong-length position', () => {
    assert.equal(isValidSceneDocument({
      format: 'scene-sync-export-scene',
      version: 1,
      objects: [{ id: 'x', position: [0, 0], rotation: [0,0,0,1], scale: [1,1,1] }],
    }), false);
  });

  await t.test('rejects object with wrong-length rotation', () => {
    assert.equal(isValidSceneDocument({
      format: 'scene-sync-export-scene',
      version: 1,
      objects: [{ id: 'x', position: [0,0,0], rotation: [0,0,1], scale: [1,1,1] }],
    }), false);
  });

  await t.test('rejects object with non-number in scale', () => {
    assert.equal(isValidSceneDocument({
      format: 'scene-sync-export-scene',
      version: 1,
      objects: [{ id: 'x', position: [0,0,0], rotation: [0,0,0,1], scale: [1,'x',1] }],
    }), false);
  });

  await t.test('rejects wrong format string', () => {
    assert.equal(isValidSceneDocument({
      format: 'wrong-format',
      version: 1,
      objects: [],
    }), false);
  });

  await t.test('rejects wrong version', () => {
    assert.equal(isValidSceneDocument({
      format: 'scene-sync-export-scene',
      version: 2,
      objects: [],
    }), false);
  });
});
