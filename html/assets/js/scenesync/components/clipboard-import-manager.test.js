import test from 'node:test';
import assert from 'node:assert/strict';
import { ClipboardImportManager } from './clipboard-import-manager.js';
import { createSceneLifetime } from '../runtime/scene-lifetime.js';

for (const delayedStage of ['read', 'decode', 'readText']) {
  test(`clear during clipboard ${delayedStage} prevents import and fallback`, async (t) => {
    const lifetime = createSceneLifetime();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const delayed = async value => { markStarted(); await gate; return value; };
    let fallbackCalls = 0;
    const clipboard = delayedStage === 'readText'
      ? { readText: () => delayed('old text') }
      : {
        read: () => delayedStage === 'read' ? delayed([]) : Promise.resolve([{
          types: ['text/plain'],
          getType: () => delayed(new Blob(['old text'])),
        }]),
        readText: () => { fallbackCalls++; return Promise.resolve('fallback'); },
      };
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } });
    t.after(() => original
      ? Object.defineProperty(globalThis, 'navigator', original)
      : delete globalThis.navigator);
    const imports = [];
    const toasts = [];
    const manager = new ClipboardImportManager({
      container: new EventTarget(),
      captureWork: () => lifetime.capture(),
      assertWork: work => lifetime.assert(work),
      handleText: text => imports.push(text),
      showToast: text => toasts.push(text),
    });
    t.after(() => manager.dispose());
    const pending = manager.pasteFromNavigatorClipboard();
    await started;
    lifetime.invalidate();
    release();
    assert.equal(await pending, null);
    assert.deepEqual(imports, []);
    assert.deepEqual(toasts, []);
    assert.equal(fallbackCalls, 0);
  });
}
