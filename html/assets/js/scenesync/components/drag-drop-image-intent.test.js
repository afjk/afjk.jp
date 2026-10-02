import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

// These browser/CDN dependencies are not exercised by the image dispatch path.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'three' || specifier.startsWith('three/')) return { url: `three-stub:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('three-stub:')) return { format: 'module', shortCircuit: true,
      source: 'export class Vector3 {} export class GLTFLoader {} export class GLTFGaussianSplatLoaderExtension {} export class DRACOLoader {}' };
    return next(url, context);
  },
});
const { DragDropManager } = await import('./drag-drop-manager.js');

async function importImage(placement) {
  const calls = [];
  const manager = Object.create(DragDropManager.prototype);
  Object.assign(manager, {
    _defaultDropPosition: () => ({ toArray: () => [0, 1, 0] }),
    _getSurfaceKind: () => 'floor',
    getReplaceTargetForContent: () => { calls.push('replacement-lookup'); return 'selected-image'; },
    imageImporter: async (_file, _position, context) => { calls.push(context); },
    onLoadStart: async () => { calls.push('preview'); },
  });
  await manager.handleFile(new File(['image'], 'test.png', { type: 'image/png' }), {
    position: { toArray: () => [0, 1, 0] }, ...placement,
  });
  return calls;
}
test('explicit + addition bypasses selected/hit image replacement and preserves intent', async () => {
  const calls = await importImage({ importIntent: 'add', hitObjectId: 'selected-image' });
  assert.equal(calls.includes('replacement-lookup'), false);
  const context = calls.at(-1);
  assert.equal(context.importIntent, 'add');
  assert.equal(context.isReplacement, false);
  assert.ok(context.tempObjectId);
});
test('ordinary drops retain the selected/hit replacement path without a new preview', async () => {
  const calls = await importImage({ hitObjectId: 'selected-image' });
  assert.equal(calls.includes('replacement-lookup'), true);
  assert.equal(calls.includes('preview'), false);
  assert.equal(calls.at(-1).replaceTargetObjectId, 'selected-image');
  assert.equal(calls.at(-1).isReplacement, true);
});
test('explicit skybox placement still takes precedence over a new image addition', async () => {
  const calls = await importImage({ importIntent: 'add', upness: 0.8 });
  assert.equal(calls.at(-1).targetKind, 'sky');
  assert.equal(calls.includes('replacement-lookup'), false);
});
