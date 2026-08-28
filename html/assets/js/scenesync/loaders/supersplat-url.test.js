import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectSogManifestFiles,
  downloadSuperSplatSource,
  resolveSuperSplatScene,
} from './supersplat-url.js';

const SCENE_URL = 'https://superspl.at/scene/56155c3f';
const META_URL = 'https://d28zzqy0iyovbz.cloudfront.net/56155c3f/v1/meta.json';

function resolution(overrides = {}) {
  return {
    provider: 'supersplat',
    sceneId: '56155c3f',
    pageUrl: SCENE_URL,
    title: 'Lion',
    author: 'Example Artist',
    downloadable: true,
    license: { code: 'CC-BY-4.0', label: 'CC BY 4.0' },
    asset: { format: 'sog-meta', url: META_URL, revision: 'v1' },
    ...overrides,
  };
}

test('resolver receives the canonical URL and validates the Downloadable response', async () => {
  let requestedUrl = null;
  const resolved = await resolveSuperSplatScene('https://superspl.at/s?id=56155c3f&utm_source=x', {
    resolverEndpoint: 'https://resolver.example/api/supersplat',
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return new Response(JSON.stringify(resolution()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(requestedUrl.searchParams.get('url'), SCENE_URL);
  assert.equal(resolved.pageUrl, SCENE_URL);
  assert.equal(resolved.asset.format, 'sog-meta');
  assert.deepEqual(resolved.license, { code: 'CC-BY-4.0', label: 'CC BY 4.0' });
});

test('resolver reports the provider refusal instead of guessing an asset URL', async () => {
  await assert.rejects(
    () => resolveSuperSplatScene(SCENE_URL, {
      resolverEndpoint: 'https://resolver.example/api/supersplat',
      fetchImpl: async () => new Response(JSON.stringify({
        code: 'SUPERSPLAT_NOT_DOWNLOADABLE',
        error: 'ignored wording',
      }), { status: 403 }),
    }),
    (error) => error.code === 'SUPERSPLAT_NOT_DOWNLOADABLE'
      && /ダウンロードが許可されていない/.test(error.message),
  );
});

test('resolver refuses an asset URL outside the expected CDN hosts', async () => {
  await assert.rejects(
    () => resolveSuperSplatScene(SCENE_URL, {
      resolverEndpoint: 'https://resolver.example/api/supersplat',
      fetchImpl: async () => new Response(JSON.stringify(resolution({
        asset: { format: 'sog', url: 'https://evil.example/model.sog', revision: 'v1' },
      })), { status: 200 }),
    }),
    /未許可の配信先/,
  );
});

test('manifest file discovery preserves every SOG texture reference once', () => {
  assert.deepEqual(collectSogManifestFiles({
    means: { files: ['means_l.webp', 'means_u.webp'] },
    scales: { files: ['scales.webp'] },
    nested: [{ files: ['means_l.webp', 'sh0.webp'] }],
  }), ['means_l.webp', 'means_u.webp', 'scales.webp', 'sh0.webp']);
});

test('unbundled SOG is packaged with meta.json and its WebPs for the converter', async () => {
  const manifest = {
    version: 2,
    means: { files: ['means_l.webp', 'nested/means_u.webp'] },
    scales: { files: ['scales.webp'] },
  };
  const requested = [];

  class FakeZip {
    static latest = null;
    constructor() {
      this.entries = new Map();
      FakeZip.latest = this;
    }
    file(name, bytes) {
      this.entries.set(name, bytes);
    }
    async generateAsync() {
      return new Blob(['zip fixture']);
    }
  }

  const source = await downloadSuperSplatSource(resolution(), {
    JSZip: FakeZip,
    fetchImpl: async (url) => {
      requested.push(String(url));
      if (String(url) === META_URL) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    },
  });

  assert.equal(source.name, 'Lion.supersplat.zip');
  assert.deepEqual([...FakeZip.latest.entries.keys()], [
    'meta.json',
    'means_l.webp',
    'nested/means_u.webp',
    'scales.webp',
  ]);
  assert.deepEqual(requested, [
    META_URL,
    'https://d28zzqy0iyovbz.cloudfront.net/56155c3f/v1/means_l.webp',
    'https://d28zzqy0iyovbz.cloudfront.net/56155c3f/v1/nested/means_u.webp',
    'https://d28zzqy0iyovbz.cloudfront.net/56155c3f/v1/scales.webp',
  ]);
});

test('unbundled SOG cannot escape the manifest directory', async () => {
  await assert.rejects(
    () => downloadSuperSplatSource(resolution(), {
      JSZip: class {},
      fetchImpl: async () => new Response(JSON.stringify({ means: { files: ['../secret.webp'] } })),
    }),
    /不正なファイル名/,
  );
});

test('bundled SOG remains a SOG File and does not need JSZip', async () => {
  const source = await downloadSuperSplatSource(resolution({
    asset: {
      format: 'sog',
      url: 'https://d28zzqy0iyovbz.cloudfront.net/56155c3f/v1/model.sog',
      revision: 'v1',
    },
  }), {
    fetchImpl: async () => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 }),
  });

  assert.equal(source.name, 'Lion.sog');
  assert.equal(source.size, 4);
});
