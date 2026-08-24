#!/usr/bin/env node
// Measure conversion time and peak memory for realistic Gaussian Splat captures.
//
//   node --expose-gc scripts/benchmark-gaussian-splat-import.mjs
//   node --expose-gc scripts/benchmark-gaussian-splat-import.mjs --counts 200000,1000000 --degrees 0,3
//
// Real captures run from a few hundred thousand to a few million splats. The
// conversion streams: splat-transform reads a chunk at a time, so the resident
// working set is set by the chunk size rather than the scene — but the GLB is
// still assembled whole in memory before SceneSync can hand it to the uploader,
// so peak memory tracks the output size. These numbers are what decide the
// upload ceiling and the chunk size the adapter asks for.

import { peakRss, resetPeakRss } from './lib/peak-rss.mjs';
import { convertGaussianSplatToGlb } from '../html/assets/js/scenesync/loaders/gaussian-splat/splat-transform-adapter.js';
import {
  SH_REST_COEFS_BY_DEGREE,
  buildGaussianSplatPly,
  buildSpzPayload,
} from '../html/assets/js/scenesync/loaders/gaussian-splat/test-fixtures.mjs';

function parseArgs(argv) {
  const options = { counts: [200_000, 500_000, 1_000_000], degrees: [0, 3], format: 'both' };

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

const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

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
  const formats = format === 'both' ? ['ply', 'spz'] : [format];

  for (const sourceFormat of formats) {
    const source = sourceFormat === 'ply'
      ? buildSource(count, shDegree, (s, d) => buildGaussianSplatPly(s, { shDegree: d }))
      // The uncompressed SPZ payload, so the numbers isolate decoding rather
      // than gzip throughput. The adapter accepts both framings.
      : buildSource(count, shDegree, (s, d) => buildSpzPayload(s, { version: 2, shDegree: d }));

    globalThis.gc?.();
    globalThis.gc?.();
    await resetPeakRss();
    const start = process.hrtime.bigint();

    const result = await convertGaussianSplatToGlb(source, { fileName: `bench.${sourceFormat}` });

    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    rows.push({
      format: sourceFormat,
      sourceBytes: source.byteLength,
      glbBytes: result.glb.byteLength,
      elapsedMs,
      memory: await peakRss(),
      splatCount: result.splatCount,
    });
  }

  return rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!globalThis.gc) {
    console.warn('Run with --expose-gc for stable memory numbers.\n');
  }

  console.log('| splats | SH | format | source | GLB | time | RSS growth |');
  console.log('| ---: | ---: | --- | ---: | ---: | ---: | ---: |');

  for (const count of options.counts) {
    for (const shDegree of options.degrees) {
      for (const row of await runCase(count, shDegree, options.format)) {
        console.log(
          `| ${count.toLocaleString()} | ${shDegree} | ${row.format} `
          + `| ${megabytes(row.sourceBytes)} | ${megabytes(row.glbBytes)} `
          + `| ${row.elapsedMs.toFixed(0)} ms | ${megabytes(row.memory.growth)} |`,
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
