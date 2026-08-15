import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerPullImporter, isPublicIp } from '../src/scenesync/server-pull-import.mjs';

const scene = {
  format: 'scene-sync-export-scene', version: 2,
  objects: [{ id: 'large-mesh', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], asset: { type: 'mesh', path: 'assets/model.glb' } },
    { id: 'text', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], asset: { type: 'text', path: 'assets/note.txt' } }],
};

function response(body, headers = {}, status = 200) {
  return new Response(body, { status, headers });
}

test('streams a CORS-independent static export into local storage without base64', async () => {
  const saved = [];
  const large = new Uint8Array(2 * 1024 * 1024).fill(7);
  const importer = createServerPullImporter({
    allowHttpForTests: true,
    resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async (url) => {
      if (url.endsWith('/world/')) return response('<link rel="scene-sync-export" href="scene.json">', { 'content-type': 'text/html' });
      if (url.endsWith('/world/scene.json')) return response(JSON.stringify(scene), { 'content-type': 'application/json' });
      if (url.endsWith('model.glb')) return response(large, { 'content-type': 'model/gltf-binary' });
      return response('hello', { 'content-type': 'text/plain' });
    },
    storeAsset: async ({ id, body, mime, maxBytes }) => {
      let bytes = 0;
      for await (const chunk of body) bytes += chunk.length;
      assert(bytes <= maxBytes);
      saved.push({ id, bytes, mime });
      return { id, size: bytes, mime, url: `/presence/blob/${id}` };
    },
  });
  const result = await importer('http://publisher.example/world/');
  assert.equal(saved.length, 2);
  assert.equal(saved[0].bytes, large.byteLength);
  assert.equal(result.sceneDocument.objects[0].asset.source, 'carrier');
  assert.equal(result.sceneDocument.objects[0].asset.meshPath, saved[0].id);
  assert.equal(result.sceneDocument.objects[1].asset.source, 'url');
  assert.match(result.sceneDocument.objects[1].asset.url, /^\/presence\/blob\//u);
});

test('rejects private DNS answers and cross-origin redirects before a body is exposed', async () => {
  const importer = createServerPullImporter({
    allowHttpForTests: true,
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => { throw new Error('must not fetch'); },
    storeAsset: async () => { throw new Error('must not store'); },
  });
  await assert.rejects(importer('http://blocked.example/world/'), { code: 'handoff-ssrf-blocked' });

  const redirected = createServerPullImporter({
    allowHttpForTests: true,
    resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async () => response('', { location: 'http://other.example/x' }, 302),
    storeAsset: async () => { throw new Error('must not store'); },
  });
  await assert.rejects(redirected('http://publisher.example/world/'), { code: 'handoff-cross-origin-redirect' });
});

test('inspects directory scene.json and current.json version paths without fetching assets', async () => {
  const calls = [];
  const importer = createServerPullImporter({
    allowHttpForTests: true,
    resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('/world/')) return response('<html>world</html>', { 'content-type': 'text/html' });
      if (url.endsWith('/world/scene.json')) return response('missing', {}, 404);
      if (url.endsWith('/world/current.json')) return response(JSON.stringify({ versionPath: 'versions/immutable/' }));
      if (url.endsWith('/world/versions/immutable/scene.json')) return response(JSON.stringify(scene));
      throw new Error(`unexpected ${url}`);
    },
    storeAsset: async () => { throw new Error('inspect must not stream assets'); },
  });
  const inspected = await importer.inspect('http://publisher.example/world/');
  assert.equal(inspected.sceneDocument.objects.length, 2);
  assert.equal(calls.some((url) => url.endsWith('model.glb')), false);
});

test('conservatively blocks private, mapped, transition, and reserved IPv6 ranges', () => {
  for (const value of ['127.0.0.1', '10.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:c0a8:1', '64:ff9b::808:808', '100::1', '2001:0::1', '2001:10::1', '2001:20::1', '2002:0808:0808::1', '2001:db8::1', '3fff::1', '4000::1', '5f00::1', '8000::1', 'f000::1', 'ff00::1']) {
    assert.equal(isPublicIp(value), false, value);
  }
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});

test('destroys a declared oversized document response before rejecting', async () => {
  let destroyed = false;
  const oversized = {
    status: 200,
    headers: { get: (name) => name === 'content-length' ? String(11 * 1024 * 1024) : name === 'content-type' ? 'application/json' : '' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); },
    destroy() { destroyed = true; },
  };
  const importer = createServerPullImporter({
    allowHttpForTests: true,
    resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async () => oversized,
    storeAsset: async () => { throw new Error('must not store'); },
  });
  await assert.rejects(importer.inspect('http://publisher.example/world/'), { code: 'handoff-document-too-large' });
  assert.equal(destroyed, true);
});
