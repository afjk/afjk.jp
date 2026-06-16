import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneSyncLoomletPlugin } from './scene-sync-loomlet-plugin.js';

test('SceneSyncLoomletPlugin delegates update to loomAdapter.tick', () => {
  const calls = [];
  const adapter = {
    tick(clockState, now) {
      calls.push({ clockState, now });
    },
  };
  const plugin = createSceneSyncLoomletPlugin({ loomAdapter: adapter });
  const clockState = { t: 1.25 };
  plugin.update(clockState, { now: 1234, events: [], diagnostics: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].clockState, clockState);
  assert.equal(calls[0].now, 1234);
});

test('SceneSyncLoomletPlugin update is safe without adapter', () => {
  const plugin = createSceneSyncLoomletPlugin();
  assert.doesNotThrow(() => {
    plugin.update({ t: 0 }, { now: 0, events: [], diagnostics: [] });
  });
});

test('SceneSyncLoomletPlugin dispose delegates to adapter', () => {
  let disposed = false;
  const adapter = {
    dispose() {
      disposed = true;
    },
  };
  const plugin = createSceneSyncLoomletPlugin({ loomAdapter: adapter });
  plugin.dispose();
  assert.equal(disposed, true);
  assert.equal(plugin.getAdapter(), null);
});

test('SceneSyncLoomletPlugin init can create adapter lazily', () => {
  const context = { clock: {} };
  const adapter = { tick() {} };
  const plugin = createSceneSyncLoomletPlugin({
    createLoomAdapter(receivedContext) {
      assert.equal(receivedContext, context);
      return adapter;
    },
  });
  plugin.init(context);
  assert.equal(plugin.getAdapter(), adapter);
});

test('SceneSyncLoomletPlugin uses scheduleContext.now when provided', () => {
  const calls = [];
  const adapter = {
    tick(clockState, now) {
      calls.push({ clockState, now });
    },
  };
  const plugin = createSceneSyncLoomletPlugin({ loomAdapter: adapter });
  const clockState = { t: 2.0 };
  plugin.update(clockState, { now: 9999, events: [], diagnostics: [] });
  assert.equal(calls[0].now, 9999);
});

test('SceneSyncLoomletPlugin falls back to now() when scheduleContext.now is absent', () => {
  const calls = [];
  const adapter = {
    tick(clockState, now) {
      calls.push({ clockState, now });
    },
  };
  const fakeNow = () => 42;
  const plugin = createSceneSyncLoomletPlugin({ loomAdapter: adapter, now: fakeNow });
  plugin.update({ t: 0 }, { events: [], diagnostics: [] });
  assert.equal(calls[0].now, 42);
});
