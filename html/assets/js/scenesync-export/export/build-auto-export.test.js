import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoExport } from './build-auto-export.js';
import { SINGLE_HTML_VIEWER_SOURCES } from './export-preparation.js';

function vec(values) { return { toArray: () => values }; }

test('Auto prepares viewer files once and reports its selected format, estimate and reason', async () => {
  const original = {
    fetch: globalThis.fetch, JSZip: globalThis.JSZip, document: globalThis.document,
    URL: globalThis.URL, setTimeout: globalThis.setTimeout,
  };
  let fetches = 0;
  try {
    globalThis.fetch = async () => {
      fetches += 1;
      return { ok: true, text: async () => 'export default {};', arrayBuffer: async () => new ArrayBuffer(3), headers: { get: () => null } };
    };
    globalThis.JSZip = class { file() {} async generateAsync() { return new Blob(['zip']); } };
    globalThis.document = {
      createElement(name) {
        if (name === 'canvas') return {
          getContext: () => ({ fillRect() {}, fillText() {}, measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }) }),
          toBlob: (callback) => callback(new Blob(['thumbnail'], { type: 'image/png' })),
        };
        return { click() {} };
      },
      body: { appendChild() {}, removeChild() {} },
      head: { appendChild() {} },
    };
    globalThis.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
    globalThis.setTimeout = () => 0;
    const result = await buildAutoExport({
      format: 'static-zip', envOrigin: 'https://example.test', blobBase: '', envId: null, bgmState: null,
      managedObjects: new Map([['box', {
        name: 'Box', visible: true, position: vec([0, 0, 0]), quaternion: vec([0, 0, 0, 1]), scale: vec([1, 1, 1]),
        userData: { asset: { type: 'primitive', primitive: 'box' } },
      }]]),
    });
    assert.equal(result.selectedFormat, 'static-zip');
    assert.equal(result.fallbackReason, 'forced-static-zip');
    assert(result.estimatedBytes > 0);
    assert.equal(fetches, SINGLE_HTML_VIEWER_SOURCES.length, 'prepared viewer sources should not be fetched again by the selected builder');
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.JSZip = original.JSZip;
    globalThis.document = original.document;
    globalThis.URL = original.URL;
    globalThis.setTimeout = original.setTimeout;
  }
});
