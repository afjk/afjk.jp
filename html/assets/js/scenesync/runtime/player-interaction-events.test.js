import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPlayerInteractionPointerPayload,
  isPlayerInteractionSceneEvent,
  normalizePlayerInteractionSceneEvent,
  PLAYER_INTERACTION_EVENT_SOURCE,
  PLAYER_INTERACTION_EVENT_TIMELINE_ID,
  PLAYER_POINTER_INTERACTION_CHANNELS,
  resolvePlayerInteractionEventChannel,
  resolvePlayerInteractionEventTarget,
} from './player-interaction-events.js';

test('player interaction constants define the shared pointer contract', () => {
  assert.equal(PLAYER_INTERACTION_EVENT_TIMELINE_ID, 'player-interaction');
  assert.equal(PLAYER_INTERACTION_EVENT_SOURCE, 'player-shell');
  assert.deepEqual(PLAYER_POINTER_INTERACTION_CHANNELS, [
    'pointer.click',
    'pointer.drag.start',
    'pointer.drag.move',
    'pointer.drag.end',
    'pointer.drag.cancel',
  ]);
});

test('normalizePlayerInteractionSceneEvent accepts pointer scene events with target aliases', () => {
  const event = normalizePlayerInteractionSceneEvent({
    kind: 'scene-event',
    type: 'pointer.click',
    objectId: 'box-1',
    eventId: 'click-1',
    payload: { clientX: 10 },
  }, {
    fromPeer: { id: 'peer-1' },
  });

  assert.equal(event.kind, 'scene-event');
  assert.equal(event.channel, 'pointer.click');
  assert.equal(event.target, 'box-1');
  assert.equal(event.source, PLAYER_INTERACTION_EVENT_SOURCE);
  assert.equal(event.sourcePeerId, 'peer-1');
  assert.deepEqual(event.payload, { clientX: 10 });
});

test('normalizePlayerInteractionSceneEvent falls back from blank target to objectId', () => {
  const event = normalizePlayerInteractionSceneEvent({
    kind: 'scene-event',
    channel: 'pointer.click',
    target: ' ',
    objectId: 'box-1',
  });

  assert.equal(event.target, 'box-1');
});

test('normalizePlayerInteractionSceneEvent preserves canonical source peer ids', () => {
  const event = normalizePlayerInteractionSceneEvent({
    kind: 'scene-event',
    channel: 'pointer.drag.start',
    target: 'box-1',
    source: 'player-shell',
    sourcePeerId: 'authority-peer',
  }, {
    fromPeer: { id: 'relay-peer' },
  });

  assert.equal(event.sourcePeerId, 'authority-peer');
});

test('normalizePlayerInteractionSceneEvent rejects unsupported or targetless events', () => {
  assert.equal(normalizePlayerInteractionSceneEvent({
    kind: 'scene-event',
    channel: 'keyboard.down',
    target: 'box-1',
  }), null);
  assert.equal(normalizePlayerInteractionSceneEvent({
    kind: 'scene-event',
    channel: 'pointer.click',
  }), null);
});

test('player interaction helpers resolve channel and target consistently', () => {
  assert.equal(resolvePlayerInteractionEventChannel({ type: 'pointer.drag.move' }), 'pointer.drag.move');
  assert.equal(resolvePlayerInteractionEventTarget({ objectId: 'box-1' }), 'box-1');
  assert.equal(isPlayerInteractionSceneEvent({ kind: 'scene-event', channel: 'pointer.drag.cancel' }), true);
  assert.equal(isPlayerInteractionSceneEvent({ kind: 'scene-event', channel: 'object.hover.enter' }), false);
});

test('createPlayerInteractionPointerPayload normalizes pointer metadata and physics linkage', () => {
  const payload = createPlayerInteractionPointerPayload({
    pointerId: 7,
    pointerType: 'pen',
    button: 0,
    clientX: 12,
    clientY: 24,
    startClientX: 10,
    startClientY: 20,
    maxPointerDistanceSquared: 25,
    physicsInput: {
      inputId: 'drag-1:000001',
      phase: 'grab-move',
      controlMode: 'hold',
      position: [1, 2, 3],
      velocity: [4, 5, 6],
    },
  });

  assert.deepEqual(payload, {
    pointerId: 7,
    pointerType: 'pen',
    button: 0,
    clientX: 12,
    clientY: 24,
    startClientX: 10,
    startClientY: 20,
    maxPointerDistanceSquared: 25,
    physicsInputId: 'drag-1:000001',
    physicsPhase: 'grab-move',
    controlMode: 'hold',
    position: [1, 2, 3],
    velocity: [4, 5, 6],
  });
});

test('createPlayerInteractionPointerPayload falls back to drag start coordinates', () => {
  const payload = createPlayerInteractionPointerPayload({
    clientX: Number.NaN,
    clientY: Number.NaN,
    startClientX: 10,
    startClientY: 20,
  });

  assert.equal(payload.clientX, 10);
  assert.equal(payload.clientY, 20);
});
