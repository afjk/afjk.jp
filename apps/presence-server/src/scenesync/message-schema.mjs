const KNOWN_KINDS = new Set([
  'scene-add',
  'scene-delta',
  'scene-remove',
  'scene-mesh',
  'scene-env',
  'scene-state',
  'scene-request',
  'scene-avatar',
  'scene-lock',
  'scene-unlock',
  'scene-asset-request',
  'scene-inspector',
  'scene-batch',
  'ai-command',
  'ai-link-established',
  'ai-link-revoked',
  'ai-result',
  'file',
]);

const ENV_IDS = new Set(['studio', 'outdoor_day', 'outdoor_sunset', 'outdoor_night', 'indoor_warm']);

function isReasonableString(value, maxLength = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function hasFiniteNumberArray(value, size) {
  return Array.isArray(value)
    && value.length === size
    && value.every(item => typeof item === 'number' && Number.isFinite(item));
}

export function validateSceneSyncPayload(payload, options = {}) {
  const {
    maxStringLength = 128,
    batchLimit = 100,
    depth = 0,
    maxDepth = 3,
  } = options;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload must be an object' };
  }

  if (!isReasonableString(payload.kind, maxStringLength) || !KNOWN_KINDS.has(payload.kind)) {
    return { ok: false, reason: 'kind must be a known string kind' };
  }

  if (payload.objectId !== undefined && !isReasonableString(payload.objectId, maxStringLength)) {
    return { ok: false, reason: 'objectId must be a reasonable string' };
  }

  if (payload.roomId !== undefined && !isReasonableString(payload.roomId, maxStringLength)) {
    return { ok: false, reason: 'roomId must be a reasonable string' };
  }

  if (payload.position !== undefined && !hasFiniteNumberArray(payload.position, 3)) {
    return { ok: false, reason: 'position must be finite [x,y,z]' };
  }

  if (payload.rotation !== undefined && !hasFiniteNumberArray(payload.rotation, 4)) {
    return { ok: false, reason: 'rotation must be finite quaternion [x,y,z,w]' };
  }

  if (payload.scale !== undefined && !hasFiniteNumberArray(payload.scale, 3)) {
    return { ok: false, reason: 'scale must be finite [x,y,z]' };
  }

  if (payload.kind === 'scene-env' && !ENV_IDS.has(payload.envId)) {
    return { ok: false, reason: 'envId is invalid' };
  }

  if (payload.kind === 'scene-batch') {
    if (depth >= maxDepth) {
      return { ok: false, reason: 'batch nesting depth exceeded' };
    }
    const operations = Array.isArray(payload.ops)
      ? payload.ops
      : (Array.isArray(payload.actions) ? payload.actions : null);
    if (!operations) {
      return { ok: false, reason: 'batch ops/actions must be an array' };
    }
    if (operations.length > batchLimit) {
      return { ok: false, reason: `batch ops must be <= ${batchLimit}` };
    }
    for (const operation of operations) {
      const nestedValidation = validateSceneSyncPayload(operation, {
        maxStringLength,
        batchLimit,
        depth: depth + 1,
        maxDepth,
      });
      if (!nestedValidation.ok) {
        return { ok: false, reason: `invalid batch op: ${nestedValidation.reason}` };
      }
    }
  }

  return { ok: true };
}
