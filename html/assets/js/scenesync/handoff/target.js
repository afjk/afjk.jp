import {
  createAckMessage,
  createReadyMessage,
  validateHandoffMessage,
} from './protocol.js';

export function isHandoffTargetLocation(locationRef = globalThis.location) {
  try {
    return new URLSearchParams(locationRef?.search || '').get('handoff') === '1';
  } catch {
    return false;
  }
}

function replyOrigin(origin) {
  return typeof origin === 'string' && origin !== 'null' && origin ? origin : '*';
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
  const enabled = isHandoffTargetLocation(locationRef);
  const opener = enabled ? windowRef?.opener : null;
  let ready = false;
  let busy = false;
  let complete = false;

  function postToOpener(message, origin = '*') {
    try {
      opener?.postMessage?.(message, origin);
    } catch (error) {
      onDiagnostic('handoff-reply-failed', error);
    }
  }

  async function handleMessage(event) {
    if (!enabled || !opener || !ready || busy || complete) return;
    if (event.source !== opener) return;

    const validation = validateMessage(event.data, validationOptions);
    if (!validation.valid) {
      onDiagnostic(validation.reason);
      postToOpener(createAckMessage({ ok: false, reason: validation.reason }), replyOrigin(event.origin));
      return;
    }

    busy = true;
    try {
      await ensureRoom(validation.roomId);
      if (typeof applyMessage !== 'function') throw new Error('Handoff importer is unavailable');
      await applyMessage(validation);
      complete = true;
      postToOpener(createAckMessage({ ok: true }), replyOrigin(event.origin));
    } catch (error) {
      onDiagnostic('handoff-import-failed', error);
      postToOpener(createAckMessage({ ok: false, reason: 'handoff-import-failed' }), replyOrigin(event.origin));
    } finally {
      busy = false;
    }
  }

  if (enabled && opener) windowRef.addEventListener('message', handleMessage);

  return {
    enabled: Boolean(enabled && opener),
    ready() {
      if (!enabled || !opener || ready) return false;
      ready = true;
      postToOpener(createReadyMessage(), '*');
      return true;
    },
    dispose() {
      if (enabled && opener) windowRef.removeEventListener('message', handleMessage);
    },
    getState() {
      return { ready, busy, complete };
    },
  };
}
