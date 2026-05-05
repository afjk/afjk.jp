import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planeSizeFromAspect } from '../../../html/assets/js/scenesync/loaders/url-importers/image.js';

test('planeSizeFromAspect', async (t) => {
  await t.test('16:9 landscape aspect (aspect >= 1)', () => {
    const aspect = 16 / 9;
    const { width, height } = planeSizeFromAspect(aspect, 2);
    assert.equal(width, 2);
    assert.equal(Math.round(height * 100) / 100, Math.round((2 / aspect) * 100) / 100);
  });

  await t.test('9:16 portrait aspect (aspect < 1)', () => {
    const aspect = 9 / 16;
    const { width, height } = planeSizeFromAspect(aspect, 2);
    assert.equal(height, 2);
    assert.equal(Math.round(width * 100) / 100, Math.round((2 * aspect) * 100) / 100);
  });

  await t.test('1:1 square aspect', () => {
    const { width, height } = planeSizeFromAspect(1, 2);
    assert.equal(width, 2);
    assert.equal(height, 2);
  });

  await t.test('100:1 extreme aspect ratio (very wide)', () => {
    const aspect = 100;
    const { width, height } = planeSizeFromAspect(aspect, 2);
    assert.equal(width, 2);
    assert(height >= 0.1, 'height should be clamped to minimum 0.1 m');
  });

  await t.test('1:100 extreme aspect ratio (very tall)', () => {
    const aspect = 0.01;
    const { width, height } = planeSizeFromAspect(aspect, 2);
    assert.equal(height, 2);
    assert(width >= 0.1, 'width should be clamped to minimum 0.1 m');
  });

  await t.test('uses default maxEdgeMeters of 2', () => {
    const aspect = 2;
    const { width, height } = planeSizeFromAspect(aspect);
    assert.equal(width, 2);
    assert(height > 0, 'height should be positive');
  });

  await t.test('respects custom maxEdgeMeters', () => {
    const aspect = 1;
    const { width, height } = planeSizeFromAspect(aspect, 4);
    assert.equal(width, 4);
    assert.equal(height, 4);
  });

  await t.test('clamps extremely small dimensions to 0.1 m minimum', () => {
    const aspect = 0.001;
    const { width, height } = planeSizeFromAspect(aspect, 2);
    assert(width >= 0.1, 'width should be at least 0.1 m');
    assert.equal(height, 2);
  });

  await t.test('handles zero aspect (defaults to safe fallback)', () => {
    // Should not crash; implementation should handle edge cases
    const result = planeSizeFromAspect(0, 2);
    assert(typeof result.width === 'number', 'width should be a number');
    assert(typeof result.height === 'number', 'height should be a number');
    assert(result.width > 0 && result.height > 0, 'dimensions should be positive');
  });
});
