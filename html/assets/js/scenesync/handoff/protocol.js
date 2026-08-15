import { isSanitizedRoomCode, sanitizeRoomCode } from '../utils/room-code.js';

export const SCENE_SYNC_HANDOFF_VERSION = 1;
export const SCENE_SYNC_READY_TYPE = 'scene-sync-ready';
export const SCENE_SYNC_HANDOFF_TYPE = 'scene-sync-handoff';
export const SCENE_SYNC_HANDOFF_ACK_TYPE = 'scene-sync-handoff-ack';
export const SCENE_SYNC_HANDOFF_MODE_ADD = 'add';

export const HANDOFF_SOURCE_STATES = Object.freeze({
  IDLE: 'idle',
  WAITING_READY: 'waiting-ready',
  WAITING_ACK: 'waiting-ack',
  COMPLETE: 'complete',
  FAILED: 'failed',
});

export const DEFAULT_HANDOFF_VALIDATION_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 250_000,
  maxObjectCount: 10_000,
  maxIdLength: 256,
  maxStringBytes: 100 * 1024 * 1024,
});

// 22 base64url characters are required to carry at least 128 random bits.
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;

export function isValidHandoffId(value) {
  return typeof value === 'string' && HANDOFF_ID_PATTERN.test(value);
}

export function createRandomHandoffId(cryptoRef = globalThis.crypto) {
  if (!cryptoRef || typeof cryptoRef.getRandomValues !== 'function') {
    throw new Error('Cryptographically secure randomness is unavailable');
  }
  const bytes = new Uint8Array(16);
  cryptoRef.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createReadyMessage({ sessionId, requestId } = {}) {
  return {
    type: SCENE_SYNC_READY_TYPE,
    version: SCENE_SYNC_HANDOFF_VERSION,
    sessionId,
    requestId,
  };
}

export function createHandoffMessage({ sessionId, requestId, roomId, sceneDocument, embeddedAssets }) {
  const message = {
    type: SCENE_SYNC_HANDOFF_TYPE,
    version: SCENE_SYNC_HANDOFF_VERSION,
    sessionId,
    requestId,
    mode: SCENE_SYNC_HANDOFF_MODE_ADD,
    sceneDocument,
    embeddedAssets,
  };
  const cleanedRoomId = sanitizeRoomCode(roomId);
  if (cleanedRoomId) message.roomId = cleanedRoomId;
  return message;
}

export function createAckMessage({ sessionId, requestId, ok, reason } = {}) {
  const message = {
    type: SCENE_SYNC_HANDOFF_ACK_TYPE,
    version: SCENE_SYNC_HANDOFF_VERSION,
    sessionId,
    requestId,
    status: ok ? 'ok' : 'error',
  };
  if (!ok && typeof reason === 'string' && reason) message.reason = reason.slice(0, 120);
  return message;
}

function hasExpectedIds(value, { sessionId, requestId } = {}) {
  return isValidHandoffId(value?.sessionId)
    && isValidHandoffId(value?.requestId)
    && (!sessionId || value.sessionId === sessionId)
    && (!requestId || value.requestId === requestId);
}

export function isReadyMessage(value, expected = {}) {
  return value?.type === SCENE_SYNC_READY_TYPE
    && value?.version === SCENE_SYNC_HANDOFF_VERSION
    && hasExpectedIds(value, expected);
}

export function validateAckMessage(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, reason: 'invalid-ack' };
  if (value.type !== SCENE_SYNC_HANDOFF_ACK_TYPE) return { valid: false, reason: 'invalid-ack-type' };
  if (value.version !== SCENE_SYNC_HANDOFF_VERSION) return { valid: false, reason: 'unsupported-handoff-version' };
  if (!hasExpectedIds(value, expected)) return { valid: false, reason: 'handoff-session-mismatch' };
  if (value.status !== 'ok' && value.status !== 'error') return { valid: false, reason: 'invalid-ack-status' };
  if (value.reason !== undefined && typeof value.reason !== 'string') return { valid: false, reason: 'invalid-ack-reason' };
  return { valid: true, ok: value.status === 'ok', reason: value.reason || null };
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

export function canonicalizeJsonValue(value, limits = {}) {
  const resolved = { ...DEFAULT_HANDOFF_VALIDATION_LIMITS, ...limits };
  const ancestors = new WeakSet();
  let nodes = 0;
  let stringBytes = 0;

  function clone(input, depth) {
    nodes += 1;
    if (nodes > resolved.maxNodes) throw new Error('handoff-too-many-values');
    if (depth > resolved.maxDepth) throw new Error('handoff-too-deep');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('handoff-non-finite-number');
      return input;
    }
    if (typeof input === 'string') {
      stringBytes += utf8ByteLength(input);
      if (stringBytes > resolved.maxStringBytes) throw new Error('handoff-strings-too-large');
      return input;
    }
    if (typeof input !== 'object') throw new Error('handoff-non-json-value');
    if (ancestors.has(input)) throw new Error('handoff-cyclic-value');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        const output = new Array(input.length);
        for (let index = 0; index < input.length; index += 1) {
          if (!Object.hasOwn(input, index)) throw new Error('handoff-sparse-array');
          output[index] = clone(input[index], depth + 1);
        }
        return output;
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('handoff-non-plain-object');
      if (Reflect.ownKeys(input).some((key) => typeof key !== 'string')) throw new Error('handoff-symbol-key');
      // Null-prototype output prevents JSON keys such as `__proto__`,
      // `constructor`, and `prototype` from mutating the canonical clone.
      const output = Object.create(null);
      for (const [key, child] of Object.entries(input)) {
        stringBytes += utf8ByteLength(key);
        if (stringBytes > resolved.maxStringBytes) throw new Error('handoff-strings-too-large');
        output[key] = clone(child, depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(input);
    }
  }

  try {
    return { valid: true, value: clone(value, 0), nodes, stringBytes };
  } catch (error) {
    return { valid: false, reason: error.message || 'handoff-non-json-value' };
  }
}

function isExactFiniteVector(value, length) {
  return Array.isArray(value)
    && value.length === length
    && value.every((component) => typeof component === 'number' && Number.isFinite(component));
}

export function validateStrictSceneDocument(sceneDocument, limits = {}) {
  const resolved = { ...DEFAULT_HANDOFF_VALIDATION_LIMITS, ...limits };
  if (!sceneDocument || typeof sceneDocument !== 'object' || !Array.isArray(sceneDocument.objects)) {
    return { valid: false, reason: 'invalid-handoff-scene-document' };
  }
  if (sceneDocument.objects.length > resolved.maxObjectCount) {
    return { valid: false, reason: 'handoff-too-many-objects' };
  }
  const ids = new Set();
  for (const object of sceneDocument.objects) {
    if (!object || typeof object !== 'object'
      || typeof object.id !== 'string' || !object.id || object.id.length > resolved.maxIdLength
      || !isExactFiniteVector(object.position, 3)
      || !isExactFiniteVector(object.rotation, 4)
      || !isExactFiniteVector(object.scale, 3)) {
      return { valid: false, reason: 'invalid-handoff-scene-object' };
    }
    if (ids.has(object.id)) return { valid: false, reason: 'handoff-duplicate-object-id' };
    ids.add(object.id);
  }
  return { valid: true };
}

export function validateHandoffMessage(value, {
  isValidSceneDocument,
  validateEmbeddedAssets,
  expectedSessionId,
  expectedRequestId,
  expectedRoomId = null,
  limits,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, reason: 'invalid-handoff-payload' };
  if (value.type !== SCENE_SYNC_HANDOFF_TYPE) return { valid: false, reason: 'invalid-handoff-type' };
  if (value.version !== SCENE_SYNC_HANDOFF_VERSION) return { valid: false, reason: 'unsupported-handoff-version' };
  if (!hasExpectedIds(value, { sessionId: expectedSessionId, requestId: expectedRequestId })) {
    return { valid: false, reason: 'handoff-session-mismatch' };
  }
  if (value.mode !== SCENE_SYNC_HANDOFF_MODE_ADD) return { valid: false, reason: 'unsupported-handoff-mode' };
  if (value.roomId !== undefined && !isSanitizedRoomCode(value.roomId)) return { valid: false, reason: 'invalid-handoff-room-id' };
  if ((value.roomId || null) !== expectedRoomId && value.roomId !== undefined) {
    return { valid: false, reason: 'handoff-room-mismatch' };
  }

  const canonical = canonicalizeJsonValue({
    sceneDocument: value.sceneDocument,
    embeddedAssets: value.embeddedAssets,
  }, limits);
  if (!canonical.valid) return canonical;
  const sceneDocument = canonical.value.sceneDocument;
  const embeddedAssets = canonical.value.embeddedAssets;
  const strictDocument = validateStrictSceneDocument(sceneDocument, limits);
  if (!strictDocument.valid) return strictDocument;
  if (typeof isValidSceneDocument !== 'function' || !isValidSceneDocument(sceneDocument)) {
    return { valid: false, reason: 'invalid-handoff-scene-document' };
  }
  if (typeof validateEmbeddedAssets !== 'function') return { valid: false, reason: 'handoff-validator-unavailable' };
  const assetsResult = validateEmbeddedAssets(embeddedAssets, { ...limits, sceneDocument });
  if (!assetsResult.valid) return assetsResult;
  const message = Object.assign(Object.create(null), {
    type: SCENE_SYNC_HANDOFF_TYPE,
    version: SCENE_SYNC_HANDOFF_VERSION,
    sessionId: value.sessionId,
    requestId: value.requestId,
    mode: SCENE_SYNC_HANDOFF_MODE_ADD,
    sceneDocument,
    embeddedAssets,
  });
  if (expectedRoomId) message.roomId = expectedRoomId;
  return {
    valid: true,
    message,
    sceneDocument,
    embeddedAssets,
    roomId: expectedRoomId,
    sessionId: value.sessionId,
    requestId: value.requestId,
  };
}

export function transitionHandoffSourceState(state, event) {
  const current = state || HANDOFF_SOURCE_STATES.IDLE;
  if (event === 'open') {
    return current === HANDOFF_SOURCE_STATES.IDLE || current === HANDOFF_SOURCE_STATES.FAILED
      || current === HANDOFF_SOURCE_STATES.COMPLETE ? HANDOFF_SOURCE_STATES.WAITING_READY : current;
  }
  if (event === 'ready' && current === HANDOFF_SOURCE_STATES.WAITING_READY) return HANDOFF_SOURCE_STATES.WAITING_ACK;
  if (event === 'ack' && current === HANDOFF_SOURCE_STATES.WAITING_ACK) return HANDOFF_SOURCE_STATES.COMPLETE;
  if ((event === 'error' || event === 'timeout' || event === 'closed' || event === 'blocked')
    && current !== HANDOFF_SOURCE_STATES.COMPLETE) return HANDOFF_SOURCE_STATES.FAILED;
  return current;
}
