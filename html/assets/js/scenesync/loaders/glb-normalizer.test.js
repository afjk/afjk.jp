// Tests for GLB Normalizer
// Run with: node --test glb-normalizer.test.js (after setting up ESM environment)

import { inspectGlbExtensions, normalizeGlbForSceneSync } from './glb-normalizer.js';
import { test } from 'node:test';
import { strictEqual, deepEqual, ok, match } from 'node:assert';

// Helper for floating-point comparison with tolerance
function assertClose(actual, expected, tolerance = 0.0001) {
  ok(Math.abs(actual - expected) < tolerance, `Expected ${actual} to be close to ${expected}`);
}

/**
 * Helper to create a minimal valid GLB with JSON chunk
 */
function createMinimalGlb(json) {
  const jsonString = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(jsonString);
  const jsonLength = jsonBytes.length;

  // Minimal binary chunk (empty)
  const binaryChunkLength = 0;

  // Total length: 12 (header) + 8 (JSON chunk header) + jsonLength + padding
  const jsonPaddingLength = (4 - (jsonLength % 4)) % 4;
  const totalLength = 12 + (8 + jsonLength + jsonPaddingLength) + (8 + binaryChunkLength);

  const glb = new ArrayBuffer(totalLength);
  const view = new DataView(glb);
  const uint8 = new Uint8Array(glb);

  // Header
  view.setUint32(0, 0x46546C67, true); // magic: 'glTF'
  view.setUint32(4, 2, true); // version
  view.setUint32(8, totalLength, true); // length

  // JSON chunk header
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4E4F534A, true); // type: 'JSON'

  // JSON data
  uint8.set(jsonBytes, 20);

  // JSON padding
  const jsonPadStart = 20 + jsonLength;
  for (let i = 0; i < jsonPaddingLength; i++) {
    uint8[jsonPadStart + i] = 0x20; // space
  }

  return glb;
}

test('inspectGlbExtensions - detects KHR_materials_pbrSpecularGlossiness', (t) => {
  const glb = createMinimalGlb({
    extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
    extensionsRequired: [],
    materials: [],
  });

  const result = inspectGlbExtensions(glb);
  strictEqual(result.valid, true);
  strictEqual(result.hasSpecGloss, true);
  strictEqual(result.requiresSpecGloss, false);
});

test('inspectGlbExtensions - detects required KHR_materials_pbrSpecularGlossiness', (t) => {
  const glb = createMinimalGlb({
    extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
    extensionsRequired: ['KHR_materials_pbrSpecularGlossiness'],
    materials: [],
  });

  const result = inspectGlbExtensions(glb);
  strictEqual(result.valid, true);
  strictEqual(result.hasSpecGloss, true);
  strictEqual(result.requiresSpecGloss, true);
});

test('inspectGlbExtensions - returns false when extension not present', (t) => {
  const glb = createMinimalGlb({
    extensionsUsed: ['KHR_materials_clearcoat'],
    extensionsRequired: [],
    materials: [],
  });

  const result = inspectGlbExtensions(glb);
  strictEqual(result.valid, true);
  strictEqual(result.hasSpecGloss, false);
  strictEqual(result.requiresSpecGloss, false);
});

test('inspectGlbExtensions - returns valid=false for invalid GLB', (t) => {
  const invalidGlb = new ArrayBuffer(10); // Too short
  const result = inspectGlbExtensions(invalidGlb);
  strictEqual(result.valid, false);
  strictEqual(result.hasSpecGloss, false);
});

test('normalizeGlbForSceneSync - returns unchanged when no Spec/Gloss', async (t) => {
  const glb = createMinimalGlb({
    extensionsUsed: [],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
  });

  const result = await normalizeGlbForSceneSync(glb);
  strictEqual(result.changed, false);
  deepEqual(result.arrayBuffer, glb);
});

test('normalizeGlbForSceneSync - converts Spec/Gloss material', async (t) => {
  const glb = createMinimalGlb({
    extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
    materials: [
      {
        name: 'TestMaterial',
        extensions: {
          KHR_materials_pbrSpecularGlossiness: {
            diffuseFactor: [0.5, 0.5, 0.5, 1.0],
            glossinessFactor: 0.8,
          },
        },
      },
    ],
  });

  const result = await normalizeGlbForSceneSync(glb);
  strictEqual(result.changed, true);
  ok(result.warnings?.length > 0);

  // Verify the converted JSON
  const view = new DataView(result.arrayBuffer);
  const jsonChunkLength = view.getUint32(12, true);
  const jsonBytes = new Uint8Array(result.arrayBuffer, 20, jsonChunkLength);
  const jsonString = new TextDecoder().decode(jsonBytes);
  const json = JSON.parse(jsonString);

  strictEqual(json.materials[0].extensions?.KHR_materials_pbrSpecularGlossiness, undefined);
  ok(json.materials[0].pbrMetallicRoughness);
  deepEqual(json.materials[0].pbrMetallicRoughness.baseColorFactor, [0.5, 0.5, 0.5, 1.0]);
  assertClose(json.materials[0].pbrMetallicRoughness.roughnessFactor, 0.2); // 1 - 0.8
  strictEqual(json.materials[0].pbrMetallicRoughness.metallicFactor, 0);
});

test('normalizeGlbForSceneSync - removes extension from extensionsUsed', async (t) => {
  const glb = createMinimalGlb({
    extensionsUsed: ['KHR_materials_pbrSpecularGlossiness', 'KHR_materials_clearcoat'],
    materials: [
      {
        extensions: {
          KHR_materials_pbrSpecularGlossiness: {
            diffuseFactor: [1, 1, 1, 1],
            glossinessFactor: 0.5,
          },
        },
      },
    ],
  });

  const result = await normalizeGlbForSceneSync(glb);
  strictEqual(result.changed, true);

  // Verify the converted JSON
  const view = new DataView(result.arrayBuffer);
  const jsonChunkLength = view.getUint32(12, true);
  const jsonBytes = new Uint8Array(result.arrayBuffer, 20, jsonChunkLength);
  const jsonString = new TextDecoder().decode(jsonBytes);
  const json = JSON.parse(jsonString);

  ok(json.extensionsUsed.includes('KHR_materials_clearcoat'));
  strictEqual(json.extensionsUsed.includes('KHR_materials_pbrSpecularGlossiness'), false);
});

test('normalizeGlbForSceneSync - removes extensionsUsed when empty', async (t) => {
  const glb = createMinimalGlb({
    extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
    materials: [
      {
        extensions: {
          KHR_materials_pbrSpecularGlossiness: {
            diffuseFactor: [1, 1, 1, 1],
            glossinessFactor: 0.5,
          },
        },
      },
    ],
  });

  const result = await normalizeGlbForSceneSync(glb);
  strictEqual(result.changed, true);

  // Verify the converted JSON
  const view = new DataView(result.arrayBuffer);
  const jsonChunkLength = view.getUint32(12, true);
  const jsonBytes = new Uint8Array(result.arrayBuffer, 20, jsonChunkLength);
  const jsonString = new TextDecoder().decode(jsonBytes);
  const json = JSON.parse(jsonString);

  strictEqual(json.extensionsUsed, undefined);
});

test('normalizeGlbForSceneSync - handles multiple materials', async (t) => {
  const glb = createMinimalGlb({
    extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
    materials: [
      {
        name: 'Mat1',
        extensions: {
          KHR_materials_pbrSpecularGlossiness: {
            diffuseFactor: [1, 0, 0, 1],
            glossinessFactor: 0.7,
          },
        },
      },
      {
        name: 'Mat2',
        extensions: {
          KHR_materials_pbrSpecularGlossiness: {
            diffuseFactor: [0, 1, 0, 1],
            glossinessFactor: 0.9,
          },
        },
      },
    ],
  });

  const result = await normalizeGlbForSceneSync(glb);
  strictEqual(result.changed, true);

  // Verify the converted JSON
  const view = new DataView(result.arrayBuffer);
  const jsonChunkLength = view.getUint32(12, true);
  const jsonBytes = new Uint8Array(result.arrayBuffer, 20, jsonChunkLength);
  const jsonString = new TextDecoder().decode(jsonBytes);
  const json = JSON.parse(jsonString);

  strictEqual(json.materials.length, 2);
  assertClose(json.materials[0].pbrMetallicRoughness.roughnessFactor, 0.3); // 1 - 0.7
  assertClose(json.materials[1].pbrMetallicRoughness.roughnessFactor, 0.1); // 1 - 0.9
});
