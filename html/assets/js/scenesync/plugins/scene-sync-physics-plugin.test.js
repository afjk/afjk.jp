import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneSyncPhysicsPlugin } from './scene-sync-physics-plugin.js';
import { createSceneSyncScheduleContext } from '../runtime/schedule-context.js';

function makeRuntime(overrides = {}) {
  return {
    update(clockState) {
      return { active: true, tick: 1, events: [], limited: false, reached: true, ...overrides };
    },
    hasBodies() { return true; },
    dispose() {},
    ...overrides,
  };
}

test('SceneSyncPhysicsPlugin update calls runtime.update', () => {
  const calls = [];
  const runtime = {
    update(clockState) {
      calls.push(clockState);
      return { active: true, tick: 1, events: [], limited: false, reached: true };
    },
    hasBodies() { return false; },
    dispose() {},
  };
  const plugin = createSceneSyncPhysicsPlugin({ physicsRuntime: runtime });
  const clockState = { t: 1.0 };
  const ctx = createSceneSyncScheduleContext({ now: 1000, frameId: 1, clockState });
  plugin.update(clockState, ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], clockState);
});

test('SceneSyncPhysicsPlugin forwards collision events to scheduleContext', () => {
  const runtime = {
    update(clockState) {
      return {
        active: true,
        tick: 10,
        events: [
          { type: 'physics.collision.enter', objectIdA: 'box-1', objectIdB: 'sphere-2', pairKey: 'box-1|sphere-2', tick: 10 },
        ],
        limited: false,
        reached: true,
      };
    },
    hasBodies() { return true; },
    dispose() {},
  };
  const plugin = createSceneSyncPhysicsPlugin({ physicsRuntime: runtime });
  const clockState = { t: 0.5 };
  const ctx = createSceneSyncScheduleContext({ now: 500, frameId: 5, clockState });
  plugin.update(clockState, ctx);
  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.collisionEvents.length, 1);
  assert.equal(ctx.events[0].type, 'physics.collision.enter');
  assert.equal(ctx.events[0].objectIdA, 'box-1');
  assert.equal(ctx.events[0].objectIdB, 'sphere-2');
  assert.equal(ctx.events[0].pairKey, 'box-1|sphere-2');
  assert.equal(ctx.events[0].source, 'physics');
  assert.equal(ctx.events[0].phase, 'postPhysics');
  assert.equal(ctx.events[0].frameId, 5);
});

test('SceneSyncPhysicsPlugin does not throw when events array is empty', () => {
  const plugin = createSceneSyncPhysicsPlugin({ physicsRuntime: makeRuntime({ update: () => ({ active: true, tick: 1, events: [], limited: false, reached: true }) }) });
  const ctx = createSceneSyncScheduleContext({ now: 0, frameId: 1 });
  assert.doesNotThrow(() => plugin.update({ t: 0 }, ctx));
  assert.equal(ctx.events.length, 0);
});

test('SceneSyncPhysicsPlugin does not throw without runtime', () => {
  const plugin = createSceneSyncPhysicsPlugin();
  const ctx = createSceneSyncScheduleContext({ now: 0 });
  assert.doesNotThrow(() => plugin.update({ t: 0 }, ctx));
  assert.equal(ctx.events.length, 0);
});

test('SceneSyncPhysicsPlugin does not throw without scheduleContext', () => {
  const plugin = createSceneSyncPhysicsPlugin({ physicsRuntime: makeRuntime() });
  assert.doesNotThrow(() => plugin.update({ t: 0 }, null));
  assert.doesNotThrow(() => plugin.update({ t: 0 }));
});

test('SceneSyncPhysicsPlugin handles null events from runtime', () => {
  const runtime = {
    update() { return { active: false, tick: 0, events: null }; },
    hasBodies() { return false; },
    dispose() {},
  };
  const plugin = createSceneSyncPhysicsPlugin({ physicsRuntime: runtime });
  const ctx = createSceneSyncScheduleContext({ now: 0 });
  assert.doesNotThrow(() => plugin.update({ t: 0 }, ctx));
  assert.equal(ctx.events.length, 0);
});

test('SceneSyncPhysicsPlugin hasBodies delegates to runtime', () => {
  const plugin = createSceneSyncPhysicsPlugin({ physicsRuntime: makeRuntime() });
  assert.equal(plugin.hasBodies(), true);
});

test('SceneSyncPhysicsPlugin dispose clears runtime', () => {
  let disposed = false;
  const runtime = {
    update() { return { active: false, events: [] }; },
    hasBodies() { return false; },
    dispose() { disposed = true; },
  };
  const plugin = createSceneSyncPhysicsPlugin({ physicsRuntime: runtime });
  plugin.dispose();
  assert.equal(disposed, true);
  assert.equal(plugin.getRuntime(), null);
});

test('SceneSyncPhysicsPlugin exit events reach scheduleContext', () => {
  const runtime = {
    update() {
      return {
        active: true,
        tick: 20,
        events: [
          { type: 'physics.collision.exit', objectIdA: 'a', objectIdB: 'b', pairKey: 'a|b', tick: 20 },
        ],
        limited: false,
        reached: true,
      };
    },
    hasBodies() { return true; },
    dispose() {},
  };
  const plugin = createSceneSyncPhysicsPlugin({ physicsRuntime: runtime });
  const ctx = createSceneSyncScheduleContext({ now: 0, frameId: 2, clockState: { t: 1 } });
  plugin.update({ t: 1 }, ctx);
  assert.equal(ctx.collisionEvents.length, 1);
  assert.equal(ctx.collisionEvents[0].type, 'physics.collision.exit');
});
