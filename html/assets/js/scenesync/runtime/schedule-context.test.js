import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSceneSyncScheduleContext,
  emitScheduleEvent,
  emitScheduleDiagnostic,
} from './schedule-context.js';

test('createSceneSyncScheduleContext creates context with defaults', () => {
  const ctx = createSceneSyncScheduleContext({ now: 1000, frameId: 5 });
  assert.equal(ctx.now, 1000);
  assert.equal(ctx.frameId, 5);
  assert.equal(ctx.clockState, null);
  assert.deepEqual(ctx.events, []);
  assert.deepEqual(ctx.collisionEvents, []);
  assert.deepEqual(ctx.diagnostics, []);
});

test('createSceneSyncScheduleContext defaults frameId to 0', () => {
  const ctx = createSceneSyncScheduleContext({ now: 0 });
  assert.equal(ctx.frameId, 0);
});

test('createSceneSyncScheduleContext stores clockState', () => {
  const clockState = { t: 1.5 };
  const ctx = createSceneSyncScheduleContext({ now: 100, clockState });
  assert.equal(ctx.clockState, clockState);
});

test('createSceneSyncScheduleContext uses fallback when now is not finite', () => {
  const ctx = createSceneSyncScheduleContext({});
  assert.ok(Number.isFinite(ctx.now));
});

test('emitScheduleEvent pushes event to events array', () => {
  const ctx = createSceneSyncScheduleContext({ now: 0 });
  const event = { type: 'custom.event', source: 'test' };
  emitScheduleEvent(ctx, event);
  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0], event);
  assert.equal(ctx.collisionEvents.length, 0);
});

test('emitScheduleEvent pushes collision event to both events and collisionEvents', () => {
  const ctx = createSceneSyncScheduleContext({ now: 0 });
  const event = { type: 'physics.collision.enter', objectIdA: 'a', objectIdB: 'b' };
  emitScheduleEvent(ctx, event);
  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.collisionEvents.length, 1);
  assert.equal(ctx.collisionEvents[0], event);
});

test('emitScheduleEvent works for collision.exit too', () => {
  const ctx = createSceneSyncScheduleContext({ now: 0 });
  emitScheduleEvent(ctx, { type: 'physics.collision.exit', objectIdA: 'a', objectIdB: 'b' });
  assert.equal(ctx.collisionEvents.length, 1);
});

test('emitScheduleEvent is safe with null scheduleContext', () => {
  assert.doesNotThrow(() => emitScheduleEvent(null, { type: 'x' }));
});

test('emitScheduleEvent is safe with null event', () => {
  const ctx = createSceneSyncScheduleContext({ now: 0 });
  assert.doesNotThrow(() => emitScheduleEvent(ctx, null));
  assert.equal(ctx.events.length, 0);
});

test('emitScheduleDiagnostic pushes to diagnostics', () => {
  const ctx = createSceneSyncScheduleContext({ now: 0 });
  const diag = { message: 'step-limit', source: 'physics' };
  emitScheduleDiagnostic(ctx, diag);
  assert.equal(ctx.diagnostics.length, 1);
  assert.equal(ctx.diagnostics[0], diag);
});

test('emitScheduleDiagnostic is safe with null scheduleContext', () => {
  assert.doesNotThrow(() => emitScheduleDiagnostic(null, { message: 'x' }));
});

test('multiple events accumulate correctly', () => {
  const ctx = createSceneSyncScheduleContext({ now: 0 });
  emitScheduleEvent(ctx, { type: 'physics.collision.enter', objectIdA: 'a', objectIdB: 'b' });
  emitScheduleEvent(ctx, { type: 'physics.collision.exit', objectIdA: 'c', objectIdB: 'd' });
  emitScheduleEvent(ctx, { type: 'custom.event' });
  assert.equal(ctx.events.length, 3);
  assert.equal(ctx.collisionEvents.length, 2);
});
