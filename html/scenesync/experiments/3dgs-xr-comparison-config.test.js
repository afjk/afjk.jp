import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_XR_QUALITY_PRESET,
  XR_LOCOMOTION_SPEED,
  XR_SNAP_TURN_DEGREES,
  playCanvasXrStartScale,
  readXrThumbstick,
  resolveXrQualityConfig,
} from './3dgs-xr-comparison-config.js';

test('XR comparison defaults to identical high-quality settings', () => {
  const config = resolveXrQualityConfig(new URLSearchParams());
  assert.equal(config.preset, DEFAULT_XR_QUALITY_PRESET);
  assert.equal(config.framebufferScale, 1);
  assert.equal(config.foveation, 0);
  assert.equal(XR_LOCOMOTION_SPEED, 1.5);
  assert.equal(XR_SNAP_TURN_DEGREES, 30);
});

test('PlayCanvas start scale compensates its internal pixel-ratio normalization', () => {
  assert.equal(playCanvasXrStartScale(1, 2, 1.5), 4 / 3);
  assert.equal(playCanvasXrStartScale(0.85, 1, 1), 0.85);
  assert.equal(playCanvasXrStartScale(1, 0, 0), 1);
});

test('XR comparison resolves named presets and rejects unknown ones', () => {
  assert.deepEqual(
    resolveXrQualityConfig(new URLSearchParams('quality=balanced')),
    { preset: 'balanced', label: 'Balanced', framebufferScale: 0.85, foveation: 0.3 },
  );
  assert.equal(
    resolveXrQualityConfig(new URLSearchParams('quality=unknown')).preset,
    DEFAULT_XR_QUALITY_PRESET,
  );
});

test('PICO xr-standard thumbstick axes use axes 2/3 and radial deadzone', () => {
  assert.deepEqual(readXrThumbstick({ axes: [0.8, 0.8, 0.1, 0.1] }), {
    x: 0,
    y: 0,
    active: false,
  });
  const stick = readXrThumbstick({ axes: [0, 0, 0.6, -0.8] });
  assert.equal(stick.active, true);
  assert.ok(Math.abs(stick.x - 0.6) < 0.000001);
  assert.ok(Math.abs(stick.y + 0.8) < 0.000001);
});

test('controllers with one 2D axis pair remain supported', () => {
  const stick = readXrThumbstick({ axes: [-0.5, 0] });
  assert.equal(stick.active, true);
  assert.ok(stick.x < 0);
  assert.equal(stick.y, 0);
});
