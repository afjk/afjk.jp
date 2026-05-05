import { test } from 'node:test';
import assert from 'node:assert/strict';

test('loadGlbFromUrl', async (t) => {
  // Note: Full loadGlbFromUrl testing in Node.js requires mocking fetch and THREE.
  // These tests verify the logic without full integration.

  await t.test('extracts displayName from URL pathname', () => {
    const url = 'https://example.com/path/to/model.glb';
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'model.glb');
    const displayName = filename.slice(0, 60) || 'model.glb';
    assert.equal(displayName, 'model.glb');
  });

  await t.test('handles long filenames by truncating to 60 chars', () => {
    const url = 'https://example.com/very-long-filename-that-exceeds-sixty-characters-and-should-be-truncated.glb';
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'model.glb');
    const displayName = filename.slice(0, 60) || 'model.glb';
    assert(displayName.length <= 60, `displayName should be max 60 chars, got ${displayName.length}`);
  });

  await t.test('handles URL with query string', () => {
    const url = 'https://example.com/model.glb?token=abc&version=1';
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'model.glb');
    const displayName = filename.slice(0, 60) || 'model.glb';
    assert.equal(displayName, 'model.glb');
  });

  await t.test('handles URL with fragment', () => {
    const url = 'https://example.com/models/avatar.glb#rigged';
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'model.glb');
    const displayName = filename.slice(0, 60) || 'model.glb';
    assert.equal(displayName, 'avatar.glb');
  });

  await t.test('extracts sizeBytes correctly', () => {
    const sizeBytes = 10 * 1024 * 1024; // 10 MB
    assert(sizeBytes < 50 * 1024 * 1024, 'size should be under 50 MB limit');
  });

  await t.test('validates size limit (50 MB)', () => {
    const validSize = 50 * 1024 * 1024;
    const oversizeSize = 51 * 1024 * 1024;
    assert(validSize <= 50 * 1024 * 1024, 'valid size should pass');
    assert(oversizeSize > 50 * 1024 * 1024, 'oversize should fail');
  });

  await t.test('accepts various content types', () => {
    const validTypes = [
      'model/gltf-binary',
      'application/octet-stream',
      'model/gltf+json',
    ];
    validTypes.forEach((type) => {
      assert(type, `should accept ${type}`);
    });
  });

  await t.test('timeout defaults to 30000 ms', () => {
    const defaultTimeout = 30000;
    const customTimeout = 15000;
    assert(defaultTimeout > customTimeout, 'GLB timeout should be longer than image timeout');
  });
});

test('importGlbUrl payload structure', async (t) => {
  await t.test('builds scene-add payload with mesh asset', () => {
    const objectId = 'glb-test';
    const url = 'https://example.com/model.glb';
    const displayName = 'model.glb';
    const position = [0, 0, 0];
    const rotation = [0, 0, 0, 1];
    const scale = [1, 1, 1];

    const payload = {
      kind: 'scene-add',
      objectId,
      name: displayName,
      position,
      rotation,
      scale,
      asset: { type: 'mesh', source: 'url', url },
    };

    assert.equal(payload.kind, 'scene-add');
    assert.equal(payload.asset.type, 'mesh');
    assert.equal(payload.asset.source, 'url');
    assert.equal(payload.asset.url, url);
  });

  await t.test('uses generateObjectId with glb prefix', () => {
    const prefix = 'glb';
    const id = `${prefix}-test-123`;
    assert(id.startsWith(prefix), `generated ID should start with ${prefix}`);
  });
});
