#!/usr/bin/env node
// Verify SceneSync's KHR_gaussian_splatting output against Three.js's own loader.
//
//   node scripts/verify-against-threejs-gaussian-splat.mjs
//
// SceneSync writes KHR_gaussian_splatting GLBs from its own reading of the
// specification. The only way to know that reading is right is to feed the
// result to the implementation that will consume it, so this converts fixtures
// through the real importer and loads them with Three.js's
// GLTFGaussianSplatLoaderExtension, then compares the decoded splats against
// the values that went in.
//
// Requires a Three.js that ships Gaussian Splatting. Once that is a release,
// `npm install three` is enough. Against an unreleased dev build, point a
// node_modules/three symlink at a checkout:
//
//   git clone --depth 1 https://github.com/mrdoob/three.js /tmp/three.js
//   ln -s /tmp/three.js node_modules/three
//
// Exits 0 when everything matches, 1 on a mismatch, and 2 when Three.js has no
// Gaussian Splatting support to test against.

import {
  importGaussianSplatAsset,
} from '../html/assets/js/scenesync/loaders/gaussian-splat/import-gaussian-splat.js';
import {
  buildGaussianSplatPly,
  buildSpzPayload,
} from '../html/assets/js/scenesync/loaders/gaussian-splat/test-fixtures.mjs';
import { rgbToSh0 } from '../html/assets/js/scenesync/loaders/gaussian-splat/splat-cloud.js';

const COLORS = [[1.0, 0.25, 0.25], [0.2, 0.8, 0.4], [0.1, 0.3, 0.9]];
const OPACITIES = [0.9, 0.5, 0.25];

const SPLATS = COLORS.map((rgb, i) => ({
  position: [i * 1.5 - 1.5, i * 0.5, -i],
  scale: [0.1 + i * 0.05, 0.08, 0.12],
  rotation: [0, 0, 0, 1],
  opacity: OPACITIES[i],
  // Colors are chosen first and converted to coefficients, so the expected
  // byte values are known without reference to the importer's own maths.
  sh0: rgbToSh0(...rgb),
  shRest: Array.from({ length: 45 }, (_, j) => Math.sin(i + j) * 0.5),
}));

async function loadThreeGaussianSplatting() {
  try {
    const [{ GLTFLoader }, { GLTFGaussianSplatLoaderExtension }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/loaders/GLTFGaussianSplatLoaderExtension.js'),
    ]);
    return { GLTFLoader, GLTFGaussianSplatLoaderExtension };
  } catch (error) {
    return { error };
  }
}

function parseGlb({ GLTFLoader, GLTFGaussianSplatLoaderExtension }, glb) {
  const arrayBuffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const loader = new GLTFLoader();
  loader.register((parser) => new GLTFGaussianSplatLoaderExtension(parser));
  return new Promise((resolve, reject) => loader.parse(arrayBuffer, '', resolve, reject));
}

function findGaussianSplat(gltf) {
  let found = null;
  gltf.scene.traverse((object) => {
    if (object.isGaussianSplat) found = object;
  });
  return found;
}

const failures = [];

function expect(label, actual, expected, tolerance) {
  if (Math.abs(actual - expected) > tolerance) {
    failures.push(`${label}: got ${actual}, expected ${expected} (±${tolerance})`);
  }
}

async function verifyCase(three, label, source, expectedShDegree, fileName) {
  const { glb, splatCount, shDegree } = await importGaussianSplatAsset(source, {
    fileName,
  });

  const gltf = await parseGlb(three, glb);
  const splat = findGaussianSplat(gltf);

  if (!splat) {
    failures.push(`${label}: Three.js produced no GaussianSplat`);
    return;
  }

  const attributes = splat.splatGeometry.attributes;
  const position = attributes.position;
  const color = attributes.color;

  console.log(`\n${label}: ${splatCount} splats, SH degree ${shDegree}`);
  console.log(`  attributes: ${Object.keys(attributes).join(', ')}`);

  if (shDegree !== expectedShDegree) {
    failures.push(`${label}: SH degree ${shDegree}, expected ${expectedShDegree}`);
  }
  for (let degree = 1; degree <= expectedShDegree; degree++) {
    if (!attributes[`sphericalHarmonics${degree}`]) {
      failures.push(`${label}: missing sphericalHarmonics${degree}`);
    }
  }

  for (let i = 0; i < SPLATS.length; i++) {
    const splatDef = SPLATS[i];
    // SPZ quantizes, so positions and colors need a looser bound there.
    const positionTolerance = label.startsWith('spz') ? 1e-3 : 1e-5;
    const colorTolerance = label.startsWith('spz') ? 8 : 1.5;

    expect(`${label} pos[${i}].x`, position.getX(i), splatDef.position[0], positionTolerance);
    expect(`${label} pos[${i}].y`, position.getY(i), splatDef.position[1], positionTolerance);
    expect(`${label} pos[${i}].z`, position.getZ(i), splatDef.position[2], positionTolerance);

    const r = color.getX(i) * 255;
    const g = color.getY(i) * 255;
    const b = color.getZ(i) * 255;
    const a = color.getW(i) * 255;

    expect(`${label} color[${i}].r`, r, Math.round(COLORS[i][0] * 255), colorTolerance);
    expect(`${label} color[${i}].g`, g, Math.round(COLORS[i][1] * 255), colorTolerance);
    expect(`${label} color[${i}].b`, b, Math.round(COLORS[i][2] * 255), colorTolerance);
    expect(`${label} alpha[${i}]`, a, Math.round(OPACITIES[i] * 255), colorTolerance);

    console.log(
      `  splat ${i}: pos(${position.getX(i).toFixed(3)}, ${position.getY(i).toFixed(3)}, ${position.getZ(i).toFixed(3)}) `
      + `rgba(${r.toFixed(0)}, ${g.toFixed(0)}, ${b.toFixed(0)}, ${a.toFixed(0)})`,
    );
  }
}

async function main() {
  const three = await loadThreeGaussianSplatting();

  if (three.error) {
    console.log('Three.js Gaussian Splatting support was not found.');
    console.log(`  ${three.error.message}`);
    console.log('\nInstall a Three.js release that ships Gaussian Splatting, or symlink a dev');
    console.log('checkout at node_modules/three. See the header of this script.');
    process.exit(2);
  }

  console.log('Verifying SceneSync KHR_gaussian_splatting output against Three.js.');

  await verifyCase(three, 'ply-degree-3', buildGaussianSplatPly(SPLATS, { shDegree: 3 }), 3, 'verify.ply');
  await verifyCase(three, 'ply-degree-0', buildGaussianSplatPly(SPLATS, { shDegree: 0 }), 0, 'verify.ply');
  await verifyCase(three, 'ply-ascii', buildGaussianSplatPly(SPLATS, { shDegree: 1, format: 'ascii' }), 1, 'verify.ply');
  await verifyCase(three, 'spz-degree-1', buildSpzPayload(SPLATS, { version: 2, shDegree: 1 }), 1, 'verify.spz');
  await verifyCase(three, 'spz-degree-3', buildSpzPayload(SPLATS, { version: 3, shDegree: 3 }), 3, 'verify.spz');

  if (failures.length > 0) {
    console.log(`\n${failures.length} mismatch(es):`);
    for (const failure of failures) console.log(`  ${failure}`);
    process.exit(1);
  }

  console.log('\nAll fixtures load as GaussianSplat with matching positions, colors and SH bands.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
