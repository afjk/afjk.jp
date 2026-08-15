import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportPackage,
  EXPORT_THUMBNAIL_FILE_LIMIT_BYTES,
  generateExportIndexHtml,
} from './build-export-package.js';

test('Static ZIP viewer keeps its file:// warning separate from Single HTML playback', () => {
  const indexHtml = generateExportIndexHtml();

  assert.match(indexHtml, /location\.protocol === 'file:'/);
  assert.match(indexHtml, /file-protocol-warning/);
  assert.match(indexHtml, /python3 -m http\.server 8080/);
  assert.doesNotMatch(indexHtml, /__SCENE_SYNC_SINGLE_HTML_EXPORT__/);
});

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

async function withMockExportEnvironment(run) {
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
      arrayBuffer: async () => new ArrayBuffer(0),
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

    await run(zipFiles);
  } finally {
    globalThis.JSZip = original.JSZip;
    globalThis.fetch = original.fetch;
    globalThis.document = original.document;
    globalThis.URL = original.URL;
    globalThis.setTimeout = original.setTimeout;
  }
}

test('builds export ZIP with generated root thumbnail', async () => {
  await withMockExportEnvironment(async (zipFiles) => {
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
  });
});

test('builds export ZIP with metadata and custom root thumbnail', async () => {
  await withMockExportEnvironment(async (zipFiles) => {
    const thumbnail = new Blob(['custom-thumbnail'], { type: 'image/webp' });
    Object.defineProperty(thumbnail, 'name', { value: 'cover.webp' });

    await buildExportPackage({
      managedObjects: createManagedObjects(),
      bgmState: null,
      envId: null,
      blobBase: '',
      envOrigin: 'https://example.test',
      behaviorState: null,
      physicsState: null,
      exportMetadata: {
        title: 'Candy Rock Star',
        description: 'Unity-chan stage',
        tags: 'music, unity-chan, music',
        author: 'afjk',
        thumbnailFile: thumbnail,
      },
    });

    const sceneDocument = JSON.parse(zipFiles.get('scene.json'));
    const manifest = JSON.parse(zipFiles.get('manifest.json'));

    assert.equal(sceneDocument.title, 'Candy Rock Star');
    assert.equal(sceneDocument.description, 'Unity-chan stage');
    assert.deepEqual(sceneDocument.tags, ['music', 'unity-chan']);
    assert.equal(sceneDocument.author, 'afjk');
    assert.equal(manifest.title, 'Candy Rock Star');
    assert.equal(manifest.description, 'Unity-chan stage');
    assert.deepEqual(manifest.tags, ['music', 'unity-chan']);
    assert.equal(manifest.author, 'afjk');
    assert.equal(zipFiles.get('thumbnail.webp'), thumbnail);
    assert.equal(zipFiles.has('thumbnail.png'), false);
  });
});

test('omits blank export title so filename fallback remains available', async () => {
  await withMockExportEnvironment(async (zipFiles) => {
    await buildExportPackage({
      managedObjects: createManagedObjects(),
      bgmState: null,
      envId: null,
      blobBase: '',
      envOrigin: 'https://example.test',
      behaviorState: null,
      physicsState: null,
      exportMetadata: { title: '   ' },
    });

    const sceneDocument = JSON.parse(zipFiles.get('scene.json'));
    const manifest = JSON.parse(zipFiles.get('manifest.json'));
    assert.equal(Object.hasOwn(sceneDocument, 'title'), false);
    assert.equal(Object.hasOwn(manifest, 'title'), false);
  });
});

test('rejects oversized custom root thumbnail', async () => {
  await withMockExportEnvironment(async () => {
    const thumbnail = new Blob([
      new Uint8Array(EXPORT_THUMBNAIL_FILE_LIMIT_BYTES + 1),
    ], { type: 'image/png' });
    Object.defineProperty(thumbnail, 'name', { value: 'too-large.png' });

    await assert.rejects(
      buildExportPackage({
        managedObjects: createManagedObjects(),
        bgmState: null,
        envId: null,
        blobBase: '',
        envOrigin: 'https://example.test',
        behaviorState: null,
        physicsState: null,
        exportMetadata: {
          thumbnailFile: thumbnail,
        },
      }),
      /10MB/,
    );
  });
});
