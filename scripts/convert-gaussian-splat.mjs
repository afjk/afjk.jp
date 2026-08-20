#!/usr/bin/env node
// Convert a Gaussian Splat asset (.ply / .spz) into a KHR_gaussian_splatting GLB.
//
//   node scripts/convert-gaussian-splat.mjs input.ply [output.glb] [--flip-up]
//
// SceneSync's interchange format for splats is GLB + KHR_gaussian_splatting, so
// this is the same conversion the editor performs on drag & drop. It exists as a
// CLI too, for preparing fixtures and for batch converting captures.

import fs from 'node:fs';
import path from 'node:path';

import { importGaussianSplatAsset } from '../html/assets/js/scenesync/loaders/gaussian-splat/import-gaussian-splat.js';
import { inspectGaussianSplatGlb } from '../html/assets/js/scenesync/loaders/khr-gaussian-splatting.js';

function parseArgs(argv) {
  const positional = [];
  let upAxisCorrection = 'none';

  for (const arg of argv) {
    if (arg === '--flip-up') upAxisCorrection = 'flip-x-180';
    else if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }

  return { input: positional[0], output: positional[1], upAxisCorrection };
}

const USAGE = `Usage: node scripts/convert-gaussian-splat.mjs <input.ply|input.spz> [output.glb] [--flip-up]

  --flip-up   Write a 180 degree rotation about X on the node, for captures
              authored Y-down. Splat data itself is never rewritten.`;

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || !options.input) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }

  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(
    options.output || inputPath.replace(/\.(ply|spz)$/i, '.glb'),
  );

  if (outputPath === inputPath) {
    throw new Error('Refusing to overwrite the input file; pass an explicit output path');
  }

  const source = fs.readFileSync(inputPath);
  const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);

  const result = await importGaussianSplatAsset(bytes, {
    fileName: path.basename(inputPath),
    upAxisCorrection: options.upAxisCorrection,
  });

  const inspection = inspectGaussianSplatGlb(result.glb);
  if (!inspection.valid) {
    throw new Error(`Converted GLB failed validation: ${inspection.errors.join('; ')}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, result.glb);

  console.log(`${inputPath}`);
  console.log(`  -> ${outputPath}`);
  console.log(`     format    ${result.sourceFormat}`);
  console.log(`     splats    ${result.splatCount.toLocaleString()}`);
  console.log(`     SH degree ${result.shDegree}`);
  console.log(`     size      ${result.glb.byteLength.toLocaleString()} bytes`);
  if (inspection.warnings.length > 0) {
    console.log(`     warnings  ${inspection.warnings.join('; ')}`);
  }
}

main().catch((error) => {
  console.error(`${error.name || 'Error'}: ${error.message}`);
  process.exit(1);
});
