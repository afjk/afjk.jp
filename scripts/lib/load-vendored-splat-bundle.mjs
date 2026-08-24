// Loads the vendored Gaussian Splat conversion bundle under Node.
//
// The bundle is built for a browser Worker: it has no Node file access, and its
// WebP decoder fetches webp.wasm over the network. Running it outside a browser
// therefore needs the two browser facilities it actually uses — a global that
// marks the scope as a Worker, and a `fetch` that can serve the wasm sitting
// next to the bundle on disk.
//
// This exists so the committed bundle can be exercised by the build's own
// verification pass and by the Node tests, rather than only by the browser
// smoke test. It emulates the browser; it does not change the bundle.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const VENDOR_ROOT = path.join(repoRoot, 'html/assets/vendor/splat-transform');

/** The pinned splat-transform version, and so the vendor directory to use. */
export async function pinnedSplatTransformVersion() {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const pinned = pkg.dependencies?.['@playcanvas/splat-transform'];
  if (!pinned) throw new Error('package.json does not depend on @playcanvas/splat-transform');
  if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
    throw new Error(`@playcanvas/splat-transform must be pinned to an exact version, got "${pinned}"`);
  }
  return pinned;
}

export async function vendoredBundlePath() {
  return path.join(VENDOR_ROOT, await pinnedSplatTransformVersion(), 'gaussian-splat-import.worker.js');
}

let installed = false;

/** Give the bundle the two browser facilities it needs, once per process. */
function installBrowserShims() {
  if (installed) return;
  installed = true;

  // Emscripten reads this to decide it is in a Worker, and so to use fetch
  // rather than Node's fs. Nothing in SceneSync's own code keys off it: the
  // Worker entry also requires `self`, which Node does not define.
  if (typeof globalThis.WorkerGlobalScope === 'undefined') {
    globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
  }

  const upstream = globalThis.fetch;
  globalThis.fetch = async (resource, init) => {
    const url = typeof resource === 'string' ? resource : resource?.url ?? String(resource);
    if (!url.startsWith('file:')) return upstream(resource, init);
    const bytes = await fs.readFile(fileURLToPath(url));
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/wasm' } });
  };
}

/**
 * Import the committed bundle.
 *
 * @param {Object} [options]
 * @param {string} [options.bundlePath] override the path (used right after a build)
 * @param {boolean} [options.fresh] bypass the module cache
 */
export async function loadVendoredSplatBundle(options = {}) {
  installBrowserShims();
  const target = options.bundlePath ?? await vendoredBundlePath();
  const href = pathToFileURL(target).href;
  return import(options.fresh ? `${href}?built=${Date.now()}` : href);
}
