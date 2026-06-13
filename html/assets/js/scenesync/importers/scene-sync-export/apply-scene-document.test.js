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

test('imports ZIP-bundled image/text/audio assets as shared Scene Sync URLs', async () => {
  const managedObjects = new Map();
  const calls = { addOrUpdate: [], broadcast: [], uploads: [] };

  const zip = createFakeZip({
    'assets/poster.jpg': new Uint8Array([1, 2, 3]).buffer,
    'assets/caption.md': new Uint8Array([4, 5]).buffer,
    'assets/speaker.mp3': new Uint8Array([6, 7, 8, 9]).buffer,
  });

  const uploadBlobToStore = async (blob, mime, extension) => {
    calls.uploads.push({ blob, mime, extension });
    return {
      path: `uploaded-${calls.uploads.length}${extension}`,
      url: `https://blob.test/uploaded-${calls.uploads.length}${extension}`,
    };
  };

  const sceneDocument = {
    objects: [
      {
        id: 'poster',
        name: 'Poster',
        position: [1, 2, 3],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        visible: true,
        asset: {
          type: 'image',
          source: 'url',
          path: 'assets/poster.jpg',
          url: 'https://example.com/poster.jpg',
          mime: 'image/jpeg',
        },
        importAsset: {
          kind: 'blob-file',
          path: 'assets/poster.jpg',
          originalName: 'poster.jpg',
          mime: 'image/jpeg',
        },
        audioSources: {
          default: {
            url: 'https://example.com/speaker.mp3',
            loop: true,
            asset: { path: 'assets/speaker.mp3', mime: 'audio/mpeg' },
          },
        },
        importAudioSources: {
          default: {
            kind: 'blob-file',
            path: 'assets/speaker.mp3',
            originalName: 'speaker.mp3',
            mime: 'audio/mpeg',
          },
        },
      },
      {
        id: 'caption',
        name: 'Caption',
        position: [0, 1, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        visible: true,
        asset: {
          type: 'text',
          source: 'url',
          path: 'assets/caption.md',
          url: 'https://example.com/caption.md',
          mime: 'text/markdown',
          format: 'markdown',
        },
        importAsset: {
          kind: 'blob-file',
          path: 'assets/caption.md',
          originalName: 'caption.md',
          mime: 'text/markdown',
        },
      },
    ],
  };

  const stats = await applySceneDocument(sceneDocument, {
    managedObjects,
    addOrUpdateObject: (id, payload, options) => calls.addOrUpdate.push({ id, payload, options }),
    broadcast: (payload) => calls.broadcast.push(payload),
    uploadBlobToStore,
    zip,
  });

  deepStrictEqual(stats, { total: 2, added: 2, updated: 0, glbImported: 0, skippedAssets: 0 });
  strictEqual(calls.uploads.length, 3);
  deepStrictEqual(calls.uploads.map((u) => [u.mime, u.extension]), [
    ['image/jpeg', '.jpg'],
    ['audio/mpeg', '.mp3'],
    ['text/markdown', '.md'],
  ]);

  const poster = calls.broadcast.find((payload) => payload.objectId === 'poster');
  strictEqual(poster.asset.type, 'image');
  strictEqual(poster.asset.url, 'https://blob.test/uploaded-1.jpg');
  strictEqual(poster.asset.path, undefined);
  strictEqual(poster.asset.source, 'blob');
  strictEqual(poster.audioSources.default.url, 'https://blob.test/uploaded-2.mp3');
  strictEqual(poster.audioSources.default.asset, undefined);

  const caption = calls.broadcast.find((payload) => payload.objectId === 'caption');
  strictEqual(caption.asset.type, 'text');
  strictEqual(caption.asset.url, 'https://blob.test/uploaded-3.md');
  strictEqual(caption.asset.path, undefined);
  strictEqual(caption.asset.source, 'url');
});

test('does not broadcast ZIP-only asset.path when re-upload fails and no fallback URL exists', async (t) => {
  const cases = [
    {
      name: 'uploadBlobToStore: undefined',
      uploadBlobToStore: undefined,
    },
    {
      name: 'uploadBlobToStore returns null',
      uploadBlobToStore: async () => null,
    },
    {
      name: 'uploadBlobToStore returns path without url',
      uploadBlobToStore: async (_blob, _mime, extension) => ({ path: `uploaded${extension}` }),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const managedObjects = new Map();
      const calls = { addOrUpdate: [], broadcast: [] };
      const zip = createFakeZip({
        'assets/poster.png': new Uint8Array([1, 2, 3]).buffer,
        'assets/speaker.mp3': new Uint8Array([4, 5, 6]).buffer,
      });

      const sceneDocument = {
        objects: [
          {
            id: 'poster',
            name: 'Poster',
            position: [1, 2, 3],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
            visible: true,
            metadata: { role: 'media-panel' },
            asset: {
              type: 'image',
              source: 'url',
              path: 'assets/poster.png',
              mime: 'image/png',
            },
            importAsset: {
              kind: 'blob-file',
              path: 'assets/poster.png',
              originalName: 'poster.png',
              mime: 'image/png',
            },
            audioSources: {
              default: {
                loop: true,
                asset: { path: 'assets/speaker.mp3', mime: 'audio/mpeg' },
              },
            },
            importAudioSources: {
              default: {
                kind: 'blob-file',
                path: 'assets/speaker.mp3',
                originalName: 'speaker.mp3',
                mime: 'audio/mpeg',
              },
            },
          },
        ],
      };

      const stats = await applySceneDocument(sceneDocument, {
        managedObjects,
        addOrUpdateObject: (id, payload, options) => calls.addOrUpdate.push({ id, payload, options }),
        broadcast: (payload) => calls.broadcast.push(payload),
        uploadBlobToStore: item.uploadBlobToStore,
        zip,
      });

      deepStrictEqual(stats, { total: 1, added: 1, updated: 0, glbImported: 0, skippedAssets: 2 });
      strictEqual(calls.broadcast.length, 1);

      const payload = calls.broadcast[0];
      strictEqual(payload.asset.path, undefined);
      strictEqual(payload.asset.type, 'primitive');
      strictEqual(payload.asset.primitive, 'box');
      strictEqual(payload.asset.missingAssetType, 'image');
      ok(payload.metadata.importWarning.includes('assets/poster.png'));
      ok(payload.metadata.importWarning.includes('assets/speaker.mp3'));
      strictEqual(payload.audioSources.default, undefined);
      strictEqual(JSON.stringify(payload.asset).includes('assets/poster.png'), false);
      strictEqual(JSON.stringify(payload.audioSources || {}).includes('assets/speaker.mp3'), false);
    });
  }
});

test('keeps fallback URLs and clears ZIP paths when re-upload throws', async () => {
  const managedObjects = new Map();
  const calls = { addOrUpdate: [], broadcast: [] };
  const zip = createFakeZip({
    'assets/poster.png': new Uint8Array([1, 2, 3]).buffer,
    'assets/speaker.mp3': new Uint8Array([4, 5, 6]).buffer,
  });

  const sceneDocument = {
    objects: [
      {
        id: 'poster',
        name: 'Poster',
        position: [1, 2, 3],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        visible: true,
        asset: {
          type: 'image',
          source: 'blob',
          path: 'assets/poster.png',
          url: 'https://staging.afjk.jp/presence/blob/poster.png',
          mime: 'image/png',
        },
        importAsset: {
          kind: 'blob-file',
          path: 'assets/poster.png',
          originalName: 'poster.png',
          mime: 'image/png',
        },
        audioSources: {
          default: {
            url: 'https://example.com/speaker.mp3',
            loop: true,
            asset: { path: 'assets/speaker.mp3', mime: 'audio/mpeg' },
          },
        },
        importAudioSources: {
          default: {
            kind: 'blob-file',
            path: 'assets/speaker.mp3',
            originalName: 'speaker.mp3',
            mime: 'audio/mpeg',
          },
        },
      },
    ],
  };

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  let stats;
  try {
    stats = await applySceneDocument(sceneDocument, {
      managedObjects,
      addOrUpdateObject: (id, payload, options) => calls.addOrUpdate.push({ id, payload, options }),
      broadcast: (payload) => calls.broadcast.push(payload),
      uploadBlobToStore: async () => {
        throw new Error('Unsupported Media Type');
      },
      zip,
    });
  } finally {
    console.warn = originalWarn;
  }

  deepStrictEqual(stats, { total: 1, added: 1, updated: 0, glbImported: 0, skippedAssets: 0 });
  strictEqual(warnings.length, 2);
  strictEqual(calls.broadcast.length, 1);

  const payload = calls.broadcast[0];
  strictEqual(payload.asset.type, 'image');
  strictEqual(payload.asset.url, 'https://staging.afjk.jp/presence/blob/poster.png');
  strictEqual(payload.asset.path, undefined);
  strictEqual(payload.audioSources.default.url, 'https://example.com/speaker.mp3');
  strictEqual(payload.audioSources.default.asset, undefined);
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
  strictEqual(calls.addOrUpdate[0].payload.asset.type, 'primitive');
  strictEqual(calls.addOrUpdate[0].payload.asset.path, undefined);
  ok(calls.addOrUpdate[0].payload.metadata.importWarning.includes('assets/booth-2.glb'));
});
