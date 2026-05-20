import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateManifest } from '../../../html/assets/js/scenesync-export/export/export-manifest.js';

test('generateManifest', async (t) => {
  await t.test('includes required top-level fields', () => {
    const m = generateManifest({ assetManifest: [], missingAssets: [] });
    assert.equal(m.format, 'scene-sync-export');
    assert.equal(m.version, 1);
    assert.ok(typeof m.exportedAt === 'string');
    assert.deepEqual(m.viewer, { entry: 'index.html' });
    assert.ok(Array.isArray(m.assets));
    assert.ok(Array.isArray(m.missingAssets));
    assert.ok(Array.isArray(m.notes));
  });

  await t.test('records included assets', () => {
    const assetManifest = [
      { id: 'obj-1', kind: 'mesh', path: 'assets/obj-1.glb', status: 'included' },
      { id: 'bgm',   kind: 'bgm',  path: 'assets/bgm.mp3',   status: 'included' },
    ];

    const m = generateManifest({ assetManifest, missingAssets: [] });
    assert.equal(m.assets.length, 2);
    assert.equal(m.assets[0].id, 'obj-1');
    assert.equal(m.assets[0].path, 'assets/obj-1.glb');
  });

  await t.test('records missing assets', () => {
    const missingAssets = [
      { id: 'obj-2', kind: 'mesh', reason: 'fetch-failed' },
    ];

    const m = generateManifest({ assetManifest: [], missingAssets });
    assert.equal(m.missingAssets.length, 1);
    assert.equal(m.missingAssets[0].id, 'obj-2');
  });

  await t.test('uses provided exportedAt timestamp', () => {
    const ts = '2026-01-01T00:00:00.000Z';
    const m = generateManifest({ assetManifest: [], missingAssets: [], exportedAt: ts });
    assert.equal(m.exportedAt, ts);
  });

  await t.test('notes include CDN dependency when cdnDependent is true', () => {
    const m = generateManifest({ assetManifest: [], missingAssets: [], cdnDependent: true });
    const hasCdnNote = m.notes.some(n => n.includes('cdn.jsdelivr.net'));
    assert.ok(hasCdnNote);
  });

  await t.test('notes omit CDN dependency when cdnDependent is false', () => {
    const m = generateManifest({ assetManifest: [], missingAssets: [], cdnDependent: false });
    const hasCdnNote = m.notes.some(n => n.includes('cdn.jsdelivr.net'));
    assert.equal(hasCdnNote, false);
  });
});
