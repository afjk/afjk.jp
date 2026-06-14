import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExportPackage } from './build-export-package.js';

function vec(values) {
  return { toArray: () => [...values] };
}

function createManagedObjects() {
  return new Map([
    ['box', {
      name: 'Box',
      visible: true,
      position: vec([0, 0, 0]),
      quaternion: vec([0, 0, 0, 1]),
      scale: vec([1, 1, 1]),
      userData: {
        name: 'Box',
        asset: {
          type: 'primitive',
          primitive: 'box',
          color: '#4488ff',
        },
      },
    }],
  ]);
}

function createMockCanvas() {
  const context = {
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect() {},
    fillText() {},
    measureText(text) {
      return { width: String(text).length * 20 };
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
  };
  return {
    width: 0,
    height: 0,
    getContext(type) {
      return type === '2d' ? context : null;
    },
    toBlob(callback, type) {
      callback(new Blob(['thumbnail'], { type }));
    },
  };
}

test('builds export ZIP with generated root thumbnail', async () => {
  const original = {
    JSZip: globalThis.JSZip,
    fetch: globalThis.fetch,
    document: globalThis.document,
    URL: globalThis.URL,
    setTimeout: globalThis.setTimeout,
  };
  const zipFiles = new Map();

  class MockJSZip {
    file(name, content) {
      zipFiles.set(name, content);
      return this;
    }

    async generateAsync() {
      return new Blob(['zip'], { type: 'application/zip' });
    }
  }

  try {
    globalThis.JSZip = MockJSZip;
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => 'export default {};',
    });
    globalThis.document = {
      createElement(tagName) {
        if (tagName === 'canvas') return createMockCanvas();
        return {
          href: '',
          download: '',
          click() {},
        };
      },
      body: {
        appendChild() {},
        removeChild() {},
      },
      head: {
        appendChild() {},
      },
    };
    globalThis.URL = {
      createObjectURL() {
        return 'blob:scene-sync-export-test';
      },
      revokeObjectURL() {},
    };
    globalThis.setTimeout = (callback) => {
      callback();
      return 0;
    };

    await buildExportPackage({
      managedObjects: createManagedObjects(),
      bgmState: null,
      envId: null,
      blobBase: '',
      envOrigin: 'https://example.test',
      behaviorState: null,
      physicsState: null,
    });

    assert(zipFiles.has('scene.json'));
    assert(zipFiles.has('manifest.json'));
    assert(zipFiles.has('thumbnail.png'));
    assert.equal(zipFiles.get('thumbnail.png').type, 'image/png');
  } finally {
    globalThis.JSZip = original.JSZip;
    globalThis.fetch = original.fetch;
    globalThis.document = original.document;
    globalThis.URL = original.URL;
    globalThis.setTimeout = original.setTimeout;
  }
});
