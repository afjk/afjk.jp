import { SCENE_SYNC_THREE_BASE_URL } from '../../scenesync-export/viewer/three-runtime.js';

// Temporary source patch for the pinned pre-r186 Three.js revision.
// Remove this module once the XR per-eye matrix and viewport fixes are
// available in the official GaussianSplat implementation we consume.
export const SCENE_SYNC_GAUSSIAN_SPLAT_PATCH =
  'xr-stereo-mediumpModelViewMatrix-cameraViewport-smooth-kernel';

const ADDONS_BASE_URL = `${SCENE_SYNC_THREE_BASE_URL}examples/jsm/`;
const SMOOTH_KERNEL_CUTOFF = '2.8284271247461903';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Three.js Gaussian Splat patch target not found: ${label}`);
  }
  return source.replace(search, replacement);
}

// Keep relative import text out of string literals. The Single HTML packer
// rewrites actual relative module imports and must not rewrite patch targets.
function moduleImport(specifier) {
  return `from '${specifier}'`;
}

export function patchSceneSyncGaussianSplatSource(source, {
  addonsBaseUrl = ADDONS_BASE_URL,
} = {}) {
  let patched = String(source);

  // WebXR renders with an ArrayCamera. highpModelViewMatrix is calculated on
  // the CPU from the parent camera, so it gives both eyes the same view.
  if (!patched.includes('highpModelViewMatrix')) {
    throw new Error('Three.js Gaussian Splat patch target not found: highpModelViewMatrix');
  }
  patched = patched.replaceAll('highpModelViewMatrix', 'mediumpModelViewMatrix');

  // screenSize is the combined XR framebuffer. cameraViewport.zw is the
  // active eye viewport and preserves the intended per-eye ellipse size.
  patched = replaceRequired(
    patched,
    '\tscreenSize,\n',
    '\tcameraViewport,\n',
    'screenSize import',
  );
  patched = replaceRequired(
    patched,
    'const focal = screenSize.mul( 0.5 )',
    'const focal = cameraViewport.zw.mul( 0.5 )',
    'focal screen size',
  );
  patched = replaceRequired(
    patched,
    'const offsetNdc = offsetPixels.mul( 2 ).div( screenSize )',
    'const offsetNdc = offsetPixels.mul( 2 ).div( cameraViewport.zw )',
    'NDC screen size',
  );

  // Match the visually accepted comparison candidate: cover sqrt(8) sigma
  // and normalize alpha to zero at the quad edge. This avoids the harsh
  // contour of the pinned upstream 2-sigma cutoff.
  patched = replaceRequired(
    patched,
    'const SPLAT_KERNEL_CUTOFF = 2;',
    `const SPLAT_KERNEL_CUTOFF = ${SMOOTH_KERNEL_CUTOFF};`,
    'smooth kernel cutoff',
  );
  patched = replaceRequired(
    patched,
    '\t\t- 2, - 2, 0,\n\t\t2, - 2, 0,\n\t\t2, 2, 0,\n\t\t- 2, 2, 0',
    '\t\t- SPLAT_KERNEL_CUTOFF, - SPLAT_KERNEL_CUTOFF, 0,\n'
      + '\t\tSPLAT_KERNEL_CUTOFF, - SPLAT_KERNEL_CUTOFF, 0,\n'
      + '\t\tSPLAT_KERNEL_CUTOFF, SPLAT_KERNEL_CUTOFF, 0,\n'
      + '\t\t- SPLAT_KERNEL_CUTOFF, SPLAT_KERNEL_CUTOFF, 0',
    'smooth kernel quad',
  );
  patched = replaceRequired(
    patched,
    'If( r2.greaterThan( 4 )',
    'If( r2.greaterThan( SPLAT_KERNEL_CUTOFF * SPLAT_KERNEL_CUTOFF )',
    'smooth kernel discard',
  );
  patched = replaceRequired(
    patched,
    'return vec4( splatColor.rgb, exp( r2.mul( - 0.5 ) ).mul( splatColor.a ) );',
    "const gaussian = exp( r2.mul( - 0.5 ) ).sub( 0.01831563888873418 ).div( 0.9816843611112658 ).toVar( 'gaussian' );\n\n"
      + '\t\treturn vec4( splatColor.rgb, gaussian.mul( splatColor.a ) );',
    'smooth normalized alpha',
  );

  patched = replaceRequired(
    patched,
    moduleImport('../gpgpu/CountingSort.js'),
    moduleImport(`${addonsBaseUrl}gpgpu/CountingSort.js`),
    'CountingSort import',
  );
  return replaceRequired(
    patched,
    moduleImport('../utils/GaussianSplatUtils.js'),
    moduleImport(`${addonsBaseUrl}utils/GaussianSplatUtils.js`),
    'GaussianSplatUtils import',
  );
}

export function patchSceneSyncGaussianSplatLoaderExtensionSource(source, {
  gaussianSplatUrl,
  addonsBaseUrl = ADDONS_BASE_URL,
} = {}) {
  if (!gaussianSplatUrl) throw new Error('gaussianSplatUrl is required');

  let patched = replaceRequired(
    String(source),
    moduleImport('../objects/GaussianSplat.js'),
    moduleImport(gaussianSplatUrl),
    'GaussianSplat loader import',
  );
  patched = replaceRequired(
    patched,
    moduleImport('../utils/GaussianSplatUtils.js'),
    moduleImport(`${addonsBaseUrl}utils/GaussianSplatUtils.js`),
    'Gaussian loader utils import',
  );
  return patched;
}

async function fetchSource(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} source HTTP ${response.status}`);
  return response.text();
}

let extensionPromise = null;

export function loadSceneSyncGaussianSplatLoaderExtension() {
  if (extensionPromise) return extensionPromise;

  extensionPromise = (async () => {
    const gaussianSource = patchSceneSyncGaussianSplatSource(await fetchSource(
      `${ADDONS_BASE_URL}objects/GaussianSplat.js`,
      'GaussianSplat',
    ));
    const gaussianUrl = URL.createObjectURL(new Blob([gaussianSource], { type: 'text/javascript' }));

    try {
      const extensionSource = patchSceneSyncGaussianSplatLoaderExtensionSource(await fetchSource(
        `${ADDONS_BASE_URL}loaders/GLTFGaussianSplatLoaderExtension.js`,
        'GLTFGaussianSplatLoaderExtension',
      ), { gaussianSplatUrl: gaussianUrl });
      const extensionUrl = URL.createObjectURL(new Blob([extensionSource], { type: 'text/javascript' }));

      try {
        const module = await import(extensionUrl);
        if (typeof module.GLTFGaussianSplatLoaderExtension !== 'function') {
          throw new Error('Patched GLTFGaussianSplatLoaderExtension was not exported');
        }
        return module.GLTFGaussianSplatLoaderExtension;
      } finally {
        URL.revokeObjectURL(extensionUrl);
      }
    } finally {
      URL.revokeObjectURL(gaussianUrl);
    }
  })().catch((error) => {
    extensionPromise = null;
    throw error;
  });

  return extensionPromise;
}
