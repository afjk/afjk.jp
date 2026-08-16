import { isValidHandoffId } from './protocol.js';
import { isValidHandoffToken } from './token-payload.js';
import { isSanitizedRoomCode } from '../utils/room-code.js';
import { isInlineHandoffPayloadEncoding } from './inline-payload.js';

export const HANDOFF_TOKEN_BOOTSTRAP_KEY = 'sceneSync.handoffToken.v1';

export function validateTokenBootstrap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.hasOwn(value, 'inlinePayload')) {
    return Object.keys(value).length === 1 && isInlineHandoffPayloadEncoding(value.inlinePayload);
  }
  const baseKeys = ['token', 'sessionId', 'requestId', 'roomId'];
  const keys = Object.keys(value).sort();
  const expected = baseKeys.sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  return isValidHandoffToken(value.token)
    && isValidHandoffId(value.sessionId)
    && isValidHandoffId(value.requestId)
    && (value.roomId == null || isSanitizedRoomCode(value.roomId));
}

// Read-once prevents a reload from turning a claimed token into another import
// attempt. The inline head bootstrap is intentionally independent of modules.
export function consumeTokenBootstrap({ windowRef = globalThis.window, storageRef } = {}) {
  let raw = null;
  try {
    const storage = storageRef === undefined ? windowRef?.sessionStorage : storageRef;
    raw = storage?.getItem?.(HANDOFF_TOKEN_BOOTSTRAP_KEY); storage?.removeItem?.(HANDOFF_TOKEN_BOOTSTRAP_KEY);
  } catch {}
  if (raw) {
    try { const value = JSON.parse(raw); if (validateTokenBootstrap(value)) return value; } catch {}
  }
  const value = windowRef?.__SCENE_SYNC_HANDOFF_TOKEN_BOOTSTRAP__;
  try { delete windowRef.__SCENE_SYNC_HANDOFF_TOKEN_BOOTSTRAP__; } catch {}
  return validateTokenBootstrap(value) ? value : null;
}
