import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createExportBehaviorNodeTypes,
  createExportBehaviorRuntime,
  eventMatchesScope,
  filterRuntimeEventsForScope,
  toLoomletRuntimeEvent,
} from './export-behavior-runtime.js';

function emptyGraph() {
  return { nodes: [], edges: [] };
}

function collisionEvent(overrides = {}) {
  return {
    type: 'physics.collision.enter',
    source: 'physics',
    phase: 'postPhysics',
    time: 0.5,
    tick: 30,
    frameId: 1,
    objectIdA: 'ball',
    objectIdB: 'platform',
    pairKey: 'ball|platform',
    payload: {},
    ...overrides,
  };
}

function makeCollisionOneShotGraph(soundParams = {}) {
  return {
    nodes: [
      { id: 'exists', type: 'event.exists', params: { type: 'collision.enter' } },
      { id: 'first', type: 'event.first', params: { type: 'physics.collision.enter' } },
      { id: 'pairKey', type: 'event.field', params: { field: 'pairKey', default: 'hit' } },
      { id: 'sound', type: 'audioSource.playOneShot', params: { ...soundParams } },
    ],
    edges: [
      { from: 'exists.out', to: 'sound.trigger' },
      { from: 'first.out', to: 'pairKey.event' },
      { from: 'pairKey.out', to: 'sound.name' },
    ],
  };
}

test('eventMatchesScope matches scene and related object collision events', () => {
  const event = collisionEvent();

  assert.equal(eventMatchesScope(event, { type: 'scene' }), true);
  assert.equal(eventMatchesScope(event, { type: 'object', id: 'ball' }), true);
  assert.equal(eventMatchesScope(event, { type: 'object', id: 'platform' }), true);
  assert.equal(eventMatchesScope(event, { type: 'object', id: 'other' }), false);
});

test('filterRuntimeEventsForScope filters object scoped events', () => {
  const events = [
    collisionEvent(),
    collisionEvent({ objectIdA: 'other', objectIdB: 'platform', pairKey: 'other|platform' }),
  ];

  const scoped = filterRuntimeEventsForScope(events, { type: 'object', id: 'ball' });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].pairKey, 'ball|platform');
});

test('toLoomletRuntimeEvent preserves runtime event fields and adds Loomlet channel/timestamp', () => {
  const event = toLoomletRuntimeEvent(collisionEvent());

  assert.equal(event.type, 'physics.collision.enter');
  assert.equal(event.channel, 'physics.collision.enter');
  assert.equal(event.timestamp, 0.5);
  assert.equal(event.objectIdA, 'ball');
  assert.equal(event.pairKey, 'ball|platform');
});

test('runtime passes scoped events and collisionEvents to Loomlet evaluateAt', () => {
  const calls = [];
  const runtime = createExportBehaviorRuntime(
    {
      scene: emptyGraph(),
      objects: {
        ball: emptyGraph(),
        other: emptyGraph(),
      },
    },
    new Map(),
    null,
    {
      createRuntime(graph, options) {
        assert.ok(options.nodeTypes['event.exists']);
        return {
          evaluateAt(env, now) {
            calls.push({ env, now });
          },
        };
      },
    },
  );

  const related = collisionEvent();
  const unrelated = collisionEvent({ objectIdA: 'crate', objectIdB: 'platform', pairKey: 'crate|platform' });
  runtime.setScheduleContext({
    events: [related, unrelated],
    collisionEvents: [related, unrelated],
  });
  runtime.tick({ t: 0.5 }, 500);

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].env.scope, { type: 'scene' });
  assert.equal(calls[0].env.events.length, 2);
  assert.equal(calls[0].env.collisionEvents.length, 2);
  assert.deepEqual(calls[1].env.scope, { type: 'object', id: 'ball' });
  assert.deepEqual(calls[1].env.events.map((event) => event.pairKey), ['ball|platform']);
  assert.deepEqual(calls[1].env.collisionEvents.map((event) => event.pairKey), ['ball|platform']);
  assert.deepEqual(calls[2].env.scope, { type: 'object', id: 'other' });
  assert.equal(calls[2].env.events.length, 0);
});

test('event input nodes expose exists, count, first, field, and otherObject', () => {
  const nodeTypes = createExportBehaviorNodeTypes();
  const event = toLoomletRuntimeEvent(collisionEvent());
  const ctx = {
    env: {
      scope: { type: 'object', id: 'ball' },
      events: [event],
    },
    scopeObjectId: 'ball',
  };

  assert.equal(nodeTypes['event.exists'].evaluate({ type: 'collision.enter' }, {}, ctx).out, true);
  assert.equal(nodeTypes['event.count'].evaluate({ type: 'physics.collision.enter' }, {}, ctx).out, 1);
  assert.equal(nodeTypes['event.first'].evaluate({ type: 'physics.collision.enter' }, {}, ctx).out, event);
  assert.equal(nodeTypes['event.field'].evaluate({ event, field: 'pairKey' }, {}, ctx).out, 'ball|platform');
  assert.equal(nodeTypes['event.otherObject'].evaluate({ event }, {}, ctx).out, 'platform');
});

test('collision enter triggers object scoped audioSource.playOneShot', () => {
  const effects = [];
  const runtime = createExportBehaviorRuntime(
    {
      objects: {
        ball: makeCollisionOneShotGraph({
          volume: 0.5,
          playbackRate: 1.25,
          offset: 0.1,
          url: 'https://example.test/hit.mp3',
        }),
      },
    },
    new Map(),
    { applyEffect(effect) { effects.push(effect); } },
  );

  runtime.setScheduleContext({
    events: [collisionEvent()],
    collisionEvents: [collisionEvent()],
  });
  runtime.tick({ t: 0.5 }, 500);

  assert.equal(effects.length, 1);
  assert.equal(effects[0].type, 'audioSource.playOneShot');
  assert.equal(effects[0].objectId, 'ball');
  assert.equal(effects[0].name, 'ball|platform');
  assert.deepEqual(effects[0].options, {
    volume: 0.5,
    playbackRate: 1.25,
    offset: 0.1,
    url: 'https://example.test/hit.mp3',
  });
});

test('unrelated object collision does not trigger object scoped audioSource.playOneShot', () => {
  const effects = [];
  const runtime = createExportBehaviorRuntime(
    {
      objects: {
        ball: makeCollisionOneShotGraph(),
      },
    },
    new Map(),
    { applyEffect(effect) { effects.push(effect); } },
  );

  runtime.setScheduleContext({
    events: [collisionEvent({ objectIdA: 'crate', objectIdB: 'platform', pairKey: 'crate|platform' })],
    collisionEvents: [collisionEvent({ objectIdA: 'crate', objectIdB: 'platform', pairKey: 'crate|platform' })],
  });
  runtime.tick({ t: 0.5 }, 500);

  assert.equal(effects.length, 0);
});

test('scene scoped audioSource.playOneShot without objectId is a safe no-op', () => {
  const effects = [];
  const runtime = createExportBehaviorRuntime(
    {
      scene: {
        nodes: [{ id: 'sound', type: 'audioSource.playOneShot', params: { name: 'hit' } }],
        edges: [],
      },
    },
    new Map(),
    { applyEffect(effect) { effects.push(effect); } },
  );

  runtime.setScheduleContext({ events: [], collisionEvents: [] });
  runtime.tick({ t: 0.5 }, 500);

  assert.equal(effects.length, 0);
});
