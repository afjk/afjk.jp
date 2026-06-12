// Tests for apply-scene-document.js
// Run: node --test html/assets/js/scenesync/importers/scene-sync-export/apply-scene-document.test.js

import { test } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { applySceneDocument } from './apply-scene-document.js';

function createFakeZip(files) {
  return {
    file(path) {
      const data = files[path];
      if (!data) return null;
      return {
        async async(type) {
          strictEqual(type, 'arraybuffer');
          return data;
        },
      };
    },
  };
}

test('adds new objects and updates existing ones via addOrUpdateObject + broadcast', async () => {
  const managedObjects = new Map([['existing-1', {}]]);
  const calls = { addOrUpdate: [], broadcast: [] };

  const sceneDocument = {
    objects: [
      {
        id: 'existing-1',
        name: 'Existing',
        position: [1, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        asset: { type: 'primitive', primitive: 'box', color: '#ffffff' },
        visible: true,
        metadata: { foo: 'bar' },
      },
      {
        id: 'new-1',
        name: 'New',
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        asset: { type: 'primitive', primitive: 'sphere', color: '#000000' },
        visible: false,
      },
    ],
  };

  const stats = await applySceneDocument(sceneDocument, {
    managedObjects,
    addOrUpdateObject: (id, payload, options) => calls.addOrUpdate.push({ id, payload, options }),
    broadcast: (payload) => calls.broadcast.push(payload),
  });

  deepStrictEqual(stats, { total: 2, added: 1, updated: 1, glbImported: 0, skippedAssets: 0 });
  strictEqual(calls.addOrUpdate.length, 2);
  strictEqual(calls.broadcast.length, 2);
  strictEqual(calls.addOrUpdate[0].id, 'existing-1');
  strictEqual(calls.addOrUpdate[0].payload.metadata.foo, 'bar');
  strictEqual(calls.addOrUpdate[1].payload.visible, false);
});

test('imports ZIP-bundled GLB assets via importGlbFileAsSceneObject, keeping objectId', async () => {
  const managedObjects = new Map();
  const calls = { addOrUpdate: [], broadcast: [], importGlb: [] };

  const glbBytes = new ArrayBuffer(8);
  const zip = createFakeZip({ 'assets/booth-1.glb': glbBytes });

  const sceneDocument = {
    objects: [
      {
        id: 'booth-1',
        name: 'Booth',
        position: [1, 0.5, -2],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        visible: true,
        metadata: { role: 'booth' },
        animation: { enabled: true, clip: 0 },
        audioSources: { ambient: { url: 'https://example.com/a.mp3' } },
        importAsset: {
          kind: 'glb-file',
          path: 'assets/booth-1.glb',
          originalName: 'booth-1.glb',
          mime: 'model/gltf-binary',
        },
      },
    ],
  };

  const stats = await applySceneDocument(sceneDocument, {
    managedObjects,
    addOrUpdateObject: (id, payload) => calls.addOrUpdate.push({ id, payload }),
    broadcast: (payload) => calls.broadcast.push(payload),
    importGlbFileAsSceneObject: async (file, options) => {
      calls.importGlb.push({ file, options });
    },
    zip,
  });

  deepStrictEqual(stats, { total: 1, added: 1, updated: 0, glbImported: 1, skippedAssets: 0 });
  strictEqual(calls.addOrUpdate.length, 0);
  strictEqual(calls.broadcast.length, 0);
  strictEqual(calls.importGlb.length, 1);

  const { file, options } = calls.importGlb[0];
  strictEqual(file.name, 'booth-1.glb');
  strictEqual(file.type, 'model/gltf-binary');
  strictEqual(options.objectId, 'booth-1');
  strictEqual(options.name, 'Booth');
  deepStrictEqual(options.position, [1, 0.5, -2]);
  strictEqual(options.selectAfterLoad, false);
  deepStrictEqual(options.metadata, { role: 'booth' });
  deepStrictEqual(options.animation, { enabled: true, clip: 0 });
  ok(options.audioSources.ambient);
});

test('falls back to placeholder when ZIP entry for importAsset is missing', async () => {
  const managedObjects = new Map();
  const calls = { addOrUpdate: [], broadcast: [] };

  const zip = createFakeZip({});

  const sceneDocument = {
    objects: [
      {
        id: 'booth-2',
        name: 'Missing GLB',
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        visible: true,
        asset: { type: 'mesh', path: 'assets/booth-2.glb' },
        importAsset: {
          kind: 'glb-file',
          path: 'assets/booth-2.glb',
          originalName: 'booth-2.glb',
          mime: 'model/gltf-binary',
        },
      },
    ],
  };

  const stats = await applySceneDocument(sceneDocument, {
    managedObjects,
    addOrUpdateObject: (id, payload) => calls.addOrUpdate.push({ id, payload }),
    broadcast: (payload) => calls.broadcast.push(payload),
    zip,
  });

  strictEqual(stats.glbImported, 0);
  strictEqual(stats.skippedAssets, 1);
  strictEqual(calls.addOrUpdate.length, 1);
  strictEqual(calls.addOrUpdate[0].payload.asset.type, 'mesh');
});
