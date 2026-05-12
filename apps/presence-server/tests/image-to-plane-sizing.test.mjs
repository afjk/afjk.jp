import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planeSizeFromImage } from '../../../html/assets/js/scenesync/loaders/image-to-plane.js';
import { computeResizedImageSize } from '../../../html/assets/js/scenesync/loaders/image-optimizer.js';

test('horizontal image normalized to maxEdge=2', () => {
  const { width, height } = planeSizeFromImage(2000, 1000, 2);
  assert.equal(width, 2);
  assert.equal(height, 1);
});

test('vertical image', () => {
  const { width, height } = planeSizeFromImage(800, 1600, 2);
  assert.equal(width, 1);
  assert.equal(height, 2);
});

test('square image', () => {
  const result = planeSizeFromImage(512, 512, 2);
  assert.deepEqual(result, { width: 2, height: 2 });
});

test('custom maxEdgeMeters', () => {
  const { width, height } = planeSizeFromImage(1000, 500, 4);
  assert.equal(width, 4);
  assert.equal(height, 2);
});

test('default maxEdgeMeters=2', () => {
  const { width, height } = planeSizeFromImage(200, 100);
  assert.equal(width, 2);
  assert.equal(height, 1);
});

test('computeResizedImageSize downsamples smartphone image to 2048 max edge', () => {
  const result = computeResizedImageSize(4032, 3024, 2048);
  assert.equal(result.width, 2048);
  assert.equal(result.height, 1536);
  assert.equal(result.resized, true);
});

test('computeResizedImageSize keeps small image unchanged', () => {
  const result = computeResizedImageSize(1024, 768, 2048);
  assert.equal(result.width, 1024);
  assert.equal(result.height, 768);
  assert.equal(result.resized, false);
});

test('computeResizedImageSize downsamples large sky image for 4096 max edge', () => {
  const result = computeResizedImageSize(8192, 4096, 4096);
  assert.equal(result.width, 4096);
  assert.equal(result.height, 2048);
  assert.equal(result.resized, true);
});
