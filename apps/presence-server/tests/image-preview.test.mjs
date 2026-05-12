import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTemporaryImageObjectId } from '../../../html/assets/js/scenesync/loaders/image-preview.js';

test('generateTemporaryImageObjectId returns temp-image prefixed id', () => {
  const objectId = generateTemporaryImageObjectId();
  assert.match(objectId, /^temp-image-[a-z0-9]+-[a-z0-9]{12}$/);
});

test('generateTemporaryImageObjectId is unique across calls', () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateTemporaryImageObjectId()));
  assert.equal(ids.size, 100);
});
