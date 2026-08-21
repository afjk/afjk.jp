#!/usr/bin/env node
// Measure conversion time and peak memory for realistic Gaussian Splat captures.
//
//   node --expose-gc scripts/benchmark-gaussian-splat-import.mjs
//   node --expose-gc scripts/benchmark-gaussian-splat-import.mjs --counts 100000,500000 --degrees 0,3
//
// Real captures run from a few hundred thousand to a few million splats, and
// the whole cloud is held in memory during conversion, so these numbers decide
// what the importer can accept and whether it needs to leave the main thread.

import { readGaussianSplatPly } from '../html/assets/js/scenesync/loaders/gaussian-splat/ply-splat-reader.js';
import { readSpzPayload } from '../html/assets/js/scenesync/loaders/gaussian-splat/spz-splat-reader.js';
import { writeGaussianSplatGlb } from '../html/assets/js/scenesync/loaders/gaussian-splat/khr-glb-writer.js';
import { SH_REST_COEFS_BY_DEGREE } from '../html/assets/js/scenesync/loaders/gaussian-splat/splat-cloud.js';
import {
  buildGaussianSplatPly,
  buildSpzPayload,
} from '../html/assets/js/scenesync/loaders/gaussian-splat/test-fixtures.mjs';

function parseArgs(argv) {
  const options = { counts: [50_000, 200_000, 500_000], degrees: [0, 3], format: 'both' };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--counts') options.counts = argv[++i].split(',').map(Number);
    else if (argv[i] === '--degrees') options.degrees = argv[++i].split(',').map(Number);
    else if (argv[i] === '--format') options.format = argv[++i];
  }

  return options;
}

function buildSplats(count, shDegree) {
  const restCoefs = SH_REST_COEFS_BY_DEGREE[shDegree] * 3;
  const splats = new Array(count);

  for (let i = 0; i < count; i++) {
    const t = i / count;
    const angle = t * Math.PI * 40;
    splats[i] = {
      position: [Math.cos(angle) * (1 + t * 4), t * 3, Math.sin(angle) * (1 + t * 4)],
      scale: [0.01 + t * 0.02, 0.01, 0.015],
      rotation: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
      opacity: 0.3 + (i % 7) / 10,
      sh0: [t * 2 - 1, 0.5 - t, t],
      shRest: restCoefs > 0 ? new Array(restCoefs).fill(0).map((_, j) => ((i + j) % 32) / 64) : null,
    };
  }

  return splats;
}

function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function heapUsed() {
  return process.memoryUsage().heapUsed;
}

async function measure(label, fn) {
  globalThis.gc?.();
  const before = heapUsed();
  const start = process.hrtime.bigint();

  const result = await fn();

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const peak = process.memoryUsage();

  return {
    label,
    elapsedMs,
    heapDelta: peak.heapUsed - before,
    rss: peak.rss,
    result,
  };
}

/**
 * Build one source encoding and drop the synthetic splat objects before
 * measuring. The browser only ever holds the source bytes, so leaving the
 * generator's object array alive would inflate every memory number.
 */
function buildSource(count, shDegree, encode) {
  let splats = buildSplats(count, shDegree);
  const source = encode(splats, shDegree);
  splats = null;
  globalThis.gc?.();
  return source;
}

async function runCase(count, shDegree, format) {
  const rows = [];

  if (format === 'ply' || format === 'both') {
    const source = buildSource(count, shDegree, (s, d) => buildGaussianSplatPly(s, { shDegree: d }));
    const decode = await measure('ply decode', () => readGaussianSplatPly(source));
    const write = await measure('glb write', () => writeGaussianSplatGlb(decode.result));

    rows.push({
      format: 'ply',
      sourceBytes: source.byteLength,
      glbBytes: write.result.byteLength,
      decodeMs: decode.elapsedMs,
      writeMs: write.elapsedMs,
      totalMs: decode.elapsedMs + write.elapsedMs,
      rss: write.rss,
    });
  }

  if (format === 'spz' || format === 'both') {
    // Benchmark the uncompressed payload so the numbers isolate decoding
    // rather than gzip throughput.
    const source = buildSource(count, shDegree, (s, d) => buildSpzPayload(s, { version: 2, shDegree: d }));
    const decode = await measure('spz decode', () => readSpzPayload(source));
    const write = await measure('glb write', () => writeGaussianSplatGlb(decode.result));

    rows.push({
      format: 'spz',
      sourceBytes: source.byteLength,
      glbBytes: write.result.byteLength,
      decodeMs: decode.elapsedMs,
      writeMs: write.elapsedMs,
      totalMs: decode.elapsedMs + write.elapsedMs,
      rss: write.rss,
    });
  }

  return rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!globalThis.gc) {
    console.warn('Run with --expose-gc for stable memory numbers.\n');
  }

  console.log('| splats | SH | format | source | GLB | decode | write | total | RSS |');
  console.log('| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |');

  for (const count of options.counts) {
    for (const shDegree of options.degrees) {
      const rows = await runCase(count, shDegree, options.format);
      for (const row of rows) {
        console.log(
          `| ${count.toLocaleString()} | ${shDegree} | ${row.format} `
          + `| ${megabytes(row.sourceBytes)} | ${megabytes(row.glbBytes)} `
          + `| ${row.decodeMs.toFixed(0)} ms | ${row.writeMs.toFixed(0)} ms `
          + `| ${row.totalMs.toFixed(0)} ms | ${megabytes(row.rss)} |`,
        );
      }
      globalThis.gc?.();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
