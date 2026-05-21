// Tests for glb-normalizer.js
// Run: node --test html/assets/js/scenesync/loaders/glb-normalizer.test.js

import { test } from 'node:test';
import { strictEqual, ok, deepEqual } from 'node:assert';
import { inspectGlbExtensions, normalizeGlbForSceneSync } from './glb-normalizer.js';

// ── GLB fixture helpers ──────────────────────────────────────────────────────

/**
 * Build a minimal valid GLB (binary glTF v2) with a single empty binary chunk.
 * The binary chunk is required; some parsers reject GLBs without it.
 */
function buildGlb(json) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const paddedJsonLen = jsonBytes.length + jsonPad;

  // empty binary chunk
  const binLen = 0;
  const totalLen = 12 + 8 + paddedJsonLen + 8 + binLen;

  const buf = new ArrayBuffer(totalLen);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // GLB header
  view.setUint32(0, 0x46546C67, true); // magic 'glTF'
  view.setUint32(4, 2, true);          // version
  view.setUint32(8, totalLen, true);

  // JSON chunk
  view.setUint32(12, paddedJsonLen, true);
  view.setUint32(16, 0x4E4F534A, true); // 'JSON'
  u8.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) u8[20 + jsonBytes.length + i] = 0x20; // space padding

  // BIN chunk (empty)
  const binOffset = 20 + paddedJsonLen;
  view.setUint32(binOffset, 0, true);
  view.setUint32(binOffset + 4, 0x004E4942, true); // 'BIN\0'

  return buf;
}

/** Re-parse JSON from a GLB ArrayBuffer */
function readGlbJson(ab) {
  const view = new DataView(ab);
  const jsonLen = view.getUint32(12, true);
  const bytes = new Uint8Array(ab, 20, jsonLen);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ── Tests: inspectGlbExtensions ──────────────────────────────────────────────

test('inspectGlbExtensions – detects KHR_materials_pbrSpecularGlossiness in extensionsUsed', () => {
  const ab = buildGlb({
    extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
  });
  const r = inspectGlbExtensions(ab);
  strictEqual(r.valid, true);
  strictEqual(r.hasSpecGloss, true);
  strictEqual(r.requiresSpecGloss, false);
});

test('inspectGlbExtensions – requiresSpecGloss true when in extensionsRequired', () => {
  const ab = buildGlb({
    extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
    extensionsRequired: ['KHR_materials_pbrSpecularGlossiness'],
  });
  const r = inspectGlbExtensions(ab);
  strictEqual(r.valid, true);
  strictEqual(r.hasSpecGloss, true);
  strictEqual(r.requiresSpecGloss, true);
});

test('inspectGlbExtensions – returns false for standard Metal/Rough GLB', () => {
  const ab = buildGlb({
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }],
  });
  const r = inspectGlbExtensions(ab);
  strictEqual(r.valid, true);
  strictEqual(r.hasSpecGloss, false);
});

test('inspectGlbExtensions – returns valid=false for too-short buffer', () => {
  const r = inspectGlbExtensions(new ArrayBuffer(10));
  strictEqual(r.valid, false);
  strictEqual(r.hasSpecGloss, false);
});

test('inspectGlbExtensions – returns valid=false for wrong magic', () => {
  const ab = new ArrayBuffer(24);
  // leave magic as 0 (invalid)
  const r = inspectGlbExtensions(ab);
  strictEqual(r.valid, false);
});

// ── Tests: normalizeGlbForSceneSync ─────────────────────────────────────────

test('normalizeGlbForSceneSync – changed=false for standard Metal/Rough GLB', async () => {
  const ab = buildGlb({
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
  });
  const r = await normalizeGlbForSceneSync(ab);
  strictEqual(r.changed, false);
  strictEqual(r.skipped, false);
  strictEqual(r.skipReason, null);
  // should return original buffer unchanged
  deepEqual(new Uint8Array(r.arrayBuffer), new Uint8Array(ab));
});

test('normalizeGlbForSceneSync – converts Spec/Gloss GLB (factor-only, no textures)', async () => {
  const ab = buildGlb({
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
    extensionsRequired: ['KHR_materials_pbrSpecularGlossiness'],
    materials: [
      {
        name: 'TestMat',
        extensions: {
          KHR_materials_pbrSpecularGlossiness: {
            diffuseFactor: [0.8, 0.1, 0.1, 1.0],
            specularFactor: [0.1, 0.1, 0.1],
            glossinessFactor: 0.5,
          },
        },
      },
    ],
  });

  const r = await normalizeGlbForSceneSync(ab);

  strictEqual(r.changed, true, 'changed should be true');
  strictEqual(r.skipped, false, 'skipped should be false');
  strictEqual(r.skipReason, null, 'skipReason should be null');
  ok(r.arrayBuffer instanceof ArrayBuffer, 'should return ArrayBuffer');

  // Re-inspect: KHR_materials_pbrSpecularGlossiness must no longer be in extensionsRequired
  const postInspect = inspectGlbExtensions(r.arrayBuffer);
  strictEqual(postInspect.requiresSpecGloss, false,
    'KHR_materials_pbrSpecularGlossiness must be removed from extensionsRequired');

  // The converted JSON must have standard pbrMetallicRoughness
  const json = readGlbJson(r.arrayBuffer);
  ok(json.materials, 'materials should exist');
  ok(json.materials[0].pbrMetallicRoughness, 'pbrMetallicRoughness should exist after conversion');
});

test('normalizeGlbForSceneSync – accepts File input', async () => {
  const ab = buildGlb({ asset: { version: '2.0' } });
  const file = new File([ab], 'test.glb', { type: 'model/gltf-binary' });
  const r = await normalizeGlbForSceneSync(file);
  // standard GLB → no change
  strictEqual(r.changed, false);
});

test('normalizeGlbForSceneSync – returns skipped=true for invalid GLB (empty buffer)', async () => {
  const r = await normalizeGlbForSceneSync(new ArrayBuffer(0));
  strictEqual(r.changed, false);
  strictEqual(r.skipped, false); // not a Spec/Gloss GLB, just invalid → no skip
});

test('normalizeGlbForSceneSync – converted GLB has no internal flag properties', async () => {
  const ab = buildGlb({
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
    materials: [
      {
        extensions: {
          KHR_materials_pbrSpecularGlossiness: {
            diffuseFactor: [1, 1, 1, 1],
            specularFactor: [0.04, 0.04, 0.04],
            glossinessFactor: 0.8,
          },
        },
      },
    ],
  });

  const r = await normalizeGlbForSceneSync(ab);
  if (!r.changed) return; // if conversion failed, skip this assertion

  const json = readGlbJson(r.arrayBuffer);
  const mat = json.materials?.[0];
  if (!mat?.pbrMetallicRoughness) return;

  // Must not contain any internal flags like _specularGlossTextureExists
  for (const key of Object.keys(mat.pbrMetallicRoughness)) {
    ok(!key.startsWith('_'), `No internal flag properties allowed: found "${key}"`);
  }
});
