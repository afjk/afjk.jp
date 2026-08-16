import { test } from 'node:test';
import { strictEqual, deepStrictEqual, rejects } from 'node:assert';
import {
  applySceneSyncHandoffPayload,
  applySceneSyncHandoffUrl,
  showSceneDocumentImportPreview,
  tryOpenSceneSyncExportFile,
  tryOpenSceneSyncExportUrl,
} from './index.js';
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
    async json() {
      return typeof body === 'string' ? JSON.parse(body) : body;
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
    'https://example.com/world/assets/poster.png': { body: new Uint8Array([1, 2, 3]) },
    'https://example.com/world/assets/narration.mp3': { body: new Uint8Array([4]) },
    'https://example.com/world/assets/model.glb': { body: new Uint8Array([5, 6]) },
    'https://example.com/world/assets/story.md': { body: '# story' },
    'https://example.com/world/assets/bgm.mp3': { body: new Uint8Array([7]) },
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
      return { url: `https://blob.test/${calls.uploads}` };
    },
    showToast: (message) => calls.toasts.push(message),
  });

  strictEqual(result.handled, true);
  strictEqual(result.stats.added, 3);
  strictEqual(calls.uploads, 4);

  const finalAdds = calls.addOrUpdate.filter((call) => call.options?.source === 'scene-sync-export-import');
  strictEqual(finalAdds.length, 3);
  strictEqual(finalAdds[0].payload.asset.url, 'https://blob.test/1');
  strictEqual(finalAdds[0].payload.asset.source, 'blob');
  strictEqual(finalAdds[0].payload.audioSources.default.url, 'https://blob.test/2');
  strictEqual(finalAdds[2].payload.asset.url, 'https://blob.test/3');
  strictEqual(calls.bgm[0].bgm.url, 'https://blob.test/4');

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

test('handoff imports embedded image and GLB assets in add mode without confirmation', async () => {
  const sceneDocument = {
    format: 'scene-sync-export-scene',
    version: 2,
    skybox: { type: 'env', envId: 'must-not-apply' },
    bgm: { url: 'https://example.test/must-not-apply.mp3' },
    physics: { enabled: true, gravity: [0, -1, 0] },
    behaviors: { scene: { nodes: [], edges: [] } },
    objects: [
      {
        id: 'handoff-poster', position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        asset: { type: 'image', path: 'assets/poster.png', mime: 'image/png' },
      },
      {
        id: 'handoff-model', position: [4, 5, 6], rotation: [0, 0, 0, 1], scale: [2, 2, 2],
        asset: { type: 'mesh', path: 'assets/model.glb', mime: 'model/gltf-binary' },
      },
    ],
  };
  const calls = { adds: [], broadcasts: [], glb: [], uploads: [], settings: 0, behaviors: 0 };
  const result = await applySceneSyncHandoffPayload({
    sceneDocument,
    embeddedAssets: {
      'assets/poster.png': { mime: 'image/png', base64: 'AQI=' },
      'assets/model.glb': { mime: 'model/gltf-binary', base64: 'Z2xi' },
    },
  }, {
    managedObjects: new Map(),
    confirmOpen: () => { throw new Error('handoff must not request confirmation'); },
    addOrUpdateObject: (id, payload, options) => calls.adds.push({ id, payload, options }),
    broadcast: (payload) => calls.broadcasts.push(payload),
    uploadBlobToStore: async (blob, mime) => {
      calls.uploads.push({ size: blob.size, mime });
      return { url: 'https://blob.test/poster.png', mime };
    },
    importGlbFileAsSceneObject: async (file, options) => {
      options.beforeCommit?.();
      calls.glb.push({ file, options });
    },
    environmentManager: { loadEnvironment: () => { calls.settings += 1; } },
    applySceneBgm: () => { calls.settings += 1; },
    applyScenePhysics: () => { calls.settings += 1; },
    applySceneBehaviors: () => { calls.behaviors += 1; },
  });

  strictEqual(result.handled, true);
  strictEqual(result.kind, 'single-html-handoff');
  strictEqual(result.stats.added, 2);
  strictEqual(result.stats.glbImported, 1);
  deepStrictEqual(calls.uploads, [{ size: 2, mime: 'image/png' }]);
  strictEqual(calls.glb[0].file.name, 'model.glb');
  deepStrictEqual(calls.glb[0].options.position, [4, 5, 6]);
  strictEqual(calls.adds.length, 1, 'handoff must skip preview mutations');
  const imageAdd = calls.adds.find((entry) => entry.options?.source === 'scene-sync-export-import');
  strictEqual(imageAdd.payload.asset.url, 'https://blob.test/poster.png');
  strictEqual(calls.settings, 0);
  strictEqual(calls.behaviors, 0);
  strictEqual(result.settings, undefined);
  strictEqual(result.behaviors, null);
});

test('handoff add rejects duplicate and existing object IDs before preview, update, or broadcast', async () => {
  const baseObject = {
    id: 'existing', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    asset: { type: 'primitive', primitive: 'box' },
  };
  const calls = { adds: 0, broadcasts: 0 };
  const context = {
    managedObjects: new Map([['existing', {}]]),
    addOrUpdateObject: () => { calls.adds += 1; },
    broadcast: () => { calls.broadcasts += 1; },
  };
  await rejects(
    () => applySceneSyncHandoffPayload({
      sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [baseObject] },
      embeddedAssets: {},
    }, context),
    (error) => error.code === 'handoff-object-id-conflict',
  );
  strictEqual(calls.adds, 0);
  strictEqual(calls.broadcasts, 0);

  await rejects(
    () => applySceneSyncHandoffPayload({
      sceneDocument: {
        format: 'scene-sync-export-scene', version: 2,
        objects: [{ ...baseObject, id: 'duplicate' }, { ...baseObject, id: 'duplicate' }],
      },
      embeddedAssets: {},
    }, { ...context, managedObjects: new Map() }),
    (error) => error.code === 'handoff-duplicate-object-id',
  );
  strictEqual(calls.adds, 0);
  strictEqual(calls.broadcasts, 0);
});

test('URL handoff preflights existing IDs before it fetches publisher assets', async () => {
  let calls = 0;
  await rejects(
    () => applySceneSyncHandoffUrl({ sourceUrl: 'https://example.com/world/scene.json' }, {
      managedObjects: new Map([['taken', {}]]),
      fetchImpl: async (url) => {
        calls += 1;
        return response({ url: String(url), body: {
          format: 'scene-sync-export-scene', version: 2,
          objects: [{ id: 'taken', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], asset: { type: 'image', path: 'assets/a.png' } }],
        } });
      },
    }),
    (error) => error.code === 'handoff-object-id-conflict',
  );
  strictEqual(calls, 1, 'only scene.json may be fetched before ID preflight rejects');
});

test('URL handoff uses server pull only for opaque network failure and materializes after inspection', async () => {
  const document = {
    format: 'scene-sync-export-scene', version: 2,
    objects: [{ id: 'server-pull', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], asset: { type: 'primitive', primitive: 'box' } }],
  };
  const calls = [];
  let result;
  try { result = await applySceneSyncHandoffUrl({
    sourceUrl: 'https://no-acao.example/world/', sessionId: 'a'.repeat(22), requestId: 'b'.repeat(22),
  }, {
    managedObjects: new Map(), addOrUpdateObject: () => {}, broadcast: () => {},
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    serverFetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), body: options.body });
      if (String(url).endsWith('/import-jobs')) return response({ url: String(url), body: { jobId: 'a'.repeat(32), token: 'token', digest: 'digest', sessionId: 'a'.repeat(22), requestId: 'b'.repeat(22), sceneDocument: document } });
      return response({ url: String(url), body: { sceneDocument: document } });
    },
  }); } catch (error) { throw error.cause || error; }
  strictEqual(result.handled, true);
  strictEqual(calls.length, 2);
  strictEqual(JSON.parse(calls[1].body).digest, 'digest');
});

test('URL handoff does not call server pull for HTTP failure', async () => {
  let serverCalls = 0;
  await rejects(
    () => applySceneSyncHandoffUrl({ sourceUrl: 'https://denied.example/scene.json', sessionId: 'a'.repeat(22), requestId: 'b'.repeat(22) }, {
      managedObjects: new Map(), fetchImpl: async (url) => response({ url: String(url), body: 'denied', ok: false, status: 403 }),
      serverFetchImpl: async () => { serverCalls += 1; throw new Error('must not call'); },
    }),
    (error) => error.code === 'handoff-url-load-failed',
  );
  strictEqual(serverCalls, 0);
});

test('URL handoff rejects an inspection token bound to different handoff IDs', async () => {
  let materializeCalls = 0;
  await rejects(
    () => applySceneSyncHandoffUrl({ sourceUrl: 'https://no-acao.example/world/', sessionId: 'a'.repeat(22), requestId: 'b'.repeat(22) }, {
      managedObjects: new Map(), fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
      serverFetchImpl: async (url) => {
        if (String(url).endsWith('/import-jobs')) return response({ url: String(url), body: {
          jobId: 'a'.repeat(32), token: 'token', digest: 'digest', sessionId: 'z'.repeat(22), requestId: 'b'.repeat(22), sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [] },
        } });
        materializeCalls += 1;
        throw new Error('must not materialize');
      },
    }),
    (error) => error.code === 'handoff-url-import-failed',
  );
  strictEqual(materializeCalls, 0);
});

test('URL handoff retries through server pull when only a referenced asset is opaque', async () => {
  const remoteDocument = {
    format: 'scene-sync-export-scene', version: 2,
    objects: [{ id: 'opaque-asset', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], asset: { type: 'image', path: 'assets/poster.png' } }],
  };
  const stagedDocument = {
    ...remoteDocument,
    objects: [{ ...remoteDocument.objects[0], asset: { type: 'image', url: '/presence/blob/staged-poster', mime: 'image/png' } }],
  };
  const serverCalls = [];
  const result = await applySceneSyncHandoffUrl({
    sourceUrl: 'https://mixed-cors.example/world/scene.json', sessionId: 'a'.repeat(22), requestId: 'b'.repeat(22),
  }, {
    managedObjects: new Map(), addOrUpdateObject: () => {}, broadcast: () => {},
    fetchImpl: async (url) => String(url).endsWith('scene.json')
      ? response({ url: String(url), body: remoteDocument })
      : (() => { throw new TypeError('Failed to fetch'); })(),
    serverFetchImpl: async (url) => {
      serverCalls.push(String(url));
      if (String(url).endsWith('/import-jobs')) return response({ url: String(url), body: { jobId: 'a'.repeat(32), token: 'token', digest: 'digest', sessionId: 'a'.repeat(22), requestId: 'b'.repeat(22), sceneDocument: remoteDocument } });
      return response({ url: String(url), body: { sceneDocument: stagedDocument, cleanup: { jobId: 'a'.repeat(32), token: 'cleanup', sessionId: 'a'.repeat(22), requestId: 'b'.repeat(22) } } });
    },
  });
  strictEqual(result.handled, true);
  strictEqual(serverCalls.length, 2);
});

test('URL handoff does not server-pull an HTTP-denied referenced asset', async () => {
  let serverCalls = 0;
  await rejects(
    () => applySceneSyncHandoffUrl({ sourceUrl: 'https://denied.example/world/scene.json', sessionId: 'a'.repeat(22), requestId: 'b'.repeat(22) }, {
      managedObjects: new Map(),
      fetchImpl: async (url) => String(url).endsWith('scene.json')
        ? response({ url: String(url), body: { format: 'scene-sync-export-scene', version: 2, objects: [{ id: 'denied-asset', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], asset: { type: 'image', path: 'assets/poster.png' } }] } })
        : response({ url: String(url), body: 'denied', ok: false, status: 403 }),
      serverFetchImpl: async () => { serverCalls += 1; throw new Error('must not call'); },
    }),
    (error) => error.code === 'handoff-remote-asset-http-error' || error.code === 'handoff-url-import-failed',
  );
  strictEqual(serverCalls, 0);
});

test('URL handoff bridges a pre-aborted external signal into direct fetch without mutation', async () => {
  const external = new AbortController(); external.abort();
  let fetches = 0; let mutations = 0;
  await rejects(
    () => applySceneSyncHandoffUrl({ sourceUrl: 'https://abort.test/scene.json', sessionId: 'a'.repeat(22), requestId: 'b'.repeat(22) }, {
      signal: external.signal, managedObjects: new Map(), addOrUpdateObject: () => { mutations += 1; },
      fetchImpl: async (_url, { signal }) => { fetches += 1; if (signal.aborted) throw new Error('aborted'); throw new Error('unexpected'); },
    }),
    (error) => error.code === 'handoff-url-timeout',
  );
  strictEqual(fetches, 1);
  strictEqual(mutations, 0);
});

test('URL handoff external abort cancels pending direct and server-pull fetches without late apply', async () => {
  const pending = async (run) => {
    const external = new AbortController(); let observed = null; let mutations = 0;
    const promise = run(external, (signal) => new Promise((_resolve, reject) => {
      observed = signal; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }), () => { mutations += 1; });
    await new Promise((resolve) => setTimeout(resolve, 0)); external.abort();
    await rejects(() => promise, (error) => error.code === 'handoff-url-timeout');
    strictEqual(observed.aborted, true); strictEqual(mutations, 0);
  };
  await pending((external, wait, mutate) => applySceneSyncHandoffUrl({ sourceUrl: 'https://direct.test/scene.json', sessionId: 'a'.repeat(22), requestId: 'b'.repeat(22) }, {
    signal: external.signal, managedObjects: new Map(), addOrUpdateObject: mutate, fetchImpl: (_url, { signal }) => wait(signal),
  }));
  await pending((external, wait, mutate) => applySceneSyncHandoffUrl({ sourceUrl: 'https://opaque.test/scene.json', sessionId: 'a'.repeat(22), requestId: 'b'.repeat(22) }, {
    signal: external.signal, managedObjects: new Map(), addOrUpdateObject: mutate,
    fetchImpl: async () => { throw new TypeError('opaque'); }, serverFetchImpl: (_url, { signal }) => wait(signal),
  }));
});

test('direct URL import confirms before fetching assets', async () => {
  let assetFetches = 0;
  const result = await tryOpenSceneSyncExportUrl('https://example.com/world/scene.json', {
    managedObjects: new Map(),
    confirmOpen: () => false,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/scene.json')) return response({ url: String(url), body: {
        format: 'scene-sync-export-scene', version: 2,
        objects: [{ id: 'cancel', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], asset: { type: 'image', path: 'assets/a.png' } }],
      } });
      assetFetches += 1;
      return response({ url: String(url), body: 'asset' });
    },
  });
  strictEqual(result.cancelled, true);
  strictEqual(assetFetches, 0);
});

test('handoff final guards preserve peer objects added during image upload or GLB load', async () => {
  const base = {
    position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
  };

  const imageRemote = { owner: 'peer-image' };
  const imageObjects = new Map();
  const imageCalls = { adds: 0, broadcasts: 0, uploads: 0 };
  await rejects(
    () => applySceneSyncHandoffPayload({
      sceneDocument: {
        format: 'scene-sync-export-scene', version: 2,
        objects: [{ ...base, id: 'raced-image', asset: { type: 'image', path: 'assets/race.png' } }],
      },
      embeddedAssets: { 'assets/race.png': { mime: 'image/png', base64: 'AQ==' } },
    }, {
      managedObjects: imageObjects,
      addOrUpdateObject: () => { imageCalls.adds += 1; },
      broadcast: () => { imageCalls.broadcasts += 1; },
      uploadBlobToStore: async () => {
        imageCalls.uploads += 1;
        imageObjects.set('raced-image', imageRemote);
        return { url: 'https://blob.test/race.png', mime: 'image/png' };
      },
    }),
    (error) => error.code === 'handoff-object-id-conflict',
  );
  strictEqual(imageCalls.uploads, 1);
  strictEqual(imageCalls.adds, 0);
  strictEqual(imageCalls.broadcasts, 0);
  strictEqual(imageObjects.get('raced-image'), imageRemote);

  const glbRemote = { owner: 'peer-glb' };
  const glbObjects = new Map();
  const glbCalls = { mutations: 0, broadcasts: 0, uploads: 0, loads: 0 };
  await rejects(
    () => applySceneSyncHandoffPayload({
      sceneDocument: {
        format: 'scene-sync-export-scene', version: 2,
        objects: [{ ...base, id: 'raced-glb', asset: { type: 'mesh', path: 'assets/race.glb' } }],
      },
      embeddedAssets: { 'assets/race.glb': { mime: 'model/gltf-binary', base64: 'Z2xi' } },
    }, {
      managedObjects: glbObjects,
      addOrUpdateObject: () => { glbCalls.mutations += 1; },
      broadcast: () => { glbCalls.broadcasts += 1; },
      uploadBlobToStore: async () => { glbCalls.uploads += 1; },
      importGlbFileAsSceneObject: async (_file, options) => {
        glbCalls.loads += 1;
        await Promise.resolve();
        glbObjects.set('raced-glb', glbRemote);
        options.beforeCommit();
        glbCalls.mutations += 1;
        glbCalls.broadcasts += 1;
        glbCalls.uploads += 1;
      },
    }),
    (error) => error.code === 'handoff-object-id-conflict',
  );
  strictEqual(glbCalls.loads, 1);
  strictEqual(glbCalls.mutations, 0);
  strictEqual(glbCalls.broadcasts, 0);
  strictEqual(glbCalls.uploads, 0);
  strictEqual(glbObjects.get('raced-glb'), glbRemote);
});

test('handoff rolls back earlier own objects after a later asset failure without deleting a peer replacement', async () => {
  const managedObjects = new Map();
  const broadcasts = [];
  const own = { owner: 'handoff' };
  const peer = { owner: 'peer' };
  await rejects(
    () => applySceneSyncHandoffPayload({
      sceneDocument: {
        format: 'scene-sync-export-scene', version: 2,
        objects: [
          { id: 'first', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], asset: { type: 'primitive', primitive: 'box' } },
          { id: 'later', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], asset: { type: 'image', path: 'assets/fail.png' } },
        ],
      },
      embeddedAssets: { 'assets/fail.png': { mime: 'image/png', base64: 'AQ==' } },
    }, {
      managedObjects,
      addOrUpdateObject: (id) => managedObjects.set(id, own),
      broadcast: (payload) => broadcasts.push(payload),
      uploadBlobToStore: async () => {
        managedObjects.set('first', peer);
        throw new Error('late upload failed');
      },
      rollbackImportedObject: (id, expected) => {
        if (managedObjects.get(id) !== expected) return false;
        managedObjects.delete(id);
        broadcasts.push({ kind: 'scene-remove', objectId: id });
        return true;
      },
    }),
  );
  strictEqual(managedObjects.get('first'), peer);
  strictEqual(broadcasts.some((entry) => entry.kind === 'scene-remove'), false);
});

test('handoff rollback removes its own earlier object in reverse failure cleanup', async () => {
  const managedObjects = new Map();
  const own = { owner: 'handoff' };
  const removes = [];
  await rejects(() => applySceneSyncHandoffPayload({
    sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [
      { id: 'first-own', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], asset: { type: 'primitive', primitive: 'box' } },
      { id: 'later-fail', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], asset: { type: 'image', path: 'assets/fail.png' } },
    ] },
    embeddedAssets: { 'assets/fail.png': { mime: 'image/png', base64: 'AQ==' } },
  }, {
    managedObjects,
    addOrUpdateObject: (id) => managedObjects.set(id, own),
    broadcast: () => {},
    uploadBlobToStore: async () => { throw new Error('late upload failed'); },
    rollbackImportedObject: (id, expected) => {
      if (managedObjects.get(id) !== expected) return false;
      managedObjects.delete(id); removes.push(id); return true;
    },
  }));
  strictEqual(managedObjects.has('first-own'), false);
  deepStrictEqual(removes, ['first-own']);
});

test('handoff records before broadcast and rolls back a broadcast failure', async () => {
  const managedObjects = new Map();
  const own = { owner: 'handoff' };
  let rollbacks = 0;
  await rejects(() => applySceneSyncHandoffPayload({
    sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [{
      id: 'broadcast-fail', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      asset: { type: 'primitive', primitive: 'box' },
    }] }, embeddedAssets: {},
  }, {
    managedObjects,
    addOrUpdateObject: (id) => managedObjects.set(id, own),
    broadcast: () => { throw new Error('socket failed'); },
    rollbackImportedObject: (id, expected) => {
      if (managedObjects.get(id) !== expected) return false;
      managedObjects.delete(id); rollbacks += 1; return true;
    },
  }));
  strictEqual(managedObjects.has('broadcast-fail'), false);
  strictEqual(rollbacks, 1);
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
  strictEqual(toasts[0], 'Single HTML Exportを取得できませんでした。ネットワークを確認し、公開元でCORSを許可してください。');
});

test('shows an HTTP status instead of a CORS instruction for unavailable Single HTML URLs', async () => {
  const toasts = [];
  const result = await tryOpenSceneSyncExportUrl('https://cdn.example.com/missing.html', {
    managedObjects: new Map(),
    fetchImpl: createFetch({
      'https://cdn.example.com/missing.html': { body: 'not found', ok: false, status: 404 },
    }),
    showToast: (message) => toasts.push(message),
  });
  strictEqual(result.handled, true);
  strictEqual(result.error, 'single-html-http-error');
  strictEqual(result.status, 404);
  strictEqual(toasts[0], 'Single HTML Exportを取得できませんでした（HTTP 404）。URLを確認してください。');
});

test('disposes preview Blob URLs when applying a Single HTML import fails', async () => {
  const html = await buildSingleHtmlDocument({
    sceneDocument: {
      format: 'scene-sync-export-scene', version: 2,
      objects: [{
        id: 'preview-failure', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        asset: { type: 'image', path: 'assets/poster.png', mime: 'image/png' },
      }],
    },
    manifest: {},
    files: { 'assets/poster.png': new Uint8Array([1]).buffer },
    viewerFiles: {},
  });
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const revoked = [];
  let calls = 0;
  URL.createObjectURL = () => 'blob:preview-failure';
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    await rejects(() => tryOpenSceneSyncExportFile({
      name: 'preview-failure.html', type: 'text/html', text: async () => html,
    }, {
      managedObjects: new Map(),
      confirmOpen: () => true,
      addOrUpdateObject: () => {
        calls += 1;
        if (calls > 1) throw new Error('apply failure');
      },
      broadcast() {},
    }), /apply failure/);
    deepStrictEqual(revoked, ['blob:preview-failure']);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});
