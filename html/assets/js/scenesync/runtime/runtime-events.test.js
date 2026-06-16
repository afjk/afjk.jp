import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCollisionPairKey,
  createPhysicsCollisionEvent,
  sortRuntimeEvents,
} from './runtime-events.js';

test('createCollisionPairKey produces canonical sorted pairKey', () => {
  assert.equal(createCollisionPairKey('box-1', 'sphere-2'), 'box-1|sphere-2');
  assert.equal(createCollisionPairKey('sphere-2', 'box-1'), 'box-1|sphere-2');
});

test('createCollisionPairKey returns empty string when either id is falsy', () => {
  assert.equal(createCollisionPairKey('', 'sphere-2'), '');
  assert.equal(createCollisionPairKey('box-1', ''), '');
  assert.equal(createCollisionPairKey(null, 'sphere-2'), '');
  assert.equal(createCollisionPairKey('box-1', null), '');
});

test('createCollisionPairKey is stable regardless of input order', () => {
  const a = createCollisionPairKey('z-object', 'a-object');
  const b = createCollisionPairKey('a-object', 'z-object');
  assert.equal(a, b);
});

test('createPhysicsCollisionEvent creates enter event with sorted objectIds', () => {
  const clockState = { t: 1.25, tick: 75 };
  const event = createPhysicsCollisionEvent({
    type: 'physics.collision.enter',
    clockState,
    frameId: 120,
    objectIdA: 'sphere-2',
    objectIdB: 'box-1',
  });
  assert.equal(event.type, 'physics.collision.enter');
  assert.equal(event.source, 'physics');
  assert.equal(event.phase, 'postPhysics');
  assert.equal(event.time, 1.25);
  assert.equal(event.tick, 75);
  assert.equal(event.frameId, 120);
  assert.equal(event.objectIdA, 'box-1');
  assert.equal(event.objectIdB, 'sphere-2');
  assert.equal(event.pairKey, 'box-1|sphere-2');
  assert.deepEqual(event.payload, {});
});

test('createPhysicsCollisionEvent objectIdA and objectIdB are always sorted', () => {
  const ev1 = createPhysicsCollisionEvent({
    type: 'physics.collision.enter',
    clockState: { t: 0 },
    objectIdA: 'zzz',
    objectIdB: 'aaa',
  });
  const ev2 = createPhysicsCollisionEvent({
    type: 'physics.collision.enter',
    clockState: { t: 0 },
    objectIdA: 'aaa',
    objectIdB: 'zzz',
  });
  assert.equal(ev1.objectIdA, 'aaa');
  assert.equal(ev1.objectIdB, 'zzz');
  assert.equal(ev1.pairKey, ev2.pairKey);
});

test('createPhysicsCollisionEvent uses time=0 when clockState.t is not finite', () => {
  const event = createPhysicsCollisionEvent({
    type: 'physics.collision.exit',
    clockState: {},
    objectIdA: 'a',
    objectIdB: 'b',
  });
  assert.equal(event.time, 0);
});

test('createPhysicsCollisionEvent omits tick when neither tick nor clockState.tick is finite', () => {
  const event = createPhysicsCollisionEvent({
    type: 'physics.collision.enter',
    clockState: { t: 1 },
    objectIdA: 'a',
    objectIdB: 'b',
  });
  assert.equal(event.tick, undefined);
});

test('createPhysicsCollisionEvent uses explicit tick over clockState.tick', () => {
  const event = createPhysicsCollisionEvent({
    type: 'physics.collision.enter',
    clockState: { t: 1, tick: 999 },
    tick: 75,
    objectIdA: 'a',
    objectIdB: 'b',
  });
  assert.equal(event.tick, 75);
});

test('createPhysicsCollisionEvent falls back to clockState.tick when tick not provided', () => {
  const event = createPhysicsCollisionEvent({
    type: 'physics.collision.enter',
    clockState: { t: 1, tick: 42 },
    objectIdA: 'a',
    objectIdB: 'b',
  });
  assert.equal(event.tick, 42);
});

test('createPhysicsCollisionEvent accepts custom payload', () => {
  const event = createPhysicsCollisionEvent({
    type: 'physics.collision.enter',
    clockState: { t: 0 },
    objectIdA: 'a',
    objectIdB: 'b',
    payload: { custom: true },
  });
  assert.deepEqual(event.payload, { custom: true });
});

test('sortRuntimeEvents sorts by type, then tick, then pairKey', () => {
  const events = [
    { type: 'physics.collision.exit', tick: 10, pairKey: 'a|b' },
    { type: 'physics.collision.enter', tick: 10, pairKey: 'c|d' },
    { type: 'physics.collision.enter', tick: 5, pairKey: 'a|b' },
    { type: 'physics.collision.enter', tick: 5, pairKey: 'c|d' },
  ];
  const sorted = sortRuntimeEvents(events);
  assert.equal(sorted[0].type, 'physics.collision.enter');
  assert.equal(sorted[0].tick, 5);
  assert.equal(sorted[0].pairKey, 'a|b');
  assert.equal(sorted[1].type, 'physics.collision.enter');
  assert.equal(sorted[1].tick, 5);
  assert.equal(sorted[1].pairKey, 'c|d');
  assert.equal(sorted[2].type, 'physics.collision.enter');
  assert.equal(sorted[2].tick, 10);
  assert.equal(sorted[3].type, 'physics.collision.exit');
});

test('sortRuntimeEvents does not mutate the original array', () => {
  const original = [
    { type: 'physics.collision.exit', tick: 1, pairKey: 'a|b' },
    { type: 'physics.collision.enter', tick: 1, pairKey: 'a|b' },
  ];
  const sorted = sortRuntimeEvents(original);
  assert.equal(original[0].type, 'physics.collision.exit');
  assert.equal(sorted[0].type, 'physics.collision.enter');
});

test('sortRuntimeEvents handles events without tick or pairKey', () => {
  const events = [
    { type: 'b.event' },
    { type: 'a.event' },
  ];
  const sorted = sortRuntimeEvents(events);
  assert.equal(sorted[0].type, 'a.event');
  assert.equal(sorted[1].type, 'b.event');
});
