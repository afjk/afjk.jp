import {
  SCENE_SYNC_HANDOFF_TYPE,
  createAckMessage,
  createReadyMessage,
  isValidHandoffId,
  validateHandoffMessage,
} from './protocol.js';
import { isSanitizedRoomCode } from '../utils/room-code.js';

export function readHandoffTargetContext(locationRef = globalThis.location) {
  try {
    const params = new URLSearchParams(locationRef?.search || '');
    const sessionId = params.get('handoffSession');
    const requestId = params.get('handoffRequest');
    const roomId = params.get('room');
    const valid = params.get('handoff') === '1'
      && isValidHandoffId(sessionId)
      && isValidHandoffId(requestId)
      && (roomId == null || isSanitizedRoomCode(roomId));
    return { valid, sessionId, requestId, roomId: roomId || null };
  } catch {
    return { valid: false, sessionId: null, requestId: null, roomId: null };
  }
}

export function isHandoffTargetLocation(locationRef = globalThis.location) {
  return readHandoffTargetContext(locationRef).valid;
}

function replyOrigin(origin) {
  return typeof origin === 'string' && origin !== 'null' && origin ? origin : '*';
}

function safeErrorReason(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^handoff-[a-z0-9-]{1,100}$/u.test(code) ? code : 'handoff-import-failed';
}

export function createHandoffTargetSession({
  windowRef = globalThis.window,
  locationRef = globalThis.location,
  validateMessage = validateHandoffMessage,
  validationOptions,
  ensureRoom = async () => {},
  applyMessage,
  onDiagnostic = () => {},
} = {}) {
  const context = readHandoffTargetContext(locationRef);
  const opener = context.valid ? windowRef?.opener : null;
  const enabled = Boolean(context.valid && opener);
  let busy = false;
  let complete = false;

  function ack(ok, reason) {
    return createAckMessage({
      sessionId: context.sessionId,
      requestId: context.requestId,
      ok,
      reason,
    });
  }

  function postToOpener(message, origin = '*') {
    try {
      opener?.postMessage?.(message, origin);
    } catch (error) {
      onDiagnostic('handoff-reply-failed', error);
    }
  }

  function matchesBoundRequest(value) {
    return value?.type === SCENE_SYNC_HANDOFF_TYPE
      && value?.sessionId === context.sessionId
      && value?.requestId === context.requestId;
  }

  async function handleMessage(event) {
    if (!enabled || event.source !== opener) return;
    if (busy || complete) {
      if (!matchesBoundRequest(event.data)) return;
      const reason = busy ? 'handoff-busy' : 'handoff-replay';
      onDiagnostic(reason);
      postToOpener(ack(false, reason), replyOrigin(event.origin));
      return;
    }

    const validation = validateMessage(event.data, {
      ...validationOptions,
      expectedSessionId: context.sessionId,
      expectedRequestId: context.requestId,
      expectedRoomId: context.roomId,
    });
    if (!validation.valid) {
      onDiagnostic(validation.reason);
      postToOpener(ack(false, validation.reason), replyOrigin(event.origin));
      return;
    }

    busy = true;
    try {
      await ensureRoom(validation.roomId);
      if (typeof applyMessage !== 'function') throw new Error('Handoff importer is unavailable');
      await applyMessage(validation);
      complete = true;
      postToOpener(ack(true), replyOrigin(event.origin));
    } catch (error) {
      const reason = safeErrorReason(error);
      onDiagnostic(reason, error);
      postToOpener(ack(false, reason), replyOrigin(event.origin));
    } finally {
      busy = false;
    }
  }

  if (enabled) {
    windowRef.addEventListener('message', handleMessage);
    postToOpener(createReadyMessage({
      sessionId: context.sessionId,
      requestId: context.requestId,
    }), '*');
  }

  return {
    enabled,
    context,
    ready() { return false; },
    dispose() {
      if (enabled) windowRef.removeEventListener('message', handleMessage);
    },
    getState() {
      return { ready: enabled, busy, complete };
    },
  };
}
