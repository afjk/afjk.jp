import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectSplatFormat,
  importGaussianSplatAsset,
  UnsupportedPlyVariantError,
} from './import-gaussian-splat.js';
import { buildSplatAttributes, writeGaussianSplatGlb } from './khr-glb-writer.js';
import { createSplatCloud, SH_C0 } from './splat-cloud.js';
import { buildGaussianSplatPly, buildSpzPayload, gzipBytes } from './test-fixtures.mjs';
import { inspectGaussianSplatGlb, parseGlbJson } from '../khr-gaussian-splatting.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE = [
  {
    position: [1, 2, 3],
    scale: [0.1, 0.2, 0.3],
    rotation: [0, 0, 0, 1],
    opacity: 0.75,
    sh0: [1.5, -0.5, 0.25],
  },
  {
    position: [-4, 5, -6],
    scale: [0.05, 0.05, 0.05],
    rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    opacity: 0.25,
    sh0: [-1, 0, 1],
  },
];

/** Read one accessor back out of a GLB, for verifying the writer. */
function readAccessor(glb, accessorIndex) {
  const json = parseGlbJson(glb);
  const accessor = json.accessors[accessorIndex];
  const bufferView = json.bufferViews[accessor.bufferView];

  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  // Walk chunks to find BIN rather than assuming the JSON chunk's length.
  let offset = 12;
  let binStart = -1;
  while (offset + 8 <= glb.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    if (chunkType === 0x004e4942) {
      binStart = offset + 8;
      break;
    }
    offset += 8 + chunkLength;
  }
  assert.ok(binStart >= 0, 'GLB has no BIN chunk');

  const components = { SCALAR: 1, VEC3: 3, VEC4: 4 }[accessor.type];
  const start = binStart + bufferView.byteOffset + (accessor.byteOffset || 0);
  const out = new Float32Array(accessor.count * components);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(start + i * 4, true);
  return out;
}

function attributeIndex(glb, semantic) {
  const json = parseGlbJson(glb);
  return json.meshes[0].primitives[0].attributes[semantic];
}

test('detectSplatFormat sniffs containers by magic', async () => {
  assert.equal(detectSplatFormat(buildGaussianSplatPly(SAMPLE)), 'ply');
  assert.equal(detectSplatFormat(await gzipBytes(buildSpzPayload(SAMPLE))), 'spz');

  const glb = writeGaussianSplatGlb(readCloudFromPly());
  assert.equal(detectSplatFormat(glb), 'glb');

  assert.equal(detectSplatFormat(new Uint8Array([1, 2, 3, 4])), 'unknown');
  assert.equal(detectSplatFormat(new Uint8Array([1, 2, 3, 4]), 'scan.spz'), 'spz');
});

function readCloudFromPly() {
  const cloud = createSplatCloud(1, 0);
  cloud.positions.set([1, 2, 3]);
  cloud.rotations.set([0, 0, 0, 1]);
  cloud.scales.set([0.1, 0.1, 0.1]);
  cloud.opacities.set([0.5]);
  cloud.sh0.set([0.1, 0.2, 0.3]);
  return cloud;
}

test('writeGaussianSplatGlb emits a GLB the KHR inspector accepts', async () => {
  const { glb } = await importGaussianSplatAsset(buildGaussianSplatPly(SAMPLE), {
    fileName: 'scan.ply',
  });

  const inspection = inspectGaussianSplatGlb(glb);
  assert.equal(inspection.hasGaussianSplatting, true);
  assert.equal(inspection.extensionDeclared, true);
  assert.deepEqual(inspection.errors, []);
  assert.deepEqual(inspection.warnings, []);
  assert.equal(inspection.valid, true);
  assert.equal(inspection.primitives[0].validMode, true);
  assert.equal(inspection.primitives[0].missingAttributes.length, 0);
});

test('writeGaussianSplatGlb produces a self-consistent GLB header', async () => {
  const { glb } = await importGaussianSplatAsset(buildGaussianSplatPly(SAMPLE));
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);

  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(
    view.getUint32(8, true),
    glb.byteLength,
    'declared GLB length must match the actual byte length',
  );
  assert.equal(glb.byteLength % 4, 0);
});

test('PLY to GLB preserves position, scale, opacity and SH values', async () => {
  const { glb, splatCount } = await importGaussianSplatAsset(buildGaussianSplatPly(SAMPLE));
  assert.equal(splatCount, 2);

  const positions = readAccessor(glb, attributeIndex(glb, 'POSITION'));
  assert.deepEqual(Array.from(positions.slice(0, 3)), [1, 2, 3]);
  assert.deepEqual(Array.from(positions.slice(3, 6)), [-4, 5, -6]);

  const scales = readAccessor(glb, attributeIndex(glb, 'KHR_gaussian_splatting:SCALE'));
  assert.ok(Math.abs(scales[0] - 0.1) < 1e-6, 'scale must be linear, not log');
  assert.ok(Math.abs(scales[2] - 0.3) < 1e-6);

  const opacity = readAccessor(glb, attributeIndex(glb, 'KHR_gaussian_splatting:OPACITY'));
  assert.ok(Math.abs(opacity[0] - 0.75) < 1e-6, 'opacity must be linear alpha, not a logit');

  const sh0 = readAccessor(glb, attributeIndex(glb, 'KHR_gaussian_splatting:SH_DEGREE_0_COEF_0'));
  assert.ok(Math.abs(sh0[0] - 1.5) < 1e-6, 'SH0 must stay a coefficient, not become RGB');
  assert.ok(Math.abs(sh0[0] * SH_C0 + 0.5 - 0.923) < 0.01, 'and must map to the expected color');

  const rotations = readAccessor(glb, attributeIndex(glb, 'KHR_gaussian_splatting:ROTATION'));
  assert.deepEqual(Array.from(rotations.slice(0, 4)), [0, 0, 0, 1]);
});

test('POSITION accessor carries the required min and max bounds', async () => {
  const { glb } = await importGaussianSplatAsset(buildGaussianSplatPly(SAMPLE));
  const json = parseGlbJson(glb);
  const accessor = json.accessors[attributeIndex(glb, 'POSITION')];

  assert.deepEqual(accessor.min, [-4, 2, -6]);
  assert.deepEqual(accessor.max, [1, 5, 3]);
});

test('higher order SH is split into one accessor per coefficient', async () => {
  const shRest = Array.from({ length: 45 }, (_, i) => i / 100);
  const ply = buildGaussianSplatPly([{ ...SAMPLE[0], shRest }], { shDegree: 3 });
  const { glb, shDegree } = await importGaussianSplatAsset(ply);

  assert.equal(shDegree, 3);

  const json = parseGlbJson(glb);
  const attributes = json.meshes[0].primitives[0].attributes;

  // 1 + 3 + 5 + 7 SH accessors plus position, rotation, scale and opacity.
  assert.equal(Object.keys(attributes).length, 4 + 16);
  for (const [degree, coefs] of [[1, 3], [2, 5], [3, 7]]) {
    for (let coef = 0; coef < coefs; coef++) {
      const semantic = `KHR_gaussian_splatting:SH_DEGREE_${degree}_COEF_${coef}`;
      assert.ok(semantic in attributes, `missing ${semantic}`);
    }
  }

  // Coefficient 0 of degree 1 is the first entry of the interleaved rest array.
  const first = readAccessor(glb, attributes['KHR_gaussian_splatting:SH_DEGREE_1_COEF_0']);
  assert.ok(Math.abs(first[0] - shRest[0]) < 1e-6);
  assert.ok(Math.abs(first[1] - shRest[1]) < 1e-6);
  assert.ok(Math.abs(first[2] - shRest[2]) < 1e-6);

  // Degree 3's last coefficient is the final triple.
  const last = readAccessor(glb, attributes['KHR_gaussian_splatting:SH_DEGREE_3_COEF_6']);
  assert.ok(Math.abs(last[0] - shRest[42]) < 1e-6);
  assert.ok(Math.abs(last[2] - shRest[44]) < 1e-6);
});

test('SPZ to GLB round-trips through the same writer', async () => {
  const spz = await gzipBytes(buildSpzPayload(SAMPLE, { version: 2 }));
  const { glb, sourceFormat, splatCount } = await importGaussianSplatAsset(spz, {
    fileName: 'capture.spz',
  });

  assert.equal(sourceFormat, 'spz');
  assert.equal(splatCount, 2);
  assert.equal(inspectGaussianSplatGlb(glb).valid, true);

  const positions = readAccessor(glb, attributeIndex(glb, 'POSITION'));
  assert.ok(Math.abs(positions[0] - 1) < 1e-3);
  assert.ok(Math.abs(positions[4] - 5) < 1e-3);

  const opacity = readAccessor(glb, attributeIndex(glb, 'KHR_gaussian_splatting:OPACITY'));
  assert.ok(Math.abs(opacity[0] - 0.75) < 0.01);
});

test('PLY and SPZ encodings of the same scene decode to the same cloud', async () => {
  // The two formats share nothing but the values they describe: PLY stores
  // logits and log scales as float32, SPZ stores quantized bytes. Agreeing
  // within quantization error means both activation paths are right.
  const splats = SAMPLE.map((splat) => ({ ...splat, shRest: null }));

  const fromPly = await importGaussianSplatAsset(buildGaussianSplatPly(splats));
  const fromSpz = await importGaussianSplatAsset(buildSpzPayload(splats), { fileName: 's.spz' });

  const compare = (semantic, tolerance) => {
    const a = readAccessor(fromPly.glb, attributeIndex(fromPly.glb, semantic));
    const b = readAccessor(fromSpz.glb, attributeIndex(fromSpz.glb, semantic));
    assert.equal(a.length, b.length, semantic);
    for (let i = 0; i < a.length; i++) {
      assert.ok(
        Math.abs(a[i] - b[i]) <= tolerance,
        `${semantic}[${i}]: ply ${a[i]} vs spz ${b[i]}`,
      );
    }
  };

  compare('POSITION', 1e-3);                                  // 1/4096 fixed point
  compare('KHR_gaussian_splatting:SCALE', 0.01);              // log byte quantization
  compare('KHR_gaussian_splatting:OPACITY', 0.01);            // 8 bit alpha
  compare('KHR_gaussian_splatting:ROTATION', 0.02);           // 8 bit per component
  compare('KHR_gaussian_splatting:SH_DEGREE_0_COEF_0', 0.05); // 0.15 color scale
});

test('the mesh and node take their name from the source file', async () => {
  const { glb } = await importGaussianSplatAsset(buildGaussianSplatPly(SAMPLE), {
    fileName: 'captures/garden_scan.ply',
  });
  const json = parseGlbJson(glb);

  assert.equal(json.meshes[0].name, 'garden_scan');
  assert.equal(json.nodes[0].name, 'garden_scan');
});

test('upAxisCorrection is opt-in and never rewrites splat data', async () => {
  const ply = buildGaussianSplatPly(SAMPLE);

  const plain = await importGaussianSplatAsset(ply);
  assert.equal(parseGlbJson(plain.glb).nodes[0].rotation, undefined);

  const flipped = await importGaussianSplatAsset(ply, { upAxisCorrection: 'flip-x-180' });
  assert.deepEqual(parseGlbJson(flipped.glb).nodes[0].rotation, [1, 0, 0, 0]);

  // The correction lives on the node, so the positions are untouched.
  const before = readAccessor(plain.glb, attributeIndex(plain.glb, 'POSITION'));
  const after = readAccessor(flipped.glb, attributeIndex(flipped.glb, 'POSITION'));
  assert.deepEqual(Array.from(before), Array.from(after));
});

test('writeGaussianSplatGlb rejects an unknown upAxisCorrection', () => {
  assert.throws(
    () => writeGaussianSplatGlb(readCloudFromPly(), { upAxisCorrection: 'flip-y' }),
    /Unknown upAxisCorrection/,
  );
});

test('writeGaussianSplatGlb refuses an empty cloud', () => {
  assert.throws(() => writeGaussianSplatGlb(createSplatCloud(0, 0)), /empty splat cloud/);
});

test('buildSplatAttributes marks the antialiased kernel from SPZ', async () => {
  const spz = buildSpzPayload(SAMPLE, { antialiased: true });
  const { glb } = await importGaussianSplatAsset(spz, { fileName: 'aa.spz' });
  const extension = parseGlbJson(glb).meshes[0].primitives[0].extensions.KHR_gaussian_splatting;

  assert.equal(extension.antialiased, true);
  assert.equal(extension.kernel, 'ellipse');
  assert.equal(buildSplatAttributes(readCloudFromPly()).length, 5);
});

test('a KHR GLB input passes through untouched', async () => {
  const source = await importGaussianSplatAsset(buildGaussianSplatPly(SAMPLE));
  const reimported = await importGaussianSplatAsset(source.glb, { fileName: 'scan.glb' });

  assert.equal(reimported.sourceFormat, 'glb');
  assert.deepEqual(Array.from(reimported.glb), Array.from(source.glb));
});

test('a GLB without the extension is rejected rather than silently imported', async () => {
  const glb = writeGaussianSplatGlb(readCloudFromPly());
  const json = parseGlbJson(glb);
  delete json.meshes[0].primitives[0].extensions;

  // Rebuild just the JSON chunk so the container stays valid.
  const rebuilt = rebuildGlbJson(glb, json);
  await assert.rejects(
    () => importGaussianSplatAsset(rebuilt, { fileName: 'plain.glb' }),
    /does not contain a KHR_gaussian_splatting primitive/,
  );
});

test('an unrecognized container reports the supported inputs', async () => {
  await assert.rejects(
    () => importGaussianSplatAsset(new Uint8Array([9, 9, 9, 9]), { fileName: 'scan.xyz' }),
    /Supported inputs are \.ply, \.spz and KHR_gaussian_splatting \.glb/,
  );
});

test('a non-splat PLY surfaces the variant reason', async () => {
  const ply = new TextEncoder().encode([
    'ply', 'format ascii 1.0', 'element vertex 1',
    'property float x', 'property float y', 'property float z',
    'end_header', '0 0 0', '',
  ].join('\n'));

  await assert.rejects(
    () => importGaussianSplatAsset(ply, { fileName: 'cloud.ply' }),
    (error) => {
      assert.ok(error instanceof UnsupportedPlyVariantError);
      assert.equal(error.variant, 'not-gaussian-splat');
      return true;
    },
  );
});

test('the committed 8-splat fixture still satisfies the KHR inspector', () => {
  const fixture = fs.readFileSync(path.resolve(
    currentDir,
    '../../../../../scenesync/experiments/fixtures/minimal-khr-gaussian-splatting.glb',
  ));
  const bytes = new Uint8Array(fixture.buffer, fixture.byteOffset, fixture.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  assert.equal(
    view.getUint32(8, true),
    bytes.byteLength,
    'fixture GLB header length must match the file size',
  );
  assert.equal(inspectGaussianSplatGlb(bytes).valid, true);
});

function rebuildGlbJson(glb, json) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonChunkLength = view.getUint32(12, true);
  const binChunkStart = 12 + 8 + jsonChunkLength;
  const rest = glb.subarray(binChunkStart);

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const padded = (jsonBytes.byteLength + 3) & ~3;
  const total = 12 + 8 + padded + rest.byteLength;

  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, 0x46546c67, true);
  outView.setUint32(4, 2, true);
  outView.setUint32(8, total, true);
  outView.setUint32(12, padded, true);
  outView.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + padded);
  out.set(rest, 20 + padded);
  return out;
}
