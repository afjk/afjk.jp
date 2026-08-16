import { isValidHandoffId } from './protocol.js';
import { isValidHandoffToken } from './token-payload.js';
import { isSanitizedRoomCode } from '../utils/room-code.js';

export const HANDOFF_TOKEN_BOOTSTRAP_KEY = 'sceneSync.handoffToken.v1';

export function validateTokenBootstrap(value) {
  return Boolean(value && typeof value === 'object'
    && isValidHandoffToken(value.token)
    && isValidHandoffId(value.sessionId)
    && isValidHandoffId(value.requestId)
    && (value.roomId == null || isSanitizedRoomCode(value.roomId)));
}

// Read-once prevents a reload from turning a claimed token into another import
// attempt. The inline head bootstrap is intentionally independent of modules.
export function consumeTokenBootstrap({ windowRef = globalThis.window, storageRef = windowRef?.sessionStorage } = {}) {
  let raw = null;
  try { raw = storageRef?.getItem?.(HANDOFF_TOKEN_BOOTSTRAP_KEY); storageRef?.removeItem?.(HANDOFF_TOKEN_BOOTSTRAP_KEY); } catch {}
  if (raw) {
    try { const value = JSON.parse(raw); if (validateTokenBootstrap(value)) return value; } catch {}
  }
  const value = windowRef?.__SCENE_SYNC_HANDOFF_TOKEN_BOOTSTRAP__;
  try { delete windowRef.__SCENE_SYNC_HANDOFF_TOKEN_BOOTSTRAP__; } catch {}
  return validateTokenBootstrap(value) ? value : null;
}
