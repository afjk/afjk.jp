import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { showSceneDocumentImportPreview, tryOpenSceneSyncExportFile, tryOpenSceneSyncExportUrl } from './index.js';
import { buildSingleHtmlDocument } from '../../../scenesync-export/export/single-html-format.js';

function createFakeZip(entries) {
  return {
    file(path) {
      const value = entries[path];
      if (value == null) return null;
      return {
        async async(type) {
          if (type === 'string') return String(value);
          if (type === 'arraybuffer') {
            return new TextEncoder().encode(String(value)).buffer;
          }
          throw new Error(`unsupported fake zip type: ${type}`);
        },
      };
    },
  };
}

test('shows local Scene Sync Export import previews without ZIP paths', async () => {
  const calls = [];
  const revoked = [];
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let nextBlobUrl = 1;

  URL.createObjectURL = () => `blob:preview-${nextBlobUrl++}`;
  URL.revokeObjectURL = (url) => revoked.push(url);

  try {
    const zip = createFakeZip({
      'assets/poster.png': 'png-bytes',
      'assets/caption.md': '# Caption',
      'assets/model.glb': 'glb-bytes',
    });

    const preview = await showSceneDocumentImportPreview({
      objects: [
        {
          id: 'poster',
          name: 'Poster',
          position: [1, 2, 3],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
          asset: { type: 'image', path: 'assets/poster.png', mime: 'image/png' },
          metadata: { role: 'media-panel' },
          audioSources: {
            default: {
              url: 'https://example.com/poster.mp3',
              asset: { path: 'assets/poster.mp3' },
            },
          },
        },
        {
          id: 'caption',
          name: 'Caption',
          asset: { type: 'text', source: 'url', path: 'assets/caption.md', format: 'markdown' },
        },
        {
          id: 'model',
          name: 'Model',
          asset: { type: 'mesh', path: 'assets/model.glb', mime: 'model/gltf-binary' },
        },
      ],
    }, {
      zip,
      addOrUpdateObject: (id, payload, options) => calls.push({ id, payload, options }),
    });

    strictEqual(preview.previewed, 3);
    strictEqual(calls.length, 3);
    deepStrictEqual(calls.map((call) => call.options), [
      { source: 'scene-sync-export-import-preview' },
      { source: 'scene-sync-export-import-preview' },
      { source: 'scene-sync-export-import-preview' },
    ]);

    strictEqual(calls[0].id, 'poster');
    strictEqual(calls[0].payload.asset.type, 'image');
    strictEqual(calls[0].payload.asset.source, 'local-preview');
    strictEqual(calls[0].payload.asset.url, 'blob:preview-1');
    strictEqual(calls[0].payload.asset.path, undefined);
    strictEqual(calls[0].payload.metadata.importPreview, true);
    strictEqual(calls[0].payload.audioSources, undefined);
    strictEqual(JSON.stringify(calls[0].payload).includes('assets/poster.mp3'), false);

    strictEqual(calls[1].id, 'caption');
    strictEqual(calls[1].payload.asset.type, 'text');
    strictEqual(calls[1].payload.asset.source, 'inline');
    strictEqual(calls[1].payload.asset.text, '# Caption');
    strictEqual(calls[1].payload.asset.path, undefined);

    strictEqual(calls[2].id, 'model');
    strictEqual(calls[2].payload.asset.type, 'primitive');
    strictEqual(calls[2].payload.asset.primitive, 'box');
    strictEqual(calls[2].payload.asset.previewAssetType, 'mesh');

    preview.dispose();
    deepStrictEqual(revoked, ['blob:preview-1']);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

function response({ url, body, contentType = 'application/json', ok = true, status = 200 }) {
  return {
    ok,
    status,
    url,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type' ? contentType : '';
      },
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function createFetch(routes) {
  return async (url) => {
    const href = String(url);
    const route = routes[href];
    if (!route) {
      return response({ url: href, body: 'not found', ok: false, status: 404 });
    }
    return response({ url: href, ...route });
  };
}

test('imports Scene Sync Export scene.json URLs without broadcasting relative asset paths', async () => {
  const sceneDocument = {
    format: 'scene-sync-export-scene',
    version: 2,
    objects: [
      {
        id: 'image-1',
        name: 'Image',
        position: [0, 1, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        asset: { type: 'image', source: 'blob', path: 'assets/poster.png' },
        audioSources: {
          default: {
            type: 'audioSource',
            asset: { path: 'assets/narration.mp3' },
            volume: 1,
          },
        },
      },
      {
        id: 'mesh-1',
        name: 'Mesh',
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        asset: { type: 'mesh', source: 'carrier', path: 'assets/model.glb' },
      },
      {
        id: 'text-1',
        name: 'Text',
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        asset: { type: 'text', source: 'url', path: 'assets/story.md', format: 'markdown' },
      },
    ],
    bgm: {
      name: 'bgm.mp3',
      asset: { path: 'assets/bgm.mp3' },
    },
  };
  const fetchImpl = createFetch({
    'https://example.com/world/scene.json': { body: sceneDocument },
  });
  const managedObjects = new Map();
  const calls = { addOrUpdate: [], broadcast: [], bgm: [], uploads: 0, toasts: [] };

  const result = await tryOpenSceneSyncExportUrl('https://example.com/world/scene.json', {
    managedObjects,
    fetchImpl,
    confirmOpen: () => true,
    addOrUpdateObject: (id, payload, options) => calls.addOrUpdate.push({ id, payload, options }),
    broadcast: (payload) => calls.broadcast.push(payload),
    applySceneBgm: (bgm, options) => calls.bgm.push({ bgm, options }),
    uploadBlobToStore: async () => {
      calls.uploads += 1;
      throw new Error('URL import should not upload assets');
    },
    showToast: (message) => calls.toasts.push(message),
  });

  strictEqual(result.handled, true);
  strictEqual(result.stats.added, 3);
  strictEqual(calls.uploads, 0);

  const finalAdds = calls.addOrUpdate.filter((call) => call.options?.source === 'scene-sync-export-import');
  strictEqual(finalAdds.length, 3);
  strictEqual(finalAdds[0].payload.asset.url, 'https://example.com/world/assets/poster.png');
  strictEqual(finalAdds[0].payload.asset.source, 'url');
  strictEqual(finalAdds[0].payload.audioSources.default.url, 'https://example.com/world/assets/narration.mp3');
  strictEqual(finalAdds[1].payload.asset.url, 'https://example.com/world/assets/model.glb');
  strictEqual(finalAdds[1].payload.asset.source, 'url');
  strictEqual(finalAdds[2].payload.asset.url, 'https://example.com/world/assets/story.md');
  strictEqual(calls.bgm[0].bgm.url, 'https://example.com/world/assets/bgm.mp3');

  const broadcastJson = JSON.stringify(calls.broadcast);
  strictEqual(broadcastJson.includes('"path"'), false);
  strictEqual(JSON.stringify(calls.bgm).includes('"asset"'), false);
});

test('falls through when URL is not a Scene Sync Export', async () => {
  const fetchImpl = createFetch({
    'https://example.com/page/': {
      body: '<!doctype html><title>Plain page</title>',
      contentType: 'text/html',
    },
    'https://example.com/page/scene.json': {
      body: 'not found',
      ok: false,
      status: 404,
    },
    'https://example.com/page/current.json': {
      body: 'not found',
      ok: false,
      status: 404,
    },
  });
  const calls = { addOrUpdate: [], broadcast: [] };

  const result = await tryOpenSceneSyncExportUrl('https://example.com/page/', {
    managedObjects: new Map(),
    fetchImpl,
    confirmOpen: () => {
      throw new Error('confirm should not be called');
    },
    addOrUpdateObject: (id, payload, options) => calls.addOrUpdate.push({ id, payload, options }),
    broadcast: (payload) => calls.broadcast.push(payload),
  });

  strictEqual(result.handled, false);
  strictEqual(calls.addOrUpdate.length, 0);
  strictEqual(calls.broadcast.length, 0);
});

test('stops generic URL fallback for explicit invalid Scene Sync Export URLs', async () => {
  const fetchImpl = createFetch({
    'https://example.com/world/scene.json': {
      body: {
        format: 'not-scene-sync-export',
        version: 2,
        objects: [],
      },
    },
  });
  const calls = { addOrUpdate: [], broadcast: [], toasts: [] };

  const result = await tryOpenSceneSyncExportUrl('https://example.com/world/scene.json', {
    managedObjects: new Map(),
    fetchImpl,
    confirmOpen: () => {
      throw new Error('confirm should not be called for invalid exports');
    },
    addOrUpdateObject: (id, payload, options) => calls.addOrUpdate.push({ id, payload, options }),
    broadcast: (payload) => calls.broadcast.push(payload),
    showToast: (message) => calls.toasts.push(message),
  });

  strictEqual(result.handled, true);
  strictEqual(result.error, 'invalid-scene-document');
  strictEqual(calls.addOrUpdate.length, 0);
  strictEqual(calls.broadcast.length, 0);
  strictEqual(calls.toasts[0], 'Scene Sync Export URLを読み込めませんでした（invalid-scene-document）');
});

test('imports local Single HTML exports through the existing asset, settings, physics, and Loomlet paths', async () => {
  const sceneDocument = {
    format: 'scene-sync-export-scene',
    version: 2,
    skybox: { type: 'env', envId: 'outdoor_day' },
    physics: { enabled: true, gravity: [0, -9.81, 0] },
    behaviors: { scene: { id: 'loomlet-1', nodes: [] } },
    bgm: { name: 'BGM', asset: { path: 'assets/bgm.mp3', mime: 'audio/mpeg' } },
    objects: [{
      id: 'poster', name: 'Poster', position: [2, 3, 4], rotation: [0, 0.5, 0, 0.5], scale: [2, 2, 2],
      asset: { type: 'image', path: 'assets/poster.png', mime: 'image/png' },
      audioSources: { default: { asset: { path: 'assets/narration.mp3', mime: 'audio/mpeg' } } },
    }],
  };
  const html = await buildSingleHtmlDocument({
    sceneDocument,
    manifest: { singleHtml: { format: 'single-html-v1', version: 1 } },
    files: {
      'assets/poster.png': new Uint8Array([1, 2]).buffer,
      'assets/narration.mp3': new Uint8Array([3, 4, 5]).buffer,
      'assets/bgm.mp3': new Uint8Array([6, 7, 8, 9]).buffer,
    },
    viewerFiles: {},
  });
  const calls = { adds: [], broadcasts: [], uploaded: [], environments: [], physics: [], behaviors: [], bgm: [] };
  const result = await tryOpenSceneSyncExportFile({
    name: 'portable-scene.html', type: 'text/html', text: async () => html,
  }, {
    managedObjects: new Map(),
    confirmOpen: () => true,
    addOrUpdateObject: (id, payload, options) => calls.adds.push({ id, payload, options }),
    broadcast: (payload) => calls.broadcasts.push(payload),
    uploadBlobToStore: async (blob, mime) => {
      const url = `https://blob.test/${blob.size}`;
      calls.uploaded.push({ size: blob.size, mime, url });
      return { url };
    },
    environmentManager: { loadEnvironment: (id) => calls.environments.push(id) },
    applyScenePhysics: (physics) => { calls.physics.push(physics); return physics; },
    applySceneBehaviors: async (behaviors) => { calls.behaviors.push(behaviors); return { applied: 1 }; },
    applySceneBgm: (bgm) => calls.bgm.push(bgm),
  });

  strictEqual(result.handled, true);
  strictEqual(result.kind, 'single-html-local');
  strictEqual(result.stats.added, 1);
  deepStrictEqual(calls.uploaded.map((entry) => entry.size), [2, 3, 4]);
  const finalAdd = calls.adds.find((entry) => entry.options?.source === 'scene-sync-export-import');
  deepStrictEqual(finalAdd.payload.position, [2, 3, 4]);
  deepStrictEqual(finalAdd.payload.rotation, [0, 0.5, 0, 0.5]);
  deepStrictEqual(finalAdd.payload.scale, [2, 2, 2]);
  strictEqual(finalAdd.payload.asset.url, 'https://blob.test/2');
  strictEqual(finalAdd.payload.audioSources.default.url, 'https://blob.test/3');
  strictEqual(calls.bgm[0].url, 'https://blob.test/4');
  deepStrictEqual(calls.environments, ['outdoor_day']);
  deepStrictEqual(calls.physics, [sceneDocument.physics]);
  deepStrictEqual(calls.behaviors, [sceneDocument.behaviors]);
});

test('imports CORS-readable Single HTML URLs through the same local-asset upload path', async () => {
  const html = await buildSingleHtmlDocument({
    sceneDocument: {
      format: 'scene-sync-export-scene', version: 2,
      objects: [{
        id: 'remote-poster', position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        asset: { type: 'image', path: 'assets/poster.png', mime: 'image/png' },
      }],
    },
    manifest: { singleHtml: { format: 'single-html-v1', version: 1 } },
    files: { 'assets/poster.png': new Uint8Array([9, 8, 7]).buffer },
    viewerFiles: {},
  });
  const calls = { adds: [], uploads: 0 };
  const result = await tryOpenSceneSyncExportUrl('https://cdn.example.com/portable.html', {
    managedObjects: new Map(),
    confirmOpen: () => true,
    fetchImpl: createFetch({
      'https://cdn.example.com/portable.html': { body: html, contentType: 'text/html' },
    }),
    addOrUpdateObject: (id, payload, options) => calls.adds.push({ id, payload, options }),
    broadcast() {},
    uploadBlobToStore: async (blob) => {
      calls.uploads += 1;
      strictEqual(blob.size, 3);
      return { url: 'https://blob.test/remote-poster.png' };
    },
  });

  strictEqual(result.handled, true);
  strictEqual(result.kind, 'single-html-url');
  strictEqual(calls.uploads, 1);
  const finalAdd = calls.adds.find((entry) => entry.options?.source === 'scene-sync-export-import');
  strictEqual(finalAdd.payload.asset.url, 'https://blob.test/remote-poster.png');
  deepStrictEqual(finalAdd.payload.position, [1, 2, 3]);
});

test('explains how to fix a CORS failure for a Single HTML URL', async () => {
  const toasts = [];
  const result = await tryOpenSceneSyncExportUrl('https://cdn.example.com/portable.html', {
    managedObjects: new Map(),
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    showToast: (message) => toasts.push(message),
  });
  strictEqual(result.handled, true);
  strictEqual(result.error, 'single-html-fetch-failed');
  strictEqual(toasts[0], 'Single HTML Exportを取得できませんでした。公開元でCORSを許可してください。');
});
