export const PLAYER_INTERACTION_EVENT_TIMELINE_ID = 'player-interaction';
export const PLAYER_INTERACTION_EVENT_LOG_KIND = 'scene-event-log';
export const PLAYER_INTERACTION_EVENT_SOURCE = 'player-shell';
export const PLAYER_POINTER_INTERACTION_CHANNELS = Object.freeze([
  'pointer.click',
  'pointer.drag.start',
  'pointer.drag.move',
  'pointer.drag.end',
  'pointer.drag.cancel',
]);

const PLAYER_POINTER_INTERACTION_CHANNEL_SET = new Set(PLAYER_POINTER_INTERACTION_CHANNELS);

function normalizeString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeOptionalString(value) {
  const normalized = normalizeString(value, '');
  return normalized || null;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function cloneArray(value) {
  return Array.isArray(value) ? value.slice() : value;
}

export function resolvePlayerInteractionEventChannel(event) {
  return normalizeString(event?.channel ?? event?.type, '');
}

export function resolvePlayerInteractionEventTarget(event) {
  return normalizeOptionalString(event?.target) || normalizeOptionalString(event?.objectId);
}

export function isPlayerInteractionChannel(channel) {
  return PLAYER_POINTER_INTERACTION_CHANNEL_SET.has(normalizeString(channel, ''));
}

export function isPlayerInteractionSceneEvent(payload) {
  return payload?.kind === 'scene-event' &&
    isPlayerInteractionChannel(resolvePlayerInteractionEventChannel(payload));
}

export function normalizePlayerInteractionSceneEvent(payload = {}, { fromPeer = null } = {}) {
  if (!isPlayerInteractionSceneEvent(payload)) return null;
  const target = resolvePlayerInteractionEventTarget(payload);
  if (!target) return null;
  return {
    ...payload,
    kind: 'scene-event',
    channel: resolvePlayerInteractionEventChannel(payload),
    target,
    source: normalizeString(payload.source, PLAYER_INTERACTION_EVENT_SOURCE),
    sourcePeerId: payload.sourcePeerId || fromPeer?.id || undefined,
  };
}

export function createPlayerInteractionPointerPayload({
  pointerId = null,
  pointerType = 'mouse',
  button = 0,
  clientX = 0,
  clientY = 0,
  startClientX = 0,
  startClientY = 0,
  maxPointerDistanceSquared = 0,
  physicsInput = null,
} = {}) {
  const payload = {
    pointerId,
    pointerType: normalizeString(pointerType, 'mouse'),
    button: nonNegativeInteger(button, 0),
    clientX: finiteNumber(clientX, finiteNumber(startClientX, 0)),
    clientY: finiteNumber(clientY, finiteNumber(startClientY, 0)),
    startClientX: finiteNumber(startClientX, 0),
    startClientY: finiteNumber(startClientY, 0),
    maxPointerDistanceSquared: finiteNumber(maxPointerDistanceSquared, 0),
  };

  if (physicsInput) {
    payload.physicsInputId = physicsInput.inputId;
    payload.physicsPhase = physicsInput.phase;
    payload.controlMode = physicsInput.controlMode;
    payload.position = cloneArray(physicsInput.position);
    payload.velocity = cloneArray(physicsInput.velocity);
  }

  return payload;
}
