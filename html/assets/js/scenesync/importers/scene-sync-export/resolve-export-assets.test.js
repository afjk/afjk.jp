// Tests for resolve-export-assets.js
// Run: node --test html/assets/js/scenesync/importers/scene-sync-export/resolve-export-assets.test.js

import { test } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { resolveSceneDocumentAssets } from './resolve-export-assets.js';

function createFakeZip(paths) {
  const set = new Set(paths);
  return {
    file(path) {
      return set.has(path) ? {} : null;
    },
  };
}

test('passes through primitives, inline text, and URL assets unchanged', async () => {
  const sceneDocument = {
    objects: [
      { id: 'a', asset: { type: 'primitive', primitive: 'box', color: '#fff' } },
      { id: 'b', asset: { type: 'text', source: 'inline', text: 'hello' } },
      { id: 'c', asset: { type: 'image', url: 'https://example.com/i.png' } },
    ],
  };

  const { document } = await resolveSceneDocumentAssets(sceneDocument);
  deepStrictEqual(document.objects, sceneDocument.objects);
});

test('marks ZIP-bundled GLB assets with an importAsset plan when the zip entry exists', async () => {
  const zip = createFakeZip(['assets/booth-1.glb']);
  const sceneDocument = {
    objects: [
      {
        id: 'booth-1',
        asset: { type: 'mesh', path: 'assets/booth-1.glb', mime: 'model/gltf-binary', originalName: 'booth-1.glb' },
      },
    ],
  };

  const { document } = await resolveSceneDocumentAssets(sceneDocument, { zip });
  const obj = document.objects[0];
  ok(obj.importAsset);
  strictEqual(obj.importAsset.kind, 'glb-file');
  strictEqual(obj.importAsset.path, 'assets/booth-1.glb');
  strictEqual(obj.importAsset.originalName, 'booth-1.glb');
  strictEqual(obj.importAsset.mime, 'model/gltf-binary');
  // original asset is left untouched
  strictEqual(obj.asset.type, 'mesh');
});

test('falls back to importWarning placeholder when GLB zip entry is missing', async () => {
  const zip = createFakeZip([]);
  const sceneDocument = {
    objects: [
      {
        id: 'booth-2',
        asset: { type: 'mesh', path: 'assets/booth-2.glb' },
      },
    ],
  };

  const { document } = await resolveSceneDocumentAssets(sceneDocument, { zip });
  const obj = document.objects[0];
  strictEqual(obj.importAsset, undefined);
  ok(obj.metadata.importWarning.includes('assets/booth-2.glb'));
});

test('falls back to importWarning placeholder for path-only image/video assets', async () => {
  const sceneDocument = {
    objects: [
      { id: 'img-1', asset: { type: 'image', path: 'assets/img-1.jpg' } },
    ],
  };

  const { document } = await resolveSceneDocumentAssets(sceneDocument);
  const obj = document.objects[0];
  ok(obj.metadata.importWarning.includes('assets/img-1.jpg'));
});
