import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCENE_SYNC_GAUSSIAN_SPLAT_PATCH,
  patchSceneSyncGaussianSplatLoaderExtensionSource,
  patchSceneSyncGaussianSplatSource,
} from './gaussian-splat-three-patch.js';

const ADDONS_BASE = 'https://example.test/three/examples/jsm/';

function makePinnedGaussianSource() {
  return [
    "import { CountingSort } from '../gpgpu/CountingSort.js';",
    "import { getSH0 } from '../utils/GaussianSplatUtils.js';",
    'import {',
    '\tscreenSize,',
    '\thighpModelViewMatrix,',
    "} from 'three/tsl';",
    'const SPLAT_KERNEL_CUTOFF = 2;',
    'const quad = [',
    '\t\t- 2, - 2, 0,',
    '\t\t2, - 2, 0,',
    '\t\t2, 2, 0,',
    '\t\t- 2, 2, 0',
    '];',
    'const focal = screenSize.mul( 0.5 );',
    'const offsetNdc = offsetPixels.mul( 2 ).div( screenSize );',
    'If( r2.greaterThan( 4 ), () => {} );',
    'return vec4( splatColor.rgb, exp( r2.mul( - 0.5 ) ).mul( splatColor.a ) );',
  ].join('\n');
}

test('patches the pinned GaussianSplat for XR stereo and the accepted smooth kernel', () => {
  const result = patchSceneSyncGaussianSplatSource(makePinnedGaussianSource(), {
    addonsBaseUrl: ADDONS_BASE,
  });

  assert.equal(
    SCENE_SYNC_GAUSSIAN_SPLAT_PATCH,
    'xr-stereo-mediumpModelViewMatrix-cameraViewport-smooth-kernel',
  );
  assert.match(result, /mediumpModelViewMatrix/u);
  assert.doesNotMatch(result, /highpModelViewMatrix/u);
  assert.match(result, /cameraViewport\.zw\.mul\( 0\.5 \)/u);
  assert.match(result, /div\( cameraViewport\.zw \)/u);
  assert.match(result, /SPLAT_KERNEL_CUTOFF = 2\.8284271247461903/u);
  assert.match(result, /sub\( 0\.01831563888873418 \)\.div\( 0\.9816843611112658 \)/u);
  assert.match(result, new RegExp(`${ADDONS_BASE}gpgpu/CountingSort\\.js`, 'u'));
  assert.match(result, new RegExp(`${ADDONS_BASE}utils/GaussianSplatUtils\\.js`, 'u'));
});

test('rewrites the GLTF extension to the patched GaussianSplat module', () => {
  const result = patchSceneSyncGaussianSplatLoaderExtensionSource([
    "import { GaussianSplat } from '../objects/GaussianSplat.js';",
    "import { getSH0 } from '../utils/GaussianSplatUtils.js';",
  ].join('\n'), {
    gaussianSplatUrl: 'blob:patched-gaussian',
    addonsBaseUrl: ADDONS_BASE,
  });

  assert.match(result, /from 'blob:patched-gaussian'/u);
  assert.match(result, new RegExp(`${ADDONS_BASE}utils/GaussianSplatUtils\\.js`, 'u'));
});

test('fails clearly when the pinned Three.js source no longer matches', () => {
  assert.throws(
    () => patchSceneSyncGaussianSplatSource('export class GaussianSplat {}'),
    /patch target not found: highpModelViewMatrix/u,
  );
});
