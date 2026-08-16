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

// This is deliberately proof-only.  A top-level page and ordinary iframes can
// open a user-initiated popup; only a same-origin frame whose *current*
// frameElement explicitly has sandbox and omits allow-popups is known to be
// unable to do so.  Cross-origin frame access is intentionally inconclusive.
export function isEmbeddedPopupUnsupported(windowRef = globalThis.window) {
  try {
    if (!windowRef || windowRef.top === windowRef) return false;
    const frame = windowRef.frameElement;
    if (!frame || typeof frame.getAttribute !== 'function') return false;
    if (typeof frame.hasAttribute === 'function' ? !frame.hasAttribute('sandbox') : frame.getAttribute('sandbox') == null) return false;
    const tokens = String(frame.getAttribute('sandbox') || '').toLowerCase().split(/[\t\n\f\r ]+/u).filter(Boolean);
    return !tokens.includes('allow-popups');
  } catch {
    return false;
  }
}

const EMBEDDED_POPUP_MESSAGE = 'Direct Scene Sync import is unavailable in this embedded viewer. Open or download the Single HTML export in a regular tab.';
const EMBEDDED_URL_POPUP_MESSAGE = 'Direct Scene Sync import is unavailable in this embedded viewer. Open the published page in a regular tab.';

function applyEmbeddedPopupGuidance({ form, roomInput, button, status, windowRef, message = EMBEDDED_POPUP_MESSAGE }) {
  if (!isEmbeddedPopupUnsupported(windowRef)) return false;
  if (roomInput) roomInput.disabled = true;
  if (button) button.disabled = true;
  if (status) status.textContent = message;
  form.dataset.state = 'embedded-popup-unsupported';
  return true;
}

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

// Sharing an export is mostly about *viewing* it, so the handoff stays a small
// pill in the viewer's control stack and only expands into a panel on demand.
const HANDOFF_TOGGLE_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1.5h5v5"/><path d="M14.5 1.5 7.5 8.5"/><path d="M12.5 9v4a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V5A1.5 1.5 0 0 1 3 3.5h4"/></svg>';
const HANDOFF_HINT = 'Import this scene into Scene Sync to keep editing it, or to view it in a headset.';

function createHandoffElements(documentRef) {
  const dock = documentRef.createElement('div');
  dock.className = 'scene-sync-handoff-dock';
  dock.dataset.open = 'false';

  const toggle = documentRef.createElement('button');
  toggle.type = 'button';
  toggle.id = 'scene-sync-handoff-toggle';
  toggle.className = 'scene-sync-handoff-toggle';
  toggle.title = 'Open in Scene Sync';
  toggle.setAttribute('aria-label', 'Open in Scene Sync');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'scene-sync-handoff');
  toggle.innerHTML = `${HANDOFF_TOGGLE_ICON}<span>Scene Sync</span>`;

  const form = documentRef.createElement('form');
  form.id = 'scene-sync-handoff';
  form.className = 'scene-sync-handoff';
  form.hidden = true;
  form.innerHTML = `<label for="scene-sync-handoff-room">Open in Scene Sync</label>
    <p class="scene-sync-handoff-hint">${HANDOFF_HINT}</p>
    <div class="scene-sync-handoff-row"><input id="scene-sync-handoff-room" name="room" type="text" maxlength="24" autocomplete="off" placeholder="Room ID (optional)"><button type="submit" class="viewer-btn">Open</button></div>
    <div id="scene-sync-handoff-status" class="scene-sync-handoff-status" role="status" aria-live="polite"></div>`;

  dock.appendChild(toggle);
  dock.appendChild(form);
  return { dock, toggle, form };
}

function mountHandoffPanel({
  documentRef,
  windowRef,
  embeddedMessage,
  controllerOptions,
}) {
  const host = documentRef?.getElementById?.('viewer-ui');
  if (!host) return null;
  // Docking into the viewer's button stack keeps the handoff clear of the
  // bottom-centered player transport, which fills the width on phones.
  const dockHost = documentRef.getElementById?.('viewer-controls') || host;

  const { dock, toggle, form } = createHandoffElements(documentRef);
  dockHost.appendChild(dock);

  const roomInput = form.querySelector('[name="room"]');
  const button = form.querySelector('button');
  const status = form.querySelector('[role="status"]');

  let busy = false;

  function setOpen(open) {
    form.hidden = !open;
    dock.dataset.open = open ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  toggle.addEventListener('click', () => {
    const shouldOpen = form.hidden;
    setOpen(shouldOpen);
    if (shouldOpen) roomInput?.focus?.();
  });

  // Capture phase: viewer panels stop pointer events from reaching the document.
  function handlePointerDown(event) {
    if (form.hidden || busy || dock.contains(event.target)) return;
    setOpen(false);
  }

  function handleKeyDown(event) {
    if (event.key !== 'Escape' || form.hidden || busy) return;
    setOpen(false);
    toggle.focus?.();
  }

  documentRef.addEventListener('pointerdown', handlePointerDown, true);
  documentRef.addEventListener('keydown', handleKeyDown, true);

  const embeddedPopupUnsupported = applyEmbeddedPopupGuidance({
    form, roomInput, button, status, windowRef, message: embeddedMessage,
  });
  if (embeddedPopupUnsupported) dock.dataset.state = form.dataset.state;

  const controller = createHandoffSourceController({
    ...controllerOptions,
    windowRef,
    onStateChange(detail) {
      busy = detail.state === HANDOFF_SOURCE_STATES.WAITING_READY
        || detail.state === HANDOFF_SOURCE_STATES.WAITING_ACK;
      if (status) status.textContent = detail.message || '';
      if (button) button.disabled = busy;
      form.dataset.state = detail.state;
      dock.dataset.state = detail.state;
    },
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (embeddedPopupUnsupported) return;
    const cleaned = sanitizeRoomCode(roomInput?.value);
    if (roomInput) roomInput.value = cleaned || '';
    controller.open(cleaned);
  });

  return {
    ...controller,
    setOpen,
    dispose() {
      documentRef.removeEventListener('pointerdown', handlePointerDown, true);
      documentRef.removeEventListener('keydown', handleKeyDown, true);
      controller.dispose();
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
  if (!sceneDocument || !embeddedAssets) return null;
  return mountHandoffPanel({
    documentRef,
    windowRef,
    embeddedMessage: EMBEDDED_POPUP_MESSAGE,
    controllerOptions: { targetUrl, sceneDocument, embeddedAssets },
  });
}

// Static exports hand off their published page URL. The target fetches the
// marker/scene document itself, so no scene data or credentials cross windows.
export function mountUrlHandoff({
  sourceUrl = globalThis.location?.href,
  targetUrl = globalThis.__SCENE_SYNC_HANDOFF_TARGET_URL__ || DEFAULT_SCENE_SYNC_HANDOFF_URL,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  if (!sourceUrl) return null;
  return mountHandoffPanel({
    documentRef,
    windowRef,
    embeddedMessage: EMBEDDED_URL_POPUP_MESSAGE,
    controllerOptions: { targetUrl, sourceUrl },
  });
}
