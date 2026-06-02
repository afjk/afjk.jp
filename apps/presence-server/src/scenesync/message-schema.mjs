const KNOWN_KINDS = new Set([
  'scene-add',
  'scene-delta',
  'scene-remove',
  'scene-mesh',
  'scene-env',
  'scene-bgm',
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

// AudioSource component map（audioSources）のバリデーション。
// value が null のキーは「その AudioSource を削除する」patch を意味する。
// 完全な型の正規化は html/assets/js/scenesync/audio/audio-source.js が担当する。
function validateAudioSourcesMap(map, maxStringLength, maxUrlLength = 2048) {
  if (map === null) return { ok: true };
  if (typeof map !== 'object' || Array.isArray(map)) {
    return { ok: false, reason: 'audioSources must be an object map or null' };
  }
  for (const [name, source] of Object.entries(map)) {
    if (!isReasonableString(name, maxStringLength)) {
      return { ok: false, reason: 'audioSources keys must be reasonable strings' };
    }
    if (source === null) continue;
    if (typeof source !== 'object' || Array.isArray(source)) {
      return { ok: false, reason: `audioSources.${name} must be an object or null` };
    }
    if (!isReasonableString(source.url, maxUrlLength)) {
      return { ok: false, reason: `audioSources.${name}.url must be a reasonable string` };
    }
    if (source.volume !== undefined && (typeof source.volume !== 'number' || !Number.isFinite(source.volume))) {
      return { ok: false, reason: `audioSources.${name}.volume must be a finite number` };
    }
    if (source.loop !== undefined && typeof source.loop !== 'boolean') {
      return { ok: false, reason: `audioSources.${name}.loop must be a boolean` };
    }
    if (source.playOnAwake !== undefined && typeof source.playOnAwake !== 'boolean') {
      return { ok: false, reason: `audioSources.${name}.playOnAwake must be a boolean` };
    }
    if (source.offset !== undefined && (typeof source.offset !== 'number' || !Number.isFinite(source.offset))) {
      return { ok: false, reason: `audioSources.${name}.offset must be a finite number` };
    }
    if (source.playbackRate !== undefined && (typeof source.playbackRate !== 'number' || !Number.isFinite(source.playbackRate))) {
      return { ok: false, reason: `audioSources.${name}.playbackRate must be a finite number` };
    }
    if (source.spatial !== undefined && typeof source.spatial !== 'boolean') {
      return { ok: false, reason: `audioSources.${name}.spatial must be a boolean` };
    }
  }
  return { ok: true };
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

  // audioSources は scene-add / scene-delta などでオブジェクトに AudioSource を付与する。
  if (payload.audioSources !== undefined) {
    const audioValidation = validateAudioSourcesMap(payload.audioSources, maxStringLength);
    if (!audioValidation.ok) {
      return audioValidation;
    }
  }

  if (payload.kind === 'scene-bgm') {
    if (payload.bgm === null) {
      // bgm: null is valid (clears BGM)
      return { ok: true };
    }
    if (typeof payload.bgm !== 'object' || !payload.bgm) {
      return { ok: false, reason: 'bgm must be null or an object' };
    }
    if (!isReasonableString(payload.bgm.url)) {
      return { ok: false, reason: 'bgm.url must be a reasonable string' };
    }
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
