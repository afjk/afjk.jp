import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeSceneDocumentUrlAssets } from './materialize-url-assets.js';

const base = 'https://static.example/v1/scene.json';
const object = (asset) => ({ id: 'a', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], asset });

function fetcher(routes) {
  return async (url, options) => {
    assert.equal(options.credentials, 'omit');
    const value = routes[String(url)];
    if (!value) return new Response('missing', { status: 404 });
    return new Response(value.body, { status: value.status || 200, headers: value.headers });
  };
}

test('materializes relative assets into ZIP-compatible entries and removes remote URLs', async () => {
  const result = await materializeSceneDocumentUrlAssets({
    objects: [object({ type: 'image', path: 'assets/poster.png' })],
  }, { baseUrl: base, fetchImpl: fetcher({
    'https://static.example/v1/assets/poster.png': { body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'image/png' } },
  }) });
  assert.equal(result.document.objects[0].asset.path, 'assets/poster.png');
  assert.equal(result.document.objects[0].asset.url, undefined);
  assert.deepEqual([...new Uint8Array(await result.zip.file('assets/poster.png').async('arraybuffer'))], [1, 2, 3]);
});

test('rejects unsafe paths, credential URLs, collision, HTTP failure and real-byte oversize', async () => {
  await assert.rejects(
    materializeSceneDocumentUrlAssets({ objects: [object({ type: 'image', path: '../escape.png' })] }, { baseUrl: base, fetchImpl: fetcher({}) }),
    { code: 'handoff-unsafe-asset-path' },
  );
  await assert.rejects(
    materializeSceneDocumentUrlAssets({ objects: [object({ type: 'image', path: 'https://other.example/asset.png' })] }, { baseUrl: base, fetchImpl: fetcher({}) }),
    { code: 'handoff-unsafe-asset-path' },
  );
  await assert.rejects(
    materializeSceneDocumentUrlAssets({ objects: [object({ type: 'image', url: 'https://user:secret@static.example/a.png' })] }, { baseUrl: base, fetchImpl: fetcher({}) }),
    { code: 'handoff-invalid-asset-url' },
  );
  await assert.rejects(
    materializeSceneDocumentUrlAssets({ objects: [
      object({ type: 'image', path: 'assets/a.png', url: 'https://static.example/one.png' }),
      { ...object({ type: 'image', path: 'assets/a.png', url: 'https://static.example/two.png' }), id: 'b' },
    ] }, { baseUrl: base, fetchImpl: fetcher({ 'https://static.example/v1/assets/a.png': { body: 'a' } }) }),
    { code: 'handoff-remote-asset-path-collision' },
  );
  await assert.rejects(
    materializeSceneDocumentUrlAssets({ objects: [object({ type: 'image', path: 'missing.png' })] }, { baseUrl: base, fetchImpl: fetcher({}) }),
    { code: 'handoff-remote-asset-http-error' },
  );
  await assert.rejects(
    materializeSceneDocumentUrlAssets({ objects: [object({ type: 'image', path: 'large.png' })] }, {
      baseUrl: base, fetchImpl: fetcher({ 'https://static.example/v1/large.png': { body: new Uint8Array(9) } }), limits: { maxAssetBytes: 8 },
    }),
    { code: 'handoff-remote-asset-too-large' },
  );
});
