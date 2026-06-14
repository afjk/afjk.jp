import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportThumbnailStatsLabel,
  collectExportSceneStats,
  colorFromString,
  resolveExportThumbnailTitle,
  wrapCanvasText,
} from './export-thumbnail.js';

function measureTextByChars(charWidth = 10) {
  return {
    measureText(text) {
      return { width: String(text).length * charWidth };
    },
  };
}

test('collects scene stats for generated export thumbnails', () => {
  const stats = collectExportSceneStats({
    bgm: { url: 'assets/bgm.mp3' },
    behaviors: { graphs: { box: {} } },
    physics: { enabled: true },
    objects: [
      { asset: { type: 'image' } },
      { asset: { type: 'video' } },
      { asset: { type: 'text' } },
      { asset: { type: 'mesh' }, audioSources: { default: {}, click: {} } },
      { asset: { type: 'primitive' }, physics: { enabled: true } },
      { asset: { type: 'primitive' }, physics: { enabled: false } },
    ],
  });

  assert.deepEqual(stats, {
    objects: 6,
    images: 1,
    videos: 1,
    audios: 3,
    texts: 1,
    glbs: 1,
    loomlets: 1,
    physics: 1,
  });
});

test('builds compact stats labels for thumbnail cards', () => {
  assert.equal(
    buildExportThumbnailStatsLabel({
      objects: 12,
      glbs: 1,
      images: 3,
      videos: 0,
      audios: 1,
      texts: 2,
      loomlets: 1,
      physics: 1,
    }),
    '12 objects · glb · image · audio · text',
  );
  assert.equal(buildExportThumbnailStatsLabel({ objects: 1 }), '1 object');
});

test('uses scene or manifest title before fallback title', () => {
  assert.equal(
    resolveExportThumbnailTitle({
      sceneDocument: { title: 'Scene Title' },
      manifest: { title: 'Manifest Title' },
      fallbackTitle: 'Fallback',
    }),
    'Scene Title',
  );
  assert.equal(
    resolveExportThumbnailTitle({
      sceneDocument: {},
      manifest: { title: 'Manifest Title' },
      fallbackTitle: 'Fallback',
    }),
    'Manifest Title',
  );
  assert.equal(
    resolveExportThumbnailTitle({
      sceneDocument: {},
      manifest: {},
      fallbackTitle: 'Fallback',
    }),
    'Fallback',
  );
});

test('generates stable title-card background colors', () => {
  const color = colorFromString('First Sample');
  assert.equal(color, colorFromString('First Sample'));
  assert.match(color, /^hsl\(\d+, 64%, 42%\)$/);
});

test('wraps long title text to a bounded number of lines', () => {
  const lines = wrapCanvasText(
    measureTextByChars(10),
    'A very long Scene Sync export title that needs wrapping',
    180,
    3,
  );

  assert.equal(lines.length, 3);
  assert(lines.every((line) => line.length > 0));
  assert(lines[2].endsWith('…'));
});

test('wraps long unspaced title text', () => {
  const lines = wrapCanvasText(
    measureTextByChars(10),
    'これはとても長いSceneSyncの日本語タイトルです',
    120,
    3,
  );

  assert(lines.length <= 3);
  assert(lines.every((line) => line.length > 0));
  assert(lines.some((line) => line.endsWith('…')) || lines.length > 1);
});
