// GLB Normalizer: Converts KHR_materials_pbrSpecularGlossiness to standard pbrMetallicRoughness
// Spec: https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_pbrSpecularGlossiness

const EXT_SPEC_GLOSS = 'KHR_materials_pbrSpecularGlossiness';
const EXT_SPEC_GLOSS_TEXTURE = 'KHR_materials_pbrSpecularGlossiness::texture';

/**
 * Inspect GLB extensions without full parsing
 * @param {ArrayBuffer} arrayBuffer - GLB file as ArrayBuffer
 * @returns {Object} Inspection result with extension info
 */
export function inspectGlbExtensions(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 20) {
    return {
      valid: false,
      hasSpecGloss: false,
      requiresSpecGloss: false,
      extensionsUsed: [],
      extensionsRequired: [],
    };
  }

  try {
    const view = new DataView(arrayBuffer);
    const magic = view.getUint32(0, true);
    const version = view.getUint32(4, true);

    if (magic !== 0x46546C67) { // 'glTF' in little-endian
      return {
        valid: false,
        hasSpecGloss: false,
        requiresSpecGloss: false,
        extensionsUsed: [],
        extensionsRequired: [],
      };
    }

    if (version !== 2) {
      return {
        valid: false,
        hasSpecGloss: false,
        requiresSpecGloss: false,
        extensionsUsed: [],
        extensionsRequired: [],
      };
    }

    // Skip to first chunk (JSON)
    // GLB header: 4 (magic) + 4 (version) + 4 (length)
    // Chunk header: 4 (length) + 4 (type)
    const jsonChunkLength = view.getUint32(12, true);
    const jsonChunkType = view.getUint32(16, true);

    if (jsonChunkType !== 0x4E4F534A) { // 'JSON' in little-endian
      return {
        valid: false,
        hasSpecGloss: false,
        requiresSpecGloss: false,
        extensionsUsed: [],
        extensionsRequired: [],
      };
    }

    const jsonStart = 20;
    const jsonEnd = jsonStart + jsonChunkLength;

    if (jsonEnd > arrayBuffer.byteLength) {
      return {
        valid: false,
        hasSpecGloss: false,
        requiresSpecGloss: false,
        extensionsUsed: [],
        extensionsRequired: [],
      };
    }

    const jsonBytes = new Uint8Array(arrayBuffer, jsonStart, jsonChunkLength);
    const jsonString = new TextDecoder().decode(jsonBytes);
    const json = JSON.parse(jsonString);

    const extensionsUsed = json.extensionsUsed || [];
    const extensionsRequired = json.extensionsRequired || [];

    const hasSpecGloss =
      extensionsUsed.includes(EXT_SPEC_GLOSS) ||
      extensionsRequired.includes(EXT_SPEC_GLOSS);

    const requiresSpecGloss = extensionsRequired.includes(EXT_SPEC_GLOSS);

    return {
      valid: true,
      hasSpecGloss,
      requiresSpecGloss,
      extensionsUsed,
      extensionsRequired,
      materialCount: json.materials?.length || 0,
    };
  } catch (error) {
    console.warn('[glb-normalizer] Failed to inspect GLB extensions', error);
    return {
      valid: false,
      hasSpecGloss: false,
      requiresSpecGloss: false,
      extensionsUsed: [],
      extensionsRequired: [],
      error: error.message,
    };
  }
}

/**
 * Convert Spec/Gloss material extension to Metal/Rough
 * Based on the conversion formulas from the glTF extension spec
 */
function convertSpecGlossToMetalRough(specGlossExt) {
  if (!specGlossExt) return {};

  const result = {};

  // diffuseFactor -> baseColorFactor
  if (specGlossExt.diffuseFactor) {
    result.baseColorFactor = [...specGlossExt.diffuseFactor];
  }

  // diffuseTexture -> baseColorTexture
  if (specGlossExt.diffuseTexture) {
    result.baseColorTexture = { ...specGlossExt.diffuseTexture };
  }

  // specularFactor + glossinessFactor -> metallicFactor + roughnessFactor
  // Use a simplified conversion: assume non-metallic (typical for most models)
  // metallic = 0.0, roughness = 1.0 - glossiness
  const glossiness = specGlossExt.glossinessFactor ?? 1.0;
  result.roughnessFactor = 1.0 - glossiness;
  result.metallicFactor = 0.0; // Assume non-metallic by default

  // Handle specularGlossiness texture -> roughness texture
  // This is more complex; we'll create a placeholder approach
  if (specGlossExt.specularGlossinessTexture) {
    // In a real conversion, we'd need to process the texture data
    // For now, we'll note that the texture exists but skip texture conversion
    result._specularGlossTextureExists = true;
  }

  return result;
}

/**
 * Normalize GLB by converting Spec/Gloss materials to Metal/Rough
 * @param {File|ArrayBuffer} fileOrArrayBuffer - GLB file or ArrayBuffer
 * @param {Object} options - Conversion options
 * @returns {Promise<Object>} Result object
 */
export async function normalizeGlbForSceneSync(fileOrArrayBuffer, options = {}) {
  try {
    const arrayBuffer =
      fileOrArrayBuffer instanceof File
        ? await fileOrArrayBuffer.arrayBuffer()
        : fileOrArrayBuffer;

    if (!arrayBuffer || arrayBuffer.byteLength < 20) {
      return {
        arrayBuffer,
        changed: false,
        inspection: { valid: false },
        warnings: [],
      };
    }

    const inspection = inspectGlbExtensions(arrayBuffer);

    if (!inspection.valid || !inspection.hasSpecGloss) {
      return {
        arrayBuffer,
        changed: false,
        inspection,
        warnings: [],
      };
    }

    // Parse GLB and convert materials
    const result = convertGlbMaterials(arrayBuffer);

    if (result.error) {
      console.warn('[glb-normalizer] Failed to convert', result.error);
      return {
        arrayBuffer,
        changed: false,
        inspection,
        warnings: [result.error],
      };
    }

    return {
      arrayBuffer: result.arrayBuffer,
      changed: true,
      inspection,
      warnings: result.warnings || [],
    };
  } catch (error) {
    console.warn('[glb-normalizer] Normalization failed', error);
    throw error;
  }
}

/**
 * Convert materials in GLB from Spec/Gloss to Metal/Rough
 */
function convertGlbMaterials(arrayBuffer) {
  try {
    const view = new DataView(arrayBuffer);

    // Parse GLB header
    const magic = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    const totalLength = view.getUint32(8, true);

    if (magic !== 0x46546C67 || version !== 2) {
      return { error: 'Invalid GLB format' };
    }

    // Parse JSON chunk
    const jsonChunkLength = view.getUint32(12, true);
    const jsonChunkType = view.getUint32(16, true);

    if (jsonChunkType !== 0x4E4F534A) {
      return { error: 'No JSON chunk found' };
    }

    const jsonStart = 20;
    const jsonBytes = new Uint8Array(arrayBuffer, jsonStart, jsonChunkLength);
    const jsonString = new TextDecoder().decode(jsonBytes);
    const json = JSON.parse(jsonString);

    const warnings = [];

    // Convert materials
    if (json.materials && Array.isArray(json.materials)) {
      for (let i = 0; i < json.materials.length; i++) {
        const material = json.materials[i];

        if (material.extensions && material.extensions[EXT_SPEC_GLOSS]) {
          const specGloss = material.extensions[EXT_SPEC_GLOSS];

          // Convert to Metal/Rough
          const converted = convertSpecGlossToMetalRough(specGloss);

          // Merge converted properties
          if (!material.pbrMetallicRoughness) {
            material.pbrMetallicRoughness = {};
          }

          Object.assign(material.pbrMetallicRoughness, converted);

          // Remove Spec/Gloss extension
          delete material.extensions[EXT_SPEC_GLOSS];

          // Clean up empty extensions object
          if (Object.keys(material.extensions).length === 0) {
            delete material.extensions;
          }

          warnings.push(`Material ${i}: Converted from Spec/Gloss to Metal/Rough`);

          if (converted._specularGlossTextureExists) {
            warnings.push(`Material ${i}: Specular-Glossiness texture not converted`);
            delete converted._specularGlossTextureExists;
          }
        }
      }
    }

    // Update extensionsUsed and extensionsRequired
    if (json.extensionsUsed) {
      json.extensionsUsed = json.extensionsUsed.filter(
        (ext) => ext !== EXT_SPEC_GLOSS
      );
      if (json.extensionsUsed.length === 0) {
        delete json.extensionsUsed;
      }
    }

    if (json.extensionsRequired) {
      json.extensionsRequired = json.extensionsRequired.filter(
        (ext) => ext !== EXT_SPEC_GLOSS
      );
      if (json.extensionsRequired.length === 0) {
        delete json.extensionsRequired;
      }
    }

    // Rebuild GLB with modified JSON
    const newJsonString = JSON.stringify(json);
    const newJsonBytes = new TextEncoder().encode(newJsonString);
    const newJsonLength = newJsonBytes.length;

    // GLB binary chunk starts after JSON chunk + padding
    const jsonPaddingLength = (4 - (jsonChunkLength % 4)) % 4;
    const binaryChunkStart = jsonStart + jsonChunkLength + jsonPaddingLength;

    const binaryChunkLength = totalLength - binaryChunkStart;
    const binaryChunkData = new Uint8Array(arrayBuffer, binaryChunkStart, binaryChunkLength);

    // Calculate new total length
    const newJsonPaddingLength = (4 - (newJsonLength % 4)) % 4;
    const newTotalLength = 12 + (8 + newJsonLength + newJsonPaddingLength) + (8 + binaryChunkLength);

    // Build new GLB
    const newGlb = new ArrayBuffer(newTotalLength);
    const newView = new DataView(newGlb);
    const newUint8 = new Uint8Array(newGlb);

    // Header
    newView.setUint32(0, 0x46546C67, true); // magic
    newView.setUint32(4, 2, true); // version
    newView.setUint32(8, newTotalLength, true); // length

    // JSON chunk header
    newView.setUint32(12, newJsonLength, true);
    newView.setUint32(16, 0x4E4F534A, true); // 'JSON'

    // JSON data
    newUint8.set(newJsonBytes, 20);

    // JSON padding
    const jsonPadStart = 20 + newJsonLength;
    for (let i = 0; i < newJsonPaddingLength; i++) {
      newUint8[jsonPadStart + i] = 0x20; // space character
    }

    // Binary chunk header
    const binChunkHeaderStart = 20 + newJsonLength + newJsonPaddingLength;
    newView.setUint32(binChunkHeaderStart, binaryChunkLength, true);
    newView.setUint32(binChunkHeaderStart + 4, 0x004E4942, true); // 'BIN\0'

    // Binary data
    const binDataStart = binChunkHeaderStart + 8;
    newUint8.set(binaryChunkData, binDataStart);

    return {
      arrayBuffer: newGlb,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    return {
      error: error.message,
    };
  }
}
