// The drop path a Gaussian Splat capture actually takes through the editor.
//
// The converter has its own tests, but they cannot see the thing that decides
// whether it is ever reached: `handleFile()` offers every ZIP to the Scene Sync
// Export importer first. A zipped LCC2 capture therefore only works if that
// importer declines the ZIPs that are not exports — which is what this covers,
// with both real implementations in place.
//
// Browser-only dependencies are stubbed for the duration of this file: three,
// which `drag-drop-manager.js` reaches through its GLB loader and which is a
// CDN import rather than a dependency here, and JSZip, which the export
// importer injects from a CDN at runtime. The stubs stand in for the
// environment, not for the logic under test.

import { registerHooks } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const THREE_STUB = `
  export class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    toArray() { return [this.x, this.y, this.z]; }
    clone() { return new Vector3(this.x, this.y, this.z); }
  }
  export class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
  export class Raycaster {
    ray = { at: (_distance, target) => target };
    setFromCamera() {}
    intersectObjects() { return []; }
  }
  export class Quaternion { toArray() { return [0, 0, 0, 1]; } }
  export class GLTFLoader {}
  export class GLTFGaussianSplatLoaderExtension {}
  export class DRACOLoader {}
`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'three' || specifier.startsWith('three/')) {
      return { url: `three-stub:${specifier}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('three-stub:')) {
      return { format: 'module', source: THREE_STUB, shortCircuit: true };
    }
    return next(url, context);
  },
});

// No Worker in Node, so the editor's inline fallback loads the vendored bundle
// directly. It is built for a browser Worker, so it needs the same environment.
const { installBrowserShims } = await import('../../../../../scripts/lib/load-vendored-splat-bundle.mjs');
installBrowserShims();

const { DragDropManager } = await import('./drag-drop-manager.js');
const { tryOpenSceneSyncExportFile } = await import('../importers/scene-sync-export/index.js');
const { inspectGaussianSplatGlb } = await import('../loaders/khr-gaussian-splatting.js');

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../scenesync/experiments/fixtures',
);

function fixtureFile(name, as = name) {
  return new File([fs.readFileSync(path.join(FIXTURE_DIR, name))], as);
}

/**
 * Stand in for the CDN-loaded JSZip with a fixed set of entries.
 *
 * The only thing the export importer asks a ZIP is whether it holds a
 * `scene.json`; a capture archive does not, which is the case that has to fall
 * through to the Gaussian Splat importer.
 */
function installJSZip(entries = {}) {
  globalThis.JSZip = {
    async loadAsync() {
      return {
        file(name) {
          if (!(name in entries)) return null;
          return { async async() { return entries[name]; } };
        },
      };
    },
  };
}

function uninstallJSZip() {
  delete globalThis.JSZip;
}

/**
 * A DragDropManager with only what `handleFile` touches: no DOM, no three, and
 * a GLB loader that records what it was handed instead of parsing it.
 */
function createManager(overrides = {}) {
  const toasts = [];
  const loaded = [];

  const manager = new DragDropManager({
    container: { addEventListener() {}, removeEventListener() {} },
    camera: {},
    renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) } },
    scene: {},
    showToast: (message) => toasts.push(message),
    glbLoader: {
      async loadFromFile(file, position) {
        loaded.push({ file, position });
        return { userData: {} };
      },
    },
    sceneSyncExportImporter: (file, context) => tryOpenSceneSyncExportFile(file, {
      ...context,
      showToast: (message) => toasts.push(message),
    }),
    ...overrides,
  });

  return { manager, toasts, loaded };
}

const dropAt = { position: { toArray: () => [0, 0, 0] }, targetKind: 'scene' };

test('a zipped LCC2 capture dropped on the editor becomes a GLB object', async (t) => {
  installJSZip(); // an archive with no scene.json
  t.after(uninstallJSZip);

  const { manager, loaded } = createManager();

  const model = await manager.handleFile(fixtureFile('ring-gaussian-splats.lcc2.zip'), dropAt);

  assert.ok(model, 'the drop should produce an object');
  assert.equal(loaded.length, 1, 'the converted GLB should reach the ordinary GLB loader');

  const [{ file }] = loaded;
  assert.equal(file.name, 'ring-gaussian-splats.lcc2.glb');
  assert.equal(file.type, 'model/gltf-binary');
  assert.equal(inspectGaussianSplatGlb(new Uint8Array(await file.arrayBuffer())).valid, true);

  // The object keeps the name of what was dropped, not what was uploaded.
  assert.equal(model.userData.name, 'ring-gaussian-splats.lcc2.zip');
  assert.equal(model.userData.importedFrom.fileName, 'ring-gaussian-splats.lcc2.zip');
  assert.equal(model.userData.importedFrom.convertedTo, 'ring-gaussian-splats.lcc2.glb');
  assert.equal(model.userData.importedFrom.sourceFormat, 'lcc2');
});

test('a Scene Sync Export ZIP still belongs to the export importer', async (t) => {
  installJSZip({ 'scene.json': JSON.stringify({ version: 1, objects: [] }) });
  t.after(uninstallJSZip);

  const claimed = [];
  const { manager, loaded } = createManager({
    sceneSyncExportImporter: async (file, context) => {
      const result = await tryOpenSceneSyncExportFile(file, context);
      claimed.push(result.handled);
      return { handled: true };
    },
  });

  const result = await manager.handleFile(new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'export.zip'), dropAt);

  assert.equal(result, null, 'the export importer owns the drop');
  assert.equal(loaded.length, 0, 'it must not also be converted as a splat');
  assert.deepEqual(claimed, [true], 'a ZIP holding scene.json is still claimed');
});

test('a .sog capture takes the same path', async () => {
  const { manager, loaded } = createManager();

  const model = await manager.handleFile(fixtureFile('ring-gaussian-splats.sog'), dropAt);

  assert.ok(model);
  assert.equal(loaded[0].file.name, 'ring-gaussian-splats.glb');
  assert.equal(model.userData.importedFrom.sourceFormat, 'sog');
});

test('a ZIP that is neither an export nor a capture is reported, not loaded', async (t) => {
  installJSZip();
  t.after(uninstallJSZip);

  const { manager, loaded, toasts } = createManager();

  // A valid, readable but empty ZIP: end-of-central-directory record only.
  const empty = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  const result = await manager.handleFile(new File([empty], 'notes.zip'), dropAt);

  assert.equal(result, null);
  assert.equal(loaded.length, 0);
  assert.ok(toasts.length > 0, 'the user should be told why nothing happened');
});

test('a capture that is not a ZIP is never offered to the export importer', async () => {
  const seen = [];
  const { manager, loaded } = createManager({
    sceneSyncExportImporter: (file) => {
      seen.push(file.name);
      return { handled: false };
    },
  });

  await manager.handleFile(fixtureFile('ring-gaussian-splats.ply'), dropAt);

  assert.deepEqual(seen, []);
  assert.equal(loaded[0].file.name, 'ring-gaussian-splats.glb');
});
