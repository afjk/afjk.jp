import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createRoomLifecycle } from '../src/scenesync/room-lifecycle.mjs';

function fixture() {
  const events = [], clears = [];
  const lifecycle = createRoomLifecycle({ delayMs: 25, emit: (room, event) => events.push({ room, ...event }), onClear: room => clears.push(room) });
  return { lifecycle, events, clears };
}
test('one countdown per room; duplicate requests cannot extend or repeat it', async () => {
  const { lifecycle: l, events, clears } = fixture();
  const epoch = l.snapshot('room').epoch;
  l.request('room', { id: 'a', nickname: 'Phone' }, 'first', epoch);
  const deadline = l.snapshot('room').pending.deadline;
  l.request('room', { id: 'b' }, 'second', epoch);
  l.request('room', { id: 'a' }, 'first', epoch);
  assert.equal(l.snapshot('room').pending.deadline, deadline);
  await delay(45);
  assert.deepEqual(clears, ['room']);
  assert.notEqual(l.snapshot('room').epoch, epoch);
  assert.equal(events.at(-1).actorName, 'Phone');
  l.request('room', { id: 'a' }, 'first', l.snapshot('room').epoch);
  assert.equal(l.snapshot('room').pending, null);
  l.clear();
});
test('any connection may cancel the exact pending operation; late/stale cancellation is harmless', async () => {
  const { lifecycle: l, clears } = fixture();
  const epoch = l.snapshot('room').epoch;
  l.request('room', { id: 'a' }, 'first', epoch);
  assert.equal(l.cancel('room', 'wrong'), false);
  assert.equal(l.cancel('room', 'first'), true);
  await delay(45);
  assert.equal(l.snapshot('room').epoch, epoch);
  assert.equal(clears.length, 0);
  assert.equal(l.cancel('room', 'first'), false);
  l.clear();
});
test('legacy traffic remains compatible until clear, then old/missing epochs are rejected across mutation families', async () => {
  const { lifecycle: l } = fixture();
  const epoch = l.snapshot('room').epoch;
  assert.equal(l.accepts('room', { kind: 'scene-add' }), true);
  l.request('room', { id: 'a' }, 'first', epoch);
  await delay(45);
  for (const payload of [
    { kind: 'scene-add' }, { kind: 'scene-state', objects: {} }, { kind: 'scene-batch', actions: [] },
    { type: 'scene-graph-set' }, { kind: 'ai-command' }, { kind: 'scene-mesh' }, { kind: 'scene-physics-input' },
  ]) {
    assert.equal(l.accepts('room', payload), false);
    assert.equal(l.accepts('room', { ...payload, sceneEpoch: epoch }), false);
    assert.equal(l.accepts('room', { ...payload, sceneEpoch: l.snapshot('room').epoch }), true);
  }
  assert.equal(l.accepts('room', { kind: 'scene-avatar' }), true);
  assert.equal(l.accepts('room', { kind: 'scene-add', sceneEpoch: l.snapshot('room').epoch }, { sceneProtocol: 1, sceneReadyEpoch: epoch }), false);
  l.clear();
});
test('last departure cancels pending clear and forgets all clear records', async () => {
  const { lifecycle: l, clears } = fixture();
  const old = l.snapshot('room').epoch;
  l.request('room', { id: 'a' }, 'first', old);
  l.remove('room');
  await delay(45);
  assert.equal(clears.length, 0);
  assert.notEqual(l.snapshot('room').epoch, old);
  assert.equal(l.snapshot('room').cleared, false);
  assert.equal(l.accepts('room', { kind: 'scene-add' }), true);
  l.clear();
});
