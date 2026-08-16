import {
  SCENE_SYNC_HANDOFF_TYPE,
  createAckMessage,
  createReadyMessage,
  isValidHandoffId,
  validateHandoffMessage,
} from './protocol.js';
import { isSanitizedRoomCode } from '../utils/room-code.js';
import { validateHandoffTokenPayload } from './token-payload.js';
import { consumeTokenBootstrap } from './token-bootstrap.js';

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
    if (validation.sourceUrl) {
      let sourceOrigin = null;
      try { sourceOrigin = new URL(validation.sourceUrl).origin; } catch {}
      if (!sourceOrigin || sourceOrigin !== event.origin) {
        const reason = 'handoff-source-origin-mismatch';
        onDiagnostic(reason);
        postToOpener(ack(false, reason), replyOrigin(event.origin));
        return;
      }
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

export function createHandoffTokenTargetSession({
  windowRef = globalThis.window,
  locationRef = globalThis.location,
  fetchRef = globalThis.fetch,
  bootstrap = consumeTokenBootstrap({ windowRef }),
  ensureRoom = async () => {},
  applyPayload,
  onStatus = () => {},
  maxWaitMs = 5 * 60 * 1000,
} = {}) {
  if (!bootstrap) return { enabled: false, dispose() {}, getState: () => ({ ready: false }) };
  const controller = new AbortController();
  let disposed = false; let complete = false;
  const started = Date.now();
  const endpoint = new URL('/presence/scene-sync/handoff-tokens/claim', locationRef?.href || windowRef?.location?.href).href;
  const roomId = isSanitizedRoomCode(bootstrap.roomId) ? bootstrap.roomId : null;
  const delay = (ms) => new Promise((resolve) => windowRef.setTimeout(resolve, ms));
  const run = (async () => {
    let backoff = 250;
    onStatus({ state: 'waiting', message: 'Waiting for token transfer upload…' });
    while (!disposed && Date.now() - started < maxWaitMs) {
      try {
        const response = await fetchRef(endpoint, { method: 'POST', credentials: 'same-origin', signal: controller.signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: bootstrap.token, sessionId: bootstrap.sessionId, requestId: bootstrap.requestId }) });
        if (response.status === 202 || response.status === 404) {
          const retry = Math.min(5_000, Number(response.headers?.get?.('retry-after')) * 1000 || backoff);
          await delay(retry); backoff = Math.min(5_000, backoff * 2); continue;
        }
        if (!response.ok) throw new Error('claim failed');
        const body = await response.json();
        const validation = validateHandoffTokenPayload(body?.payload);
        if (!validation.valid) throw new Error('invalid payload');
        await ensureRoom(roomId);
        if (typeof applyPayload !== 'function') throw new Error('handoff importer unavailable');
        await applyPayload(validation.payload, bootstrap);
        complete = true; onStatus({ state: 'complete', message: 'Token transfer imported.' }); return;
      } catch (error) {
        if (controller.signal.aborted) return;
        onStatus({ state: 'failed', message: 'Token transfer import failed.' }); return;
      }
    }
    if (!disposed) onStatus({ state: 'timeout', message: 'Timed out waiting for token transfer upload.' });
  })();
  return { enabled: true, context: { roomId, ...bootstrap }, ready: () => run, dispose() { disposed = true; controller.abort(); }, getState: () => ({ ready: true, complete }) };
}
