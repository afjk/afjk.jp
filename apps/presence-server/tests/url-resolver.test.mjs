import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDroppedUrl } from '../../../html/assets/js/scenesync/loaders/url-resolver.js';

test('resolveDroppedUrl', async (t) => {
  await t.test('GitHub blob URL is converted to raw URL', () => {
    const input = 'https://github.com/KhronosGroup/glTF-Sample-Models/blob/main/2.0/Avocado/glTF-Binary/Avocado.glb';
    const r = resolveDroppedUrl(input);
    assert.equal(
      r.resolvedUrl,
      'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Avocado/glTF-Binary/Avocado.glb'
    );
    assert.equal(r.source, 'github-blob');
    assert.equal(r.originalUrl, input);
  });

  await t.test('GitHub raw URL remains unchanged', () => {
    const input = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Avocado/glTF-Binary/Avocado.glb';
    const r = resolveDroppedUrl(input);
    assert.equal(r.resolvedUrl, input);
    assert.equal(r.source, 'github-raw');
  });

  await t.test('direct URL remains unchanged', () => {
    const input = 'https://example.com/file.glb';
    const r = resolveDroppedUrl(input);
    assert.equal(r.resolvedUrl, input);
    assert.equal(r.source, 'direct');
  });

  await t.test('GitHub blob URL with nested path structure', () => {
    const input = 'https://github.com/owner/repo/blob/feature-branch/path/to/deep/file.md';
    const r = resolveDroppedUrl(input);
    assert.equal(
      r.resolvedUrl,
      'https://raw.githubusercontent.com/owner/repo/feature-branch/path/to/deep/file.md'
    );
    assert.equal(r.source, 'github-blob');
  });

  await t.test('invalid URL returns invalid source', () => {
    const input = 'not a url';
    const r = resolveDroppedUrl(input);
    assert.equal(r.source, 'invalid');
    assert.equal(r.resolvedUrl, 'not a url');
  });

  await t.test('empty string returns invalid source', () => {
    const r = resolveDroppedUrl('');
    assert.equal(r.source, 'invalid');
  });

  await t.test('null returns invalid source', () => {
    const r = resolveDroppedUrl(null);
    assert.equal(r.source, 'invalid');
  });

  await t.test('URL with whitespace is trimmed', () => {
    const input = '  https://github.com/owner/repo/blob/main/file.glb  ';
    const r = resolveDroppedUrl(input);
    assert.equal(
      r.resolvedUrl,
      'https://raw.githubusercontent.com/owner/repo/main/file.glb'
    );
    assert.equal(r.source, 'github-blob');
  });
});
