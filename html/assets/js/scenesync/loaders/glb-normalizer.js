// GLB Normalizer: Converts KHR_materials_pbrSpecularGlossiness to standard pbrMetallicRoughness
// Uses glTF Transform metalRough() for proper conversion including texture handling.

import { WebIO } from '@gltf-transform/core';
import {
  KHRMaterialsPBRSpecularGlossiness,
  KHRMaterialsIOR,
  KHRMaterialsSpecular,
} from '@gltf-transform/extensions';
import { metalRough } from '@gltf-transform/functions';

const EXT_SPEC_GLOSS = 'KHR_materials_pbrSpecularGlossiness';

let _io = null;

function getIO() {
  if (!_io) {
    _io = new WebIO().registerExtensions([
      KHRMaterialsPBRSpecularGlossiness,
      KHRMaterialsIOR,
      KHRMaterialsSpecular,
    ]);
  }
  return _io;
}

/**
 * Inspect GLB extensions without full parsing (lightweight, no external deps).
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ valid, hasSpecGloss, requiresSpecGloss, extensionsUsed, extensionsRequired, materialCount }}
 */
export function inspectGlbExtensions(arrayBuffer) {
  const fail = (extra = {}) => ({
    valid: false,
    hasSpecGloss: false,
    requiresSpecGloss: false,
    extensionsUsed: [],
    extensionsRequired: [],
    ...extra,
  });

  if (!arrayBuffer || arrayBuffer.byteLength < 20) return fail();

  try {
    const view = new DataView(arrayBuffer);

    if (view.getUint32(0, true) !== 0x46546C67) return fail(); // magic 'glTF'
    if (view.getUint32(4, true) !== 2) return fail();          // version 2

    const jsonChunkLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4E4F534A) return fail(); // chunk type 'JSON'
    if (20 + jsonChunkLength > arrayBuffer.byteLength) return fail();

    const jsonBytes = new Uint8Array(arrayBuffer, 20, jsonChunkLength);
    const json = JSON.parse(new TextDecoder().decode(jsonBytes));

    const extensionsUsed = json.extensionsUsed || [];
    const extensionsRequired = json.extensionsRequired || [];

    const hasSpecGloss =
      extensionsUsed.includes(EXT_SPEC_GLOSS) ||
      extensionsRequired.includes(EXT_SPEC_GLOSS);

    return {
      valid: true,
      hasSpecGloss,
      requiresSpecGloss: extensionsRequired.includes(EXT_SPEC_GLOSS),
      extensionsUsed,
      extensionsRequired,
      materialCount: json.materials?.length || 0,
    };
  } catch (error) {
    console.warn('[glb-normalizer] Failed to inspect GLB extensions', error);
    return fail({ error: error.message });
  }
}

/**
 * Normalize GLB for Scene Sync: converts KHR_materials_pbrSpecularGlossiness
 * to standard pbrMetallicRoughness using glTF Transform's metalRough() transform.
 *
 * @param {File|ArrayBuffer} fileOrArrayBuffer
 * @returns {Promise<{
 *   arrayBuffer: ArrayBuffer,
 *   changed: boolean,
 *   skipped: boolean,
 *   skipReason: string|null,
 *   inspection: object,
 *   warnings: string[],
 *   error?: Error,
 * }>}
 */
export async function normalizeGlbForSceneSync(fileOrArrayBuffer) {
  const arrayBuffer =
    fileOrArrayBuffer instanceof File
      ? await fileOrArrayBuffer.arrayBuffer()
      : fileOrArrayBuffer;

  const ok = (changed, skipped, skipReason, inspection, warnings = [], extra = {}) => ({
    arrayBuffer,
    changed,
    skipped,
    skipReason,
    inspection,
    warnings,
    ...extra,
  });

  if (!arrayBuffer || arrayBuffer.byteLength < 20) {
    return ok(false, false, null, { valid: false });
  }

  const inspection = inspectGlbExtensions(arrayBuffer);

  if (!inspection.valid || !inspection.hasSpecGloss) {
    return ok(false, false, null, inspection);
  }

  try {
    const io = getIO();
    const input = new Uint8Array(arrayBuffer);

    const document = await io.readBinary(input);

    await document.transform(metalRough());

    const output = await io.writeBinary(document);

    const normalizedBuffer = output.buffer.slice(
      output.byteOffset,
      output.byteOffset + output.byteLength,
    );

    return {
      arrayBuffer: normalizedBuffer,
      changed: true,
      skipped: false,
      skipReason: null,
      inspection,
      warnings: [],
    };
  } catch (error) {
    console.warn('[glb-normalizer] glTF Transform metalRough failed', error);

    return ok(false, true, 'metalRoughFailed', inspection, [
      `Failed to convert ${EXT_SPEC_GLOSS}: ${error.message}`,
    ], { error });
  }
}
