#!/usr/bin/env node
// Generate the PLY and SPZ import fixtures used by the 3DGS import tests and by
// the browser smoke page.
//
//   node scripts/generate-gaussian-splat-import-fixtures.mjs
//
// The scene is a small ring of splats with degree 1 spherical harmonics, so the
// fixtures exercise activation handling (log scale, opacity logit, wxyz
// quaternions) and the higher-order SH path rather than only degree 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGaussianSplatPly,
  buildSpzPayload,
  gzipBytes,
} from '../html/assets/js/scenesync/loaders/gaussian-splat/test-fixtures.mjs';
import { importGaussianSplatAsset } from '../html/assets/js/scenesync/loaders/gaussian-splat/import-gaussian-splat.js';
import { rgbToSh0 } from '../html/assets/js/scenesync/loaders/gaussian-splat/splat-cloud.js';

const SPLAT_COUNT = 16;
const RING_RADIUS = 0.8;

function buildRing() {
  return Array.from({ length: SPLAT_COUNT }, (_, i) => {
    const angle = (i / SPLAT_COUNT) * Math.PI * 2;
    const hue = i / SPLAT_COUNT;
    const [r, g, b] = hslToRgb(hue, 0.75, 0.55);

    return {
      position: [
        Math.cos(angle) * RING_RADIUS,
        0.2 + Math.sin(angle * 2) * 0.15,
        Math.sin(angle) * RING_RADIUS,
      ],
      scale: [0.09, 0.05 + (i % 3) * 0.02, 0.07],
      rotation: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
      opacity: 0.6 + (i % 4) * 0.1,
      sh0: rgbToSh0(r, g, b),
      // Degree 1 view dependence: 3 coefficients * 3 channels.
      shRest: Array.from({ length: 9 }, (_, j) => Math.sin(angle + j) * 0.2),
    };
  });
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

async function main() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const fixtureDir = path.resolve(currentDir, '../html/scenesync/experiments/fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });

  const splats = buildRing();
  const written = [];

  const ply = buildGaussianSplatPly(splats, { shDegree: 1 });
  const plyPath = path.join(fixtureDir, 'ring-gaussian-splats.ply');
  fs.writeFileSync(plyPath, ply);
  written.push(plyPath);

  const spz = await gzipBytes(buildSpzPayload(splats, { version: 2, shDegree: 1 }));
  const spzPath = path.join(fixtureDir, 'ring-gaussian-splats.spz');
  fs.writeFileSync(spzPath, spz);
  written.push(spzPath);

  // Convert the PLY through the real import path so the smoke page has a GLB
  // that came out of the importer rather than a hand-built one.
  const converted = await importGaussianSplatAsset(ply, { fileName: 'ring-gaussian-splats.ply' });
  const glbPath = path.join(fixtureDir, 'ring-gaussian-splats.glb');
  fs.writeFileSync(glbPath, converted.glb);
  written.push(glbPath);

  for (const file of written) {
    console.log(`${file} (${fs.statSync(file).size.toLocaleString()} bytes)`);
  }
  console.log(`splats: ${converted.splatCount}, SH degree: ${converted.shDegree}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
