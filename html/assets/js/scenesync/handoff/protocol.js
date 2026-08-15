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

export function createReadyMessage() {
  return { type: SCENE_SYNC_READY_TYPE, version: SCENE_SYNC_HANDOFF_VERSION };
}

export function createHandoffMessage({ roomId, sceneDocument, embeddedAssets }) {
  const message = {
    type: SCENE_SYNC_HANDOFF_TYPE,
    version: SCENE_SYNC_HANDOFF_VERSION,
    mode: SCENE_SYNC_HANDOFF_MODE_ADD,
    sceneDocument,
    embeddedAssets,
  };
  const cleanedRoomId = sanitizeRoomCode(roomId);
  if (cleanedRoomId) message.roomId = cleanedRoomId;
  return message;
}

export function createAckMessage({ ok, reason } = {}) {
  const message = {
    type: SCENE_SYNC_HANDOFF_ACK_TYPE,
    version: SCENE_SYNC_HANDOFF_VERSION,
    status: ok ? 'ok' : 'error',
  };
  if (!ok && typeof reason === 'string' && reason) {
    message.reason = reason.slice(0, 120);
  }
  return message;
}

export function isReadyMessage(value) {
  return value?.type === SCENE_SYNC_READY_TYPE
    && value?.version === SCENE_SYNC_HANDOFF_VERSION;
}

export function validateAckMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: 'invalid-ack' };
  }
  if (value.type !== SCENE_SYNC_HANDOFF_ACK_TYPE) {
    return { valid: false, reason: 'invalid-ack-type' };
  }
  if (value.version !== SCENE_SYNC_HANDOFF_VERSION) {
    return { valid: false, reason: 'unsupported-handoff-version' };
  }
  if (value.status !== 'ok' && value.status !== 'error') {
    return { valid: false, reason: 'invalid-ack-status' };
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    return { valid: false, reason: 'invalid-ack-reason' };
  }
  return { valid: true, ok: value.status === 'ok', reason: value.reason || null };
}

export function validateHandoffMessage(value, {
  isValidSceneDocument,
  validateEmbeddedAssets,
  limits,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: 'invalid-handoff-payload' };
  }
  if (value.type !== SCENE_SYNC_HANDOFF_TYPE) {
    return { valid: false, reason: 'invalid-handoff-type' };
  }
  if (value.version !== SCENE_SYNC_HANDOFF_VERSION) {
    return { valid: false, reason: 'unsupported-handoff-version' };
  }
  if (value.mode !== SCENE_SYNC_HANDOFF_MODE_ADD) {
    return { valid: false, reason: 'unsupported-handoff-mode' };
  }
  if (value.roomId !== undefined && !isSanitizedRoomCode(value.roomId)) {
    return { valid: false, reason: 'invalid-handoff-room-id' };
  }
  if (typeof isValidSceneDocument !== 'function' || !isValidSceneDocument(value.sceneDocument)) {
    return { valid: false, reason: 'invalid-handoff-scene-document' };
  }
  if (typeof validateEmbeddedAssets !== 'function') {
    return { valid: false, reason: 'handoff-validator-unavailable' };
  }
  const assetsResult = validateEmbeddedAssets(value.embeddedAssets, {
    ...limits,
    sceneDocument: value.sceneDocument,
  });
  if (!assetsResult.valid) return assetsResult;
  return {
    valid: true,
    message: value,
    sceneDocument: value.sceneDocument,
    embeddedAssets: value.embeddedAssets,
    roomId: value.roomId || null,
  };
}

export function transitionHandoffSourceState(state, event) {
  const current = state || HANDOFF_SOURCE_STATES.IDLE;
  if (event === 'open') {
    return current === HANDOFF_SOURCE_STATES.IDLE || current === HANDOFF_SOURCE_STATES.FAILED
      || current === HANDOFF_SOURCE_STATES.COMPLETE
      ? HANDOFF_SOURCE_STATES.WAITING_READY
      : current;
  }
  if (event === 'ready' && current === HANDOFF_SOURCE_STATES.WAITING_READY) {
    return HANDOFF_SOURCE_STATES.WAITING_ACK;
  }
  if (event === 'ack' && current === HANDOFF_SOURCE_STATES.WAITING_ACK) {
    return HANDOFF_SOURCE_STATES.COMPLETE;
  }
  if ((event === 'error' || event === 'timeout' || event === 'closed' || event === 'blocked')
    && current !== HANDOFF_SOURCE_STATES.COMPLETE) {
    return HANDOFF_SOURCE_STATES.FAILED;
  }
  return current;
}
