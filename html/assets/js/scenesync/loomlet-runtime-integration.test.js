import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareLoomletRuntimeScopeKeys,
  createSceneSyncLoomIntegration,
  LOOMLET_INTERACTION_EVENT_LOG_KIND,
  LOOMLET_INTERACTION_TIMELINE_ID,
  normalizeLoomletHostEventsForRuntime,
  resolveLoomletRuntimeDeltaTime,
  resolveLoomletRuntimeTick,
} from './loomlet-runtime-integration.js';

test('normalizeLoomletHostEventsForRuntime keeps legacy channel sets compatible', () => {
  const events = normalizeLoomletHostEventsForRuntime(new Set(['object.hover.enter']), {
    target: 'box-1',
    timestamp: 1.25,
  });

  assert.deepEqual(events, [{
    channel: 'object.hover.enter',
    type: 'object.hover.enter',
    target: 'box-1',
    timestamp: 1.25,
    time: 1.25,
    objectId: 'box-1',
  }]);
});

test('normalizeLoomletHostEventsForRuntime preserves synchronized scene event fields', () => {
  const events = normalizeLoomletHostEventsForRuntime([{
    channel: 'pointer.click',
    eventId: 'drag-1:event:000002',
    eventRevision: 2,
    applyTick: 18,
    target: 'box-1',
    timestamp: 2,
    payload: { pointerId: 5, clientX: 10, clientY: 20 },
  }], {
    target: 'box-1',
    timestamp: 1,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].channel, 'pointer.click');
  assert.equal(events[0].type, 'pointer.click');
  assert.equal(events[0].target, 'box-1');
  assert.equal(events[0].objectId, 'box-1');
  assert.equal(events[0].timestamp, 2);
  assert.equal(events[0].eventId, 'drag-1:event:000002');
  assert.equal(events[0].applyTick, 18);
  assert.deepEqual(events[0].payload, { pointerId: 5, clientX: 10, clientY: 20 });
});

test('normalizeLoomletHostEventsForRuntime sorts events in canonical replay order', () => {
  const events = normalizeLoomletHostEventsForRuntime([
    { channel: 'pointer.drag.end', eventId: 'c', applyTick: 2, eventRevision: 1, sequence: 0, timestamp: 2 },
    { channel: 'pointer.click', eventId: 'b', applyTick: 1, eventRevision: 2, sequence: 0, timestamp: 1 },
    { channel: 'pointer.drag.start', eventId: 'a', applyTick: 1, eventRevision: 1, sequence: 0, timestamp: 1 },
  ], {
    target: 'box-1',
    timestamp: 0,
  });

  assert.deepEqual(events.map(event => event.eventId), ['a', 'b', 'c']);
});

test('resolveLoomletRuntimeDeltaTime and tick prefer deterministic clock fields', () => {
  assert.equal(resolveLoomletRuntimeDeltaTime({ deltaTime: 1 / 60, delta: 9 }), 1 / 60);
  assert.equal(resolveLoomletRuntimeDeltaTime({ delta: 0.25 }), 0.25);
  assert.equal(resolveLoomletRuntimeDeltaTime({}, 0.5), 0.5);
  assert.equal(resolveLoomletRuntimeTick({ tick: 12.9 }), 12);
  assert.equal(resolveLoomletRuntimeTick({}), undefined);
});

test('compareLoomletRuntimeScopeKeys evaluates scene before object scopes', () => {
  const keys = ['object:z', 'scene', 'object:a'].sort(compareLoomletRuntimeScopeKeys);
  assert.deepEqual(keys, ['scene', 'object:a', 'object:z']);
});

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

test('Loomlet integration passes explicit deltaTime instead of frame timestamp delta', () => {
  const object = createPositionObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (objectId) => (objectId === 'box-1' ? object : null),
  });
  const graph = {
    nodes: [
      { id: 'speed', type: 'constant', params: { value: 2 } },
      { id: 'integrator', type: 'integrate', params: { initial: 0 } },
      { id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', y: 0, z: 0 } },
    ],
    edges: [
      { from: 'speed.out', to: 'integrator.value' },
      { from: 'integrator.out', to: 'move.x' },
    ],
  };

  integration.handlePayload({ type: 'scene-graph-set', scope: { object: 'box-1' }, graph });
  integration.tickObjectGraphs({ t: 0, deltaTime: 0.25 }, 1000);
  assert.equal(object.position.x, 0.5);
  integration.tickObjectGraphs({ t: 0.25, deltaTime: 0.25 }, 1_000_000);
  assert.equal(object.position.x, 1);
});

test('Loomlet integration evaluates scopes in deterministic key order', () => {
  const object = createPositionObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (objectId) => (objectId === 'box-1' ? object : null),
  });
  const sceneGraph = {
    nodes: [{ id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', x: 2, y: 0, z: 0 } }],
    edges: [],
  };
  const objectGraph = {
    nodes: [{ id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', x: 1, y: 0, z: 0 } }],
    edges: [],
  };

  integration.handlePayload({ type: 'scene-graph-set', scope: { object: 'box-1' }, graph: objectGraph });
  integration.handlePayload({ type: 'scene-graph-set', scope: 'scene', graph: sceneGraph });
  integration.tickObjectGraphs({ t: 0, deltaTime: 0 }, 0);

  assert.equal(object.position.x, 1);
});

test('Loomlet integration queues synchronized pointer events by apply tick', () => {
  const object = createPositionObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (objectId) => (objectId === 'box-1' ? object : null),
    getObjectRuntimeTime: () => 1,
    enableDebug: true,
  });
  integration.handlePayload({
    type: 'scene-graph-set',
    scope: { object: 'box-1' },
    graph: {
      nodes: [
        { id: 'click', type: 'onEvent', params: { channel: 'pointer.click' } },
        { id: 'count', type: 'list.length' },
        { id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', y: 0, z: 0 } },
      ],
      edges: [
        { from: 'click.event', to: 'count.list' },
        { from: 'count.out', to: 'move.x' },
      ],
    },
  });

  const queued = integration.queueInteractionEvent({
    kind: 'scene-event',
    timelineId: LOOMLET_INTERACTION_TIMELINE_ID,
    channel: 'pointer.click',
    eventId: 'click-1',
    target: 'box-1',
    applyTick: 4,
    timestamp: 1,
    payload: { pointerId: 1, clientX: 10, clientY: 20 },
  }, { currentTick: 3 });

  assert.equal(queued.ok, true);
  integration.tickObjectGraphs({ t: 1, deltaTime: 0, tick: 3 }, 1000);
  assert.equal(object.position.x, 0);

  integration.tickObjectGraphs({ t: 1, deltaTime: 0, tick: 4 }, 1000);
  assert.equal(object.position.x, 1);
  assert.equal(integration.getInteractionTimelineState().timelineId, LOOMLET_INTERACTION_TIMELINE_ID);
  assert.equal(integration.getPendingInteractionEvents().length, 0);

  const debug = integration.debugState();
  const records = debug.eventEvaluations['object:box-1'];
  assert.equal(records.at(-1).events[0].eventId, 'click-1');
  assert.deepEqual(records.at(-1).events[0].payload, { pointerId: 1, clientX: 10, clientY: 20 });
});

test('Loomlet interaction queue exports and applies scene event logs', () => {
  const object = createPositionObject();
  const source = createSceneSyncLoomIntegration({
    getObjectById: () => null,
    interactionTimelineId: LOOMLET_INTERACTION_TIMELINE_ID,
  });
  const target = createSceneSyncLoomIntegration({
    getObjectById: (objectId) => (objectId === 'box-1' ? object : null),
    getObjectRuntimeTime: () => 1,
  });
  target.handlePayload({
    type: 'scene-graph-set',
    scope: { object: 'box-1' },
    graph: {
      nodes: [
        { id: 'drag', type: 'onEvent', params: { channel: 'pointer.drag.start' } },
        { id: 'count', type: 'list.length' },
        { id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', y: 0, z: 0 } },
      ],
      edges: [
        { from: 'drag.event', to: 'count.list' },
        { from: 'count.out', to: 'move.x' },
      ],
    },
  });

  source.queueInteractionEvent({
    kind: 'scene-event',
    channel: 'pointer.drag.start',
    eventId: 'drag-1:event:000000',
    target: 'box-1',
    interactionId: 'drag-1',
    sequence: 0,
    applyTick: 6,
    timestamp: 2,
  }, { currentTick: 0, processDue: false });
  const log = source.createInteractionEventLog({ t: 2, tick: 6 }, {
    requestId: 'request-1',
  });

  assert.equal(log.kind, LOOMLET_INTERACTION_EVENT_LOG_KIND);
  assert.equal(log.eventCount, 1);
  assert.equal(log.requestId, 'request-1');

  const report = target.applyInteractionEventLog(log, { currentTick: 6 });
  assert.equal(report.accepted, true);
  assert.equal(report.queuedCount, 1);
  target.tickObjectGraphs({ t: 2, deltaTime: 0, tick: 6 }, 2000);
  assert.equal(object.position.x, 1);
});

test('Loomlet interaction queue rejects unsupported channels and targetless events', () => {
  const integration = createSceneSyncLoomIntegration({
    getObjectById: () => null,
  });

  assert.equal(integration.queueInteractionEvent({
    kind: 'scene-event',
    channel: 'keyboard.down',
    target: 'box-1',
  }).ok, false);
  assert.equal(integration.queueInteractionEvent({
    kind: 'scene-event',
    channel: 'pointer.click',
  }).ok, false);
});

test('Loomlet interaction queue clears with default timeline metadata', () => {
  const integration = createSceneSyncLoomIntegration({
    getObjectById: () => null,
  });

  integration.queueInteractionEvent({
    kind: 'scene-event',
    timelineId: LOOMLET_INTERACTION_TIMELINE_ID,
    channel: 'pointer.click',
    eventId: 'click-clear-1',
    target: 'box-1',
    applyTick: 4,
  }, { currentTick: 0, processDue: false });
  assert.equal(integration.getInteractionEventHistory().length, 1);

  assert.equal(integration.clearInteractionEvents(), true);
  assert.equal(integration.getInteractionEventHistory().length, 0);
  assert.equal(integration.getInteractionTimelineState().timelineClearRevision, 1);
});

test('Loomlet interaction queue does not deliver stale frame events to later graphs', () => {
  const object = createPositionObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (objectId) => (objectId === 'box-1' ? object : null),
    getObjectRuntimeTime: () => 1,
  });

  integration.queueInteractionEvent({
    kind: 'scene-event',
    timelineId: LOOMLET_INTERACTION_TIMELINE_ID,
    channel: 'pointer.click',
    eventId: 'stale-click-1',
    target: 'box-1',
    applyTick: 4,
  }, { currentTick: 4 });
  integration.tickObjectGraphs({ t: 1, deltaTime: 0, tick: 4 }, 1000);

  integration.handlePayload({
    type: 'scene-graph-set',
    scope: { object: 'box-1' },
    graph: {
      nodes: [
        { id: 'click', type: 'onEvent', params: { channel: 'pointer.click' } },
        { id: 'count', type: 'list.length' },
        { id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', y: 0, z: 0 } },
      ],
      edges: [
        { from: 'click.event', to: 'count.list' },
        { from: 'count.out', to: 'move.x' },
      ],
    },
  });
  integration.tickObjectGraphs({ t: 1, deltaTime: 0, tick: 5 }, 1000);

  assert.equal(object.position.x, 0);
});

test('Loomlet interaction queue replaces same-frame duplicate runtime events', () => {
  const object = createPositionObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (objectId) => (objectId === 'box-1' ? object : null),
    getObjectRuntimeTime: () => 1,
    enableDebug: true,
  });
  integration.handlePayload({
    type: 'scene-graph-set',
    scope: { object: 'box-1' },
    graph: {
      nodes: [
        { id: 'click', type: 'onEvent', params: { channel: 'pointer.click' } },
        { id: 'count', type: 'list.length' },
        { id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', y: 0, z: 0 } },
      ],
      edges: [
        { from: 'click.event', to: 'count.list' },
        { from: 'count.out', to: 'move.x' },
      ],
    },
  });

  integration.queueInteractionEvent({
    kind: 'scene-event',
    timelineId: LOOMLET_INTERACTION_TIMELINE_ID,
    channel: 'pointer.click',
    eventId: 'replace-click-1',
    target: 'box-1',
    applyTick: 4,
    payload: { clientX: 10 },
  }, { currentTick: 4 });
  const replacement = integration.queueInteractionEvent({
    kind: 'scene-event',
    timelineId: LOOMLET_INTERACTION_TIMELINE_ID,
    channel: 'pointer.click',
    eventId: 'replace-click-1',
    target: 'box-1',
    applyTick: 4,
    eventRevision: 2,
    payload: { clientX: 20 },
  }, { currentTick: 4 });

  assert.equal(replacement.ok, true);
  assert.equal(replacement.replacedPendingRuntimeEvent, true);
  integration.tickObjectGraphs({ t: 1, deltaTime: 0, tick: 4 }, 1000);

  const records = integration.debugState().eventEvaluations['object:box-1'];
  assert.equal(records.at(-1).events.length, 1);
  assert.equal(records.at(-1).events[0].payload.clientX, 20);
});

test('Loomlet interaction queue defers replay-required late updates', () => {
  const object = createPositionObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (objectId) => (objectId === 'box-1' ? object : null),
    getObjectRuntimeTime: () => 1,
    enableDebug: true,
  });
  integration.handlePayload({
    type: 'scene-graph-set',
    scope: { object: 'box-1' },
    graph: {
      nodes: [
        { id: 'click', type: 'onEvent', params: { channel: 'pointer.click' } },
        { id: 'count', type: 'list.length' },
        { id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', y: 0, z: 0 } },
      ],
      edges: [
        { from: 'click.event', to: 'count.list' },
        { from: 'count.out', to: 'move.x' },
      ],
    },
  });

  integration.queueInteractionEvent({
    kind: 'scene-event',
    timelineId: LOOMLET_INTERACTION_TIMELINE_ID,
    channel: 'pointer.click',
    eventId: 'late-click-1',
    target: 'box-1',
    applyTick: 1,
    payload: { clientX: 10 },
  }, { currentTick: 1 });
  integration.tickObjectGraphs({ t: 1, deltaTime: 0, tick: 1 }, 1000);
  assert.equal(object.position.x, 1);

  const lateUpdate = integration.queueInteractionEvent({
    kind: 'scene-event',
    timelineId: LOOMLET_INTERACTION_TIMELINE_ID,
    channel: 'pointer.click',
    eventId: 'late-click-1',
    target: 'box-1',
    applyTick: 1,
    eventRevision: 2,
    payload: { clientX: 20 },
  }, { currentTick: 3 });
  assert.equal(lateUpdate.ok, true);
  assert.equal(lateUpdate.replayRequired, true);

  integration.tickObjectGraphs({ t: 3, deltaTime: 0, tick: 3 }, 3000);
  const debug = integration.debugState();
  assert.equal(debug.eventEvaluations['object:box-1'].length, 1);
  assert.equal(debug.deferredInteractionReplayEvents.at(-1).event.eventId, 'late-click-1');
  assert.equal(debug.deferredInteractionReplayEvents.at(-1).event.payload.clientX, 20);
});

test('Loomlet interaction queue delivers first-seen late events once for compatibility', () => {
  const object = createPositionObject();
  const integration = createSceneSyncLoomIntegration({
    getObjectById: (objectId) => (objectId === 'box-1' ? object : null),
    getObjectRuntimeTime: () => 1,
    enableDebug: true,
  });
  integration.handlePayload({
    type: 'scene-graph-set',
    scope: { object: 'box-1' },
    graph: {
      nodes: [
        { id: 'click', type: 'onEvent', params: { channel: 'pointer.click' } },
        { id: 'count', type: 'list.length' },
        { id: 'move', type: 'scene.setPosition', params: { objectId: 'box-1', y: 0, z: 0 } },
      ],
      edges: [
        { from: 'click.event', to: 'count.list' },
        { from: 'count.out', to: 'move.x' },
      ],
    },
  });

  const queued = integration.queueInteractionEvent({
    kind: 'scene-event',
    timelineId: LOOMLET_INTERACTION_TIMELINE_ID,
    channel: 'pointer.click',
    eventId: 'first-late-click-1',
    target: 'box-1',
    applyTick: 1,
    payload: { clientX: 10 },
  }, { currentTick: 3 });

  assert.equal(queued.ok, true);
  assert.equal(queued.replayRequired, true);
  integration.tickObjectGraphs({ t: 3, deltaTime: 0, tick: 3 }, 3000);

  assert.equal(object.position.x, 1);
  const debug = integration.debugState();
  assert.equal(debug.eventEvaluations['object:box-1'].at(-1).events[0].eventId, 'first-late-click-1');
  assert.equal(debug.deferredInteractionReplayEvents.length, 0);
});
