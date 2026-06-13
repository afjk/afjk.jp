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

test('marks ZIP-bundled image/video/text assets with upload import plans even when URL fallback exists', async () => {
  const zip = createFakeZip(['assets/img-1.jpg', 'assets/video-1.mp4', 'assets/story.md']);
  const sceneDocument = {
    objects: [
      {
        id: 'img-1',
        asset: {
          type: 'image',
          path: 'assets/img-1.jpg',
          url: 'https://example.com/img-1.jpg',
          mime: 'image/jpeg',
        },
      },
      {
        id: 'video-1',
        asset: {
          type: 'video',
          path: 'assets/video-1.mp4',
          url: 'https://example.com/video-1.mp4',
          mime: 'video/mp4',
        },
      },
      {
        id: 'story',
        asset: {
          type: 'text',
          source: 'url',
          path: 'assets/story.md',
          url: 'https://example.com/story.md',
          mime: 'text/markdown',
        },
      },
    ],
  };

  const { document } = await resolveSceneDocumentAssets(sceneDocument, { zip });

  deepStrictEqual(
    document.objects.map((obj) => obj.importAsset),
    [
      { kind: 'blob-file', path: 'assets/img-1.jpg', originalName: 'img-1.jpg', mime: 'image/jpeg' },
      { kind: 'blob-file', path: 'assets/video-1.mp4', originalName: 'video-1.mp4', mime: 'video/mp4' },
      { kind: 'blob-file', path: 'assets/story.md', originalName: 'story.md', mime: 'text/markdown' },
    ]
  );
});

test('marks ZIP-bundled object audio source assets with upload import plans', async () => {
  const zip = createFakeZip(['assets/speaker-default.mp3']);
  const sceneDocument = {
    objects: [
      {
        id: 'speaker',
        asset: { type: 'primitive', primitive: 'box' },
        audioSources: {
          default: {
            url: 'https://example.com/speaker-default.mp3',
            asset: { path: 'assets/speaker-default.mp3', mime: 'audio/mpeg' },
          },
        },
      },
    ],
  };

  const { document } = await resolveSceneDocumentAssets(sceneDocument, { zip });
  deepStrictEqual(document.objects[0].importAudioSources, {
    default: {
      kind: 'blob-file',
      path: 'assets/speaker-default.mp3',
      originalName: 'speaker-default.mp3',
      mime: 'audio/mpeg',
    },
  });
});

test('marks ZIP-bundled BGM asset with upload import plan', async () => {
  const zip = createFakeZip(['assets/bgm.mp3']);
  const sceneDocument = {
    objects: [],
    bgm: {
      url: 'https://example.com/bgm.mp3',
      name: 'bgm.mp3',
      asset: { path: 'assets/bgm.mp3', mime: 'audio/mpeg' },
    },
  };

  const { document } = await resolveSceneDocumentAssets(sceneDocument, { zip });
  deepStrictEqual(document.bgm.importAsset, {
    kind: 'blob-file',
    path: 'assets/bgm.mp3',
    originalName: 'bgm.mp3',
    mime: 'audio/mpeg',
  });
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
