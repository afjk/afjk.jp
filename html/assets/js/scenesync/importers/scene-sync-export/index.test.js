import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { showSceneDocumentImportPreview } from './index.js';

function createFakeZip(entries) {
  return {
    file(path) {
      const value = entries[path];
      if (value == null) return null;
      return {
        async async(type) {
          if (type === 'string') return String(value);
          if (type === 'arraybuffer') {
            return new TextEncoder().encode(String(value)).buffer;
          }
          throw new Error(`unsupported fake zip type: ${type}`);
        },
      };
    },
  };
}

test('shows local Scene Sync Export import previews without ZIP paths', async () => {
  const calls = [];
  const revoked = [];
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let nextBlobUrl = 1;

  URL.createObjectURL = () => `blob:preview-${nextBlobUrl++}`;
  URL.revokeObjectURL = (url) => revoked.push(url);

  try {
    const zip = createFakeZip({
      'assets/poster.png': 'png-bytes',
      'assets/caption.md': '# Caption',
      'assets/model.glb': 'glb-bytes',
    });

    const preview = await showSceneDocumentImportPreview({
      objects: [
        {
          id: 'poster',
          name: 'Poster',
          position: [1, 2, 3],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
          asset: { type: 'image', path: 'assets/poster.png', mime: 'image/png' },
          metadata: { role: 'media-panel' },
          audioSources: {
            default: {
              url: 'https://example.com/poster.mp3',
              asset: { path: 'assets/poster.mp3' },
            },
          },
        },
        {
          id: 'caption',
          name: 'Caption',
          asset: { type: 'text', source: 'url', path: 'assets/caption.md', format: 'markdown' },
        },
        {
          id: 'model',
          name: 'Model',
          asset: { type: 'mesh', path: 'assets/model.glb', mime: 'model/gltf-binary' },
        },
      ],
    }, {
      zip,
      addOrUpdateObject: (id, payload, options) => calls.push({ id, payload, options }),
    });

    strictEqual(preview.previewed, 3);
    strictEqual(calls.length, 3);
    deepStrictEqual(calls.map((call) => call.options), [
      { source: 'scene-sync-export-import-preview' },
      { source: 'scene-sync-export-import-preview' },
      { source: 'scene-sync-export-import-preview' },
    ]);

    strictEqual(calls[0].id, 'poster');
    strictEqual(calls[0].payload.asset.type, 'image');
    strictEqual(calls[0].payload.asset.source, 'local-preview');
    strictEqual(calls[0].payload.asset.url, 'blob:preview-1');
    strictEqual(calls[0].payload.asset.path, undefined);
    strictEqual(calls[0].payload.metadata.importPreview, true);
    strictEqual(calls[0].payload.audioSources, undefined);
    strictEqual(JSON.stringify(calls[0].payload).includes('assets/poster.mp3'), false);

    strictEqual(calls[1].id, 'caption');
    strictEqual(calls[1].payload.asset.type, 'text');
    strictEqual(calls[1].payload.asset.source, 'inline');
    strictEqual(calls[1].payload.asset.text, '# Caption');
    strictEqual(calls[1].payload.asset.path, undefined);

    strictEqual(calls[2].id, 'model');
    strictEqual(calls[2].payload.asset.type, 'primitive');
    strictEqual(calls[2].payload.asset.primitive, 'box');
    strictEqual(calls[2].payload.asset.previewAssetType, 'mesh');

    preview.dispose();
    deepStrictEqual(revoked, ['blob:preview-1']);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});
