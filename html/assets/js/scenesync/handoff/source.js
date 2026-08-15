import {
  HANDOFF_SOURCE_STATES,
  createHandoffMessage,
  createRandomHandoffId,
  isReadyMessage,
  transitionHandoffSourceState,
  validateAckMessage,
} from './protocol.js';
import { sanitizeRoomCode } from '../utils/room-code.js';

export const DEFAULT_SCENE_SYNC_HANDOFF_URL = 'https://afjk.jp/scenesync/';
export const DEFAULT_HANDOFF_READY_TIMEOUT_MS = 25_000;
export const DEFAULT_HANDOFF_ACK_TIMEOUT_MS = 120_000;
// URL handoff can materialize up to 500 MiB. Keep source-side ACK waiting
// longer than the target's ten-minute deadline while preserving Single HTML.
export const DEFAULT_URL_HANDOFF_ACK_TIMEOUT_MS = 13 * 60 * 1000;

function statusForFailure(reason) {
  return {
    blocked: 'Popup was blocked. Allow popups and try again.',
    closed: 'Scene Sync was closed before the import finished.',
    'ready-timeout': 'Scene Sync did not become ready in time. Please try again.',
    'import-timeout': 'Scene Sync did not finish importing in time. Please try again.',
  }[reason] || `Scene Sync could not import this export (${reason}).`;
}

export function createHandoffSourceController({
  windowRef = globalThis.window,
  targetUrl = DEFAULT_SCENE_SYNC_HANDOFF_URL,
  sceneDocument,
  embeddedAssets,
  sourceUrl,
  readyTimeoutMs = DEFAULT_HANDOFF_READY_TIMEOUT_MS,
  ackTimeoutMs = DEFAULT_HANDOFF_ACK_TIMEOUT_MS,
  closedPollMs = 250,
  onStateChange = () => {},
} = {}) {
  let state = HANDOFF_SOURCE_STATES.IDLE;
  let popup = null;
  let targetOrigin = null;
  let requestedRoomId = null;
  let sessionId = null;
  let requestId = null;
  let timeoutId = null;
  let closedIntervalId = null;

  function emit(detail = {}) {
    onStateChange({ state, ...detail });
  }

  function stopTimers() {
    if (timeoutId != null) windowRef.clearTimeout(timeoutId);
    if (closedIntervalId != null) windowRef.clearInterval(closedIntervalId);
    timeoutId = null;
    closedIntervalId = null;
  }

  function armTimeout(delay, reason) {
    if (timeoutId != null) windowRef.clearTimeout(timeoutId);
    timeoutId = windowRef.setTimeout(() => {
      finish('timeout', { reason, message: statusForFailure(reason) });
    }, delay);
  }

  function finish(event, detail = {}) {
    state = transitionHandoffSourceState(state, event);
    stopTimers();
    emit(detail);
  }

  function handleMessage(event) {
    if (!popup || event.source !== popup || event.origin !== targetOrigin) return;

    if (isReadyMessage(event.data, { sessionId, requestId })
      && state === HANDOFF_SOURCE_STATES.WAITING_READY) {
      state = transitionHandoffSourceState(state, 'ready');
      emit({ message: 'Sending scene…' });
      armTimeout(sourceUrl ? Math.max(ackTimeoutMs, DEFAULT_URL_HANDOFF_ACK_TIMEOUT_MS) : ackTimeoutMs, 'import-timeout');
      try {
        popup.postMessage(createHandoffMessage({
          sessionId,
          requestId,
          roomId: requestedRoomId,
          sceneDocument,
          embeddedAssets,
          sourceUrl,
        }), targetOrigin);
      } catch {
        finish('error', {
          reason: 'send-failed',
          message: statusForFailure('send-failed'),
        });
      }
      return;
    }

    if (state !== HANDOFF_SOURCE_STATES.WAITING_ACK) return;
    const ack = validateAckMessage(event.data, { sessionId, requestId });
    if (!ack.valid) return;
    if (ack.ok) {
      finish('ack', { message: 'Opened in Scene Sync.' });
    } else {
      finish('error', {
        reason: ack.reason || 'import-failed',
        message: statusForFailure(ack.reason || 'import-failed'),
      });
    }
  }

  windowRef.addEventListener('message', handleMessage);

  function open(roomId) {
    stopTimers();
    if (popup && !popup.closed) {
      try { popup.close(); } catch {}
    }
    popup = null;
    state = HANDOFF_SOURCE_STATES.IDLE;
    const cleanedRoomId = sanitizeRoomCode(roomId);
    requestedRoomId = cleanedRoomId;
    try {
      sessionId = createRandomHandoffId(windowRef.crypto || globalThis.crypto);
      requestId = createRandomHandoffId(windowRef.crypto || globalThis.crypto);
    } catch {
      finish('error', { reason: 'random-unavailable', message: statusForFailure('random-unavailable') });
      return { opened: false, reason: 'random-unavailable' };
    }
    const url = new URL(targetUrl, windowRef.location?.href || DEFAULT_SCENE_SYNC_HANDOFF_URL);
    url.searchParams.set('handoff', '1');
    url.searchParams.set('handoffSession', sessionId);
    url.searchParams.set('handoffRequest', requestId);
    if (cleanedRoomId) url.searchParams.set('room', cleanedRoomId);
    else url.searchParams.delete('room');
    targetOrigin = url.origin;
    state = transitionHandoffSourceState(state, 'open');

    // This call must stay directly in the click stack so browsers recognize
    // the handoff as a user-initiated popup.
    try {
      popup = windowRef.open(url.toString(), '_blank');
    } catch {
      popup = null;
    }
    if (!popup) {
      finish('blocked', { reason: 'blocked', message: statusForFailure('blocked') });
      return { opened: false, reason: 'blocked' };
    }
    emit({ message: 'Waiting for Scene Sync…' });

    armTimeout(readyTimeoutMs, 'ready-timeout');
    closedIntervalId = windowRef.setInterval(() => {
      if (popup?.closed) {
        finish('closed', { reason: 'closed', message: statusForFailure('closed') });
      }
    }, closedPollMs);
    return { opened: true, url: url.toString(), roomId: cleanedRoomId, sessionId, requestId };
  }

  return {
    open,
    getState: () => state,
    getPopup: () => popup,
    dispose() {
      stopTimers();
      windowRef.removeEventListener('message', handleMessage);
    },
  };
}

export function mountSingleHtmlHandoff({
  sceneDocument,
  embeddedAssets,
  targetUrl = globalThis.__SCENE_SYNC_HANDOFF_TARGET_URL__ || DEFAULT_SCENE_SYNC_HANDOFF_URL,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  const host = documentRef?.getElementById?.('viewer-ui');
  if (!host || !sceneDocument || !embeddedAssets) return null;

  const form = documentRef.createElement('form');
  form.id = 'scene-sync-handoff';
  form.className = 'scene-sync-handoff';
  form.innerHTML = `
    <label for="scene-sync-handoff-room">Open in Scene Sync</label>
    <div class="scene-sync-handoff-row">
      <input id="scene-sync-handoff-room" name="room" type="text" maxlength="24"
        autocomplete="off" placeholder="Room ID (optional)">
      <button type="submit" class="viewer-btn">Open</button>
    </div>
    <div id="scene-sync-handoff-status" class="scene-sync-handoff-status" role="status" aria-live="polite"></div>`;
  host.appendChild(form);

  const roomInput = form.querySelector('[name="room"]');
  const button = form.querySelector('button');
  const status = form.querySelector('[role="status"]');
  const controller = createHandoffSourceController({
    windowRef,
    targetUrl,
    sceneDocument,
    embeddedAssets,
    onStateChange(detail) {
      if (status) status.textContent = detail.message || '';
      if (button) button.disabled = detail.state === HANDOFF_SOURCE_STATES.WAITING_READY
        || detail.state === HANDOFF_SOURCE_STATES.WAITING_ACK;
      form.dataset.state = detail.state;
    },
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const cleaned = sanitizeRoomCode(roomInput?.value);
    if (roomInput) roomInput.value = cleaned || '';
    controller.open(cleaned);
  });
  return controller;
}

// Static exports hand off their published page URL. The target fetches the
// marker/scene document itself, so no scene data or credentials cross windows.
export function mountUrlHandoff({
  sourceUrl = globalThis.location?.href,
  targetUrl = globalThis.__SCENE_SYNC_HANDOFF_TARGET_URL__ || DEFAULT_SCENE_SYNC_HANDOFF_URL,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  const host = documentRef?.getElementById?.('viewer-ui');
  if (!host || !sourceUrl) return null;
  const form = documentRef.createElement('form');
  form.id = 'scene-sync-handoff';
  form.className = 'scene-sync-handoff';
  form.innerHTML = `<label for="scene-sync-handoff-room">Open in Scene Sync</label>
    <div class="scene-sync-handoff-row"><input id="scene-sync-handoff-room" name="room" type="text" maxlength="24" autocomplete="off" placeholder="Room ID (optional)"><button type="submit" class="viewer-btn">Open</button></div>
    <div id="scene-sync-handoff-status" class="scene-sync-handoff-status" role="status" aria-live="polite"></div>`;
  host.appendChild(form);
  const roomInput = form.querySelector('[name="room"]');
  const button = form.querySelector('button');
  const status = form.querySelector('[role="status"]');
  const controller = createHandoffSourceController({
    windowRef, targetUrl, sourceUrl,
    onStateChange(detail) {
      if (status) status.textContent = detail.message || '';
      if (button) button.disabled = detail.state === HANDOFF_SOURCE_STATES.WAITING_READY || detail.state === HANDOFF_SOURCE_STATES.WAITING_ACK;
      form.dataset.state = detail.state;
    },
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const cleaned = sanitizeRoomCode(roomInput?.value);
    if (roomInput) roomInput.value = cleaned || '';
    controller.open(cleaned);
  });
  return controller;
}
