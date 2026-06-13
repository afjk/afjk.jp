import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { resolveSceneDocumentAssetsFromUrl } from './resolve-url-assets.js';

test('converts relative object and scene asset paths to URL-backed assets', () => {
  const sceneDocument = {
    format: 'scene-sync-export-scene',
    version: 2,
    objects: [
      {
        id: 'image-1',
        asset: { type: 'image', source: 'blob', path: 'assets/poster.png', url: 'https://old.example/poster.png' },
        audioSources: {
          default: {
            url: 'https://old.example/audio.mp3',
            volume: 0.8,
            asset: { path: 'assets/audio.mp3', mime: 'audio/mpeg' },
          },
        },
        importAsset: { kind: 'blob-file', path: 'assets/poster.png' },
        importAudioSources: {
          default: { kind: 'blob-file', path: 'assets/audio.mp3' },
        },
      },
      {
        id: 'video-1',
        asset: { type: 'video', path: './assets/movie.webm' },
      },
      {
        id: 'text-1',
        asset: { type: 'text', source: 'url', path: 'assets/story.md', format: 'markdown' },
      },
      {
        id: 'mesh-1',
        asset: { type: 'mesh', source: 'carrier', path: 'assets/model.glb' },
      },
      {
        id: 'inline-1',
        asset: { type: 'text', source: 'inline', path: 'assets/ignored.txt', text: 'Inline text' },
      },
    ],
    bgm: {
      url: 'https://old.example/bgm.mp3',
      asset: { path: 'assets/bgm.mp3', mime: 'audio/mpeg' },
      importAsset: { kind: 'blob-file', path: 'assets/bgm.mp3' },
    },
  };

  const { document } = resolveSceneDocumentAssetsFromUrl(sceneDocument, {
    baseUrl: 'https://example.com/worlds/demo/versions/v1/',
  });

  strictEqual(document.objects[0].asset.url, 'https://example.com/worlds/demo/versions/v1/assets/poster.png');
  strictEqual(document.objects[0].asset.source, 'url');
  strictEqual(document.objects[0].asset.path, undefined);
  strictEqual(document.objects[0].importAsset, undefined);
  strictEqual(document.objects[0].importAudioSources, undefined);
  strictEqual(document.objects[0].audioSources.default.url, 'https://example.com/worlds/demo/versions/v1/assets/audio.mp3');
  strictEqual(document.objects[0].audioSources.default.asset, undefined);

  strictEqual(document.objects[1].asset.url, 'https://example.com/worlds/demo/versions/v1/assets/movie.webm');
  strictEqual(document.objects[1].asset.path, undefined);
  strictEqual(document.objects[2].asset.url, 'https://example.com/worlds/demo/versions/v1/assets/story.md');
  strictEqual(document.objects[2].asset.source, 'url');
  strictEqual(document.objects[2].asset.path, undefined);
  strictEqual(document.objects[3].asset.url, 'https://example.com/worlds/demo/versions/v1/assets/model.glb');
  strictEqual(document.objects[3].asset.source, 'url');
  strictEqual(document.objects[3].asset.path, undefined);

  strictEqual(document.objects[4].asset.source, 'inline');
  strictEqual(document.objects[4].asset.text, 'Inline text');
  strictEqual(document.objects[4].asset.path, undefined);

  strictEqual(document.bgm.url, 'https://example.com/worlds/demo/versions/v1/assets/bgm.mp3');
  strictEqual(document.bgm.asset, undefined);
  strictEqual(document.bgm.importAsset, undefined);
  strictEqual(JSON.stringify(document).includes('"path"'), false);
  strictEqual(JSON.stringify(document).includes('"asset":{"path"'), false);
});

test('preserves already URL-backed assets when no path is present', () => {
  const sceneDocument = {
    format: 'scene-sync-export-scene',
    version: 2,
    objects: [
      {
        id: 'image-1',
        asset: { type: 'image', source: 'url', url: 'https://cdn.example/poster.png' },
      },
    ],
  };

  const { document } = resolveSceneDocumentAssetsFromUrl(sceneDocument, {
    baseUrl: 'https://example.com/worlds/demo/versions/v1/',
  });

  deepStrictEqual(document.objects[0].asset, sceneDocument.objects[0].asset);
});
