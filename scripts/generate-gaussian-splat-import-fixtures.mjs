#!/usr/bin/env node
// Generate the Gaussian Splat import fixtures used by the 3DGS import tests,
// by the vendored bundle's build verification, and by the browser smoke page.
//
//   node scripts/generate-gaussian-splat-import-fixtures.mjs
//
// The scene is a small ring of splats with degree 1 spherical harmonics, so the
// fixtures exercise activation handling (log scale, opacity logit, wxyz
// quaternions) and the higher-order SH path rather than only degree 0.
//
// The PLY and SPZ are written by SceneSync's own hand-rolled encoders in
// test-fixtures.mjs — deliberately independent of splat-transform, so that
// reading them back is a cross-implementation check rather than a round trip
// through one library. The SOG and LCC2 fixtures come from splat-transform
// itself, since nothing else can produce them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MemoryFileSystem,
  MemoryReadFileSystem,
  ZipFileSystem,
  createChunkDataPool,
  readFile,
  writeSource,
} from '@playcanvas/splat-transform';

import {
  buildGaussianSplatPly,
  buildSpzPayload,
  gzipBytes,
  rgbToSh0,
} from '../html/assets/js/scenesync/loaders/gaussian-splat/test-fixtures.mjs';
import { convertGaussianSplatToGlb } from '../html/assets/js/scenesync/loaders/gaussian-splat/splat-transform-adapter.js';

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

/** Re-encode a capture with splat-transform, in memory. */
async function transcode(inputName, bytes, outputName, outputFormat) {
  const readFs = new MemoryReadFileSystem();
  readFs.set(inputName, bytes);
  const [source] = await readFile({
    filename: inputName,
    inputFormat: inputName.split('.').pop(),
    options: {},
    fileSystem: readFs,
  });

  const pool = createChunkDataPool({ chunkSize: 65536 });
  const writeFs = new MemoryFileSystem();
  try {
    await writeSource({ filename: outputName, outputFormat, source, pool, options: {} }, writeFs);
  } finally {
    await source.close();
    pool.destroy();
  }
  return writeFs.results.get(outputName);
}

/**
 * Pack a one-node LCC2 octree around a single SOG chunk.
 *
 * A real XGrids export is a directory of chunk files described by meta.lcc2;
 * a zip of that directory is what makes it a single-file drop. One chunk and
 * one LOD is the smallest thing that still exercises the manifest parse, the
 * chunk lookup and the SOG decode.
 */
async function buildLcc2Archive(sogBytes, splatCount) {
  const meta = {
    totalSplats: splatCount,
    lodSplats: [splatCount],
    totalLevels: 1,
    splatType: '.sog',
    boundingBox: { min: [-1, -1, -1], max: [1, 1, 1] },
    root: {
      splatFiles: ['3dgs/chunk0.sog'],
      childNum: 1,
      child: [{
        data: { '3dgs': { name: 0, start: 0, count: splatCount } },
        childNum: 0,
        child: [],
      }],
    },
  };

  const outerFs = new MemoryFileSystem();
  const outerWriter = await outerFs.createWriter('archive.zip');
  const zipFs = new ZipFileSystem(outerWriter);

  const write = async (name, data) => {
    const writer = await zipFs.createWriter(name);
    await writer.write(data);
    await writer.close();
  };

  await write('meta.lcc2', new TextEncoder().encode(JSON.stringify(meta, null, 2)));
  await write('3dgs/chunk0.sog', sogBytes);

  await zipFs.close();
  await outerWriter.close();
  return outerFs.results.get('archive.zip');
}

async function main() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const fixtureDir = path.resolve(currentDir, '../html/scenesync/experiments/fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });

  const splats = buildRing();
  const written = [];
  const emit = (name, bytes) => {
    const target = path.join(fixtureDir, name);
    fs.writeFileSync(target, bytes);
    written.push(target);
  };

  const ply = buildGaussianSplatPly(splats, { shDegree: 1 });
  emit('ring-gaussian-splats.ply', ply);

  emit('ring-gaussian-splats.spz', await gzipBytes(buildSpzPayload(splats, { version: 2, shDegree: 1 })));

  const sog = await transcode('ring.ply', ply, 'ring.sog', 'sog-bundle');
  emit('ring-gaussian-splats.sog', sog);

  emit('ring-gaussian-splats.lcc2.zip', await buildLcc2Archive(sog, SPLAT_COUNT));

  // Convert the PLY through the real import path so the smoke page has a GLB
  // that came out of the importer rather than a hand-built one.
  const converted = await convertGaussianSplatToGlb(ply, { fileName: 'ring-gaussian-splats.ply' });
  emit('ring-gaussian-splats.glb', converted.glb);

  for (const file of written) {
    console.log(`${file} (${fs.statSync(file).size.toLocaleString()} bytes)`);
  }
  console.log(`splats: ${converted.splatCount}, SH degree: ${converted.shDegree}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
