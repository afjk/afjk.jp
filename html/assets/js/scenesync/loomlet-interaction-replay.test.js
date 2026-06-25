import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createSceneSyncLoomIntegration,
  LOOMLET_INTERACTION_EVENT_LOG_KIND,
  LOOMLET_INTERACTION_TIMELINE_ID,
} from './loomlet-runtime-integration.js';

function createPositionObject() {
  return {
    position: {
      x: 0,
      y: 0,
      z: 0,
      set(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    },
  };
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableHash(value) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);
}

function interactionGraph() {
  return {
    nodes: [
      { id: 'click', type: 'onEvent', params: { channel: 'pointer.click' } },
      { id: 'dragStart', type: 'onEvent', params: { channel: 'pointer.drag.start' } },
      { id: 'clickCount', type: 'list.length' },
      { id: 'dragStartCount', type: 'list.length' },
      { id: 'total', type: 'add' },
      { id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', y: 2, z: 3 } },
    ],
    edges: [
      { from: 'click.event', to: 'clickCount.list' },
      { from: 'dragStart.event', to: 'dragStartCount.list' },
      { from: 'clickCount.out', to: 'total.a' },
      { from: 'dragStartCount.out', to: 'total.b' },
      { from: 'total.out', to: 'move.x' },
    ],
  };
}

function baseEvents() {
  return [
    {
      kind: 'scene-event',
      timelineId: LOOMLET_INTERACTION_TIMELINE_ID,
      timelineRevision: 0,
      timelineClearRevision: 0,
      eventRevision: 2,
      eventId: 'drag-a:event:000001',
      interactionId: 'drag-a',
      sequence: 1,
      applyTick: 2,
      channel: 'pointer.drag.start',
      source: 'player-shell',
      target: 'box-1',
      timestamp: 2 / 60,
      payload: { pointerId: 1, clientX: 12, clientY: 20 },
    },
    {
      kind: 'scene-event',
      timelineId: LOOMLET_INTERACTION_TIMELINE_ID,
      timelineRevision: 0,
      timelineClearRevision: 0,
      eventRevision: 1,
      eventId: 'drag-a:event:000000',
      interactionId: 'drag-a',
      sequence: 0,
      applyTick: 2,
      channel: 'pointer.click',
      source: 'player-shell',
      target: 'box-1',
      timestamp: 2 / 60,
      payload: { pointerId: 1, clientX: 10, clientY: 20 },
    },
    {
      kind: 'scene-event',
      timelineId: LOOMLET_INTERACTION_TIMELINE_ID,
      timelineRevision: 0,
      timelineClearRevision: 0,
      eventRevision: 3,
      eventId: 'drag-b:event:000000',
      interactionId: 'drag-b',
      sequence: 0,
      applyTick: 4,
      channel: 'pointer.click',
      source: 'player-shell',
      target: 'box-1',
      timestamp: 4 / 60,
      payload: { pointerId: 1, clientX: 32, clientY: 44 },
    },
  ];
}

function createIntegration({ enableDebug = true } = {}) {
  const object = createPositionObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (objectId) => (objectId === 'box-1' ? object : null),
    getObjectRuntimeTime: (_objectId, _now, clockState) => clockState?.t ?? 0,
    enableDebug,
  });
  integration.handlePayload({
    type: 'scene-graph-set',
    scope: { object: 'box-1' },
    graph: interactionGraph(),
  });
  return { integration, object };
}

function tickRange(integration, fromTick = 0, toTick = 5) {
  for (let tick = fromTick; tick <= toTick; tick += 1) {
    integration.tickObjectGraphs({
      t: tick / 60,
      deltaTime: 1 / 60,
      tick,
    }, tick * 1000);
  }
}

function effectTrace(integration, object) {
  const records = integration.debugState().eventEvaluations['object:box-1'] || [];
  return {
    records: records.map(record => ({
      tick: record.tick,
      eventIds: record.events.map(event => event.eventId),
      channels: record.events.map(event => event.channel),
      payloads: record.events.map(event => event.payload),
      effects: record.effects.map(effect => ({
        type: effect.type,
        objectId: effect.objectId,
        position: effect.position,
      })),
    })),
    finalPosition: {
      x: object.position.x,
      y: object.position.y,
      z: object.position.z,
    },
  };
}

function traceHash(trace) {
  return stableHash(trace);
}

function createEventLog(events = baseEvents(), extra = {}) {
  return {
    kind: LOOMLET_INTERACTION_EVENT_LOG_KIND,
    eventLogKind: LOOMLET_INTERACTION_EVENT_LOG_KIND,
    source: 'player-shell',
    timelineVersion: 1,
    timelineId: LOOMLET_INTERACTION_TIMELINE_ID,
    timelineRevision: 0,
    timelineForkTick: 0,
    timelineClearRevision: 0,
    lastEventRevision: events.reduce((max, event) => Math.max(max, event.eventRevision || 0), 0),
    eventCount: events.length,
    events,
    ...extra,
  };
}

function applyEvents(integration, events, options = {}) {
  for (const event of events) {
    integration.queueInteractionEvent(event, {
      currentTick: options.currentTick ?? 0,
      processDue: false,
    });
  }
}

function runScenario(events, { applyAsLog = true, currentTick = 0 } = {}) {
  const { integration, object } = createIntegration();
  if (applyAsLog) {
    integration.applyInteractionEventLog(createEventLog(events), {
      currentTick,
      processDue: false,
    });
  } else {
    applyEvents(integration, events, { currentTick });
  }
  tickRange(integration);
  const trace = effectTrace(integration, object);
  return { trace, hash: traceHash(trace) };
}

test('Loomlet interaction replay is deterministic for the same event log', () => {
  const log = createEventLog(baseEvents());
  const authority = runScenario(cloneJson(log.events), { applyAsLog: true });
  const follower = runScenario(cloneJson(log.events), { applyAsLog: true });

  assert.deepEqual(follower.trace, authority.trace);
  assert.equal(follower.hash, authority.hash);
  assert.equal(authority.hash, '925487a088cc833f');
  assert.deepEqual(authority.trace.records.map(record => record.eventIds), [
    ['drag-a:event:000000', 'drag-a:event:000001'],
    ['drag-b:event:000000'],
  ]);
  assert.deepEqual(authority.trace.records.map(record => record.effects[0].position), [
    [2, 2, 3],
    [1, 2, 3],
  ]);
  assert.deepEqual(authority.trace.finalPosition, { x: 0, y: 2, z: 3 });
});

test('Loomlet interaction replay dedupes unordered event log echoes deterministically', () => {
  const canonical = runScenario(baseEvents());
  const unorderedWithDuplicates = runScenario([
    baseEvents()[2],
    baseEvents()[0],
    baseEvents()[1],
    baseEvents()[0],
    baseEvents()[2],
  ]);

  assert.deepEqual(unorderedWithDuplicates.trace, canonical.trace);
  assert.equal(unorderedWithDuplicates.hash, canonical.hash);
});

test('Loomlet interaction replay from exported history matches authority trace', () => {
  const { integration: authority, object: authorityObject } = createIntegration();
  applyEvents(authority, baseEvents(), { currentTick: 0 });
  tickRange(authority);
  const log = authority.createInteractionEventLog({ t: 5 / 60, tick: 5 });
  const authorityTrace = effectTrace(authority, authorityObject);

  const { integration: lateJoiner, object: lateJoinerObject } = createIntegration();
  lateJoiner.applyInteractionEventLog(cloneJson(log), {
    currentTick: 0,
    processDue: false,
  });
  tickRange(lateJoiner);
  const lateTrace = effectTrace(lateJoiner, lateJoinerObject);

  assert.deepEqual(lateTrace, authorityTrace);
  assert.equal(traceHash(lateTrace), traceHash(authorityTrace));
});
