// Guards the committed conversion bundle.
//
// Everything else in this directory tests the source. The browser only ever
// runs html/assets/vendor/splat-transform/<version>/, so these check that the
// artifact in the tree is present, current, self-contained, and still able to
// convert every format SceneSync claims to accept.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { inspectGaussianSplatGlb } from '../khr-gaussian-splatting.js';
import {
  loadVendoredSplatBundle,
  pinnedSplatTransformVersion,
  vendoredBundlePath,
} from '../../../../../../scripts/lib/load-vendored-splat-bundle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../../..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'html/scenesync/experiments/fixtures');

const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, name)));

test('@playcanvas/splat-transform is pinned to an exact version', async () => {
  const pinned = await pinnedSplatTransformVersion();
  assert.match(pinned, /^\d+\.\d+\.\d+$/);

  const installed = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, 'node_modules/@playcanvas/splat-transform/package.json'),
    'utf8',
  )).version;
  assert.equal(installed, pinned, 'run npm ci to match the pin');
});

test('the loader points at the version that is pinned', async () => {
  const pinned = await pinnedSplatTransformVersion();
  const source = fs.readFileSync(path.join(HERE, 'gaussian-splat-worker-import.js'), 'utf8');

  assert.ok(
    source.includes(`vendor/splat-transform/${pinned}/`),
    `gaussian-splat-worker-import.js must load the vendored bundle for ${pinned}`,
  );
});

test('the bundle and its wasm are committed', async () => {
  const bundlePath = await vendoredBundlePath();
  assert.ok(fs.existsSync(bundlePath), `missing ${bundlePath}; run npm run build:gaussian-splat-worker`);
  assert.ok(fs.existsSync(path.join(path.dirname(bundlePath), 'webp.wasm')), 'SOG decoding needs webp.wasm');
});

test('the bundle reaches for nothing at runtime', async () => {
  const source = fs.readFileSync(await vendoredBundlePath(), 'utf8');

  for (const host of ['cdn.jsdelivr', 'unpkg.com', 'rawcdn.githack', 'esm.sh']) {
    assert.ok(!source.includes(host), `the bundle must not reference ${host}`);
  }
  assert.ok(
    !/\bfrom\s*["']@playcanvas\//.test(source),
    'the bundle must not leave a bare specifier for a browser to resolve',
  );
});

for (const [name, sourceFormat] of [
  ['ring-gaussian-splats.ply', 'ply'],
  ['ring-gaussian-splats.spz', 'spz'],
  ['ring-gaussian-splats.sog', 'sog'],
  ['ring-gaussian-splats.lcc2.zip', 'lcc2'],
]) {
  test(`the vendored bundle converts ${sourceFormat.toUpperCase()}`, async () => {
    const bundle = await loadVendoredSplatBundle();
    const result = await bundle.convertGaussianSplatToGlb(fixture(name), { fileName: name });

    assert.equal(result.sourceFormat, sourceFormat);
    assert.equal(result.splatCount, 16);
    assert.equal(inspectGaussianSplatGlb(result.glb).valid, true);
  });
}

test('the vendored bundle installs no message listener outside a Worker', async () => {
  const bundle = await loadVendoredSplatBundle();
  assert.equal(typeof bundle.convertGaussianSplatToGlb, 'function');
  assert.equal(typeof bundle.handleConversionMessage, 'function');
  assert.equal(typeof globalThis.onmessage, 'undefined');
});
