import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareSceneEvents,
  createSceneEventTimeline,
  normalizeSceneEventEnvelope,
  sceneEventToRuntimeEvent,
} from './event-timeline.js';

test('normalizeSceneEventEnvelope creates a canonical scene event', () => {
  const event = normalizeSceneEventEnvelope({
    channel: 'pointer.click',
    target: 'box-1',
    interactionId: 'click-1',
    sequence: 2,
    eventRevision: 5,
    applyTick: 10,
    timestamp: 1.25,
    payload: { button: 0 },
  });
  assert.equal(event.kind, 'scene-event');
  assert.equal(event.timelineId, 'default');
  assert.equal(event.channel, 'pointer.click');
  assert.equal(event.target, 'box-1');
  assert.equal(event.eventId, 'click-1:000002');
  assert.equal(event.eventRevision, 5);
  assert.equal(event.applyTick, 10);
  assert.deepEqual(event.payload, { button: 0 });
});

test('normalizeSceneEventEnvelope rejects missing channel', () => {
  assert.equal(normalizeSceneEventEnvelope({ target: 'box-1' }), null);
});

test('compareSceneEvents sorts by tick, revision, event revision, interaction, sequence, channel, id', () => {
  const events = [
    { applyTick: 2, timelineRevision: 0, eventRevision: 1, interactionId: 'b', sequence: 0, channel: 'b', eventId: '2' },
    { applyTick: 1, timelineRevision: 0, eventRevision: 2, interactionId: 'a', sequence: 1, channel: 'a', eventId: '1' },
    { applyTick: 1, timelineRevision: 0, eventRevision: 1, interactionId: 'a', sequence: 2, channel: 'a', eventId: '3' },
  ];
  const sorted = [...events].sort(compareSceneEvents);
  assert.equal(sorted[0].eventId, '3');
  assert.equal(sorted[1].eventId, '1');
  assert.equal(sorted[2].eventId, '2');
});

test('timeline queues and consumes due events in canonical order', () => {
  const timeline = createSceneEventTimeline();
  assert.equal(timeline.queueEvent({ channel: 'b', eventId: 'b', applyTick: 2 }).ok, true);
  assert.equal(timeline.queueEvent({ channel: 'a', eventId: 'a', applyTick: 1 }).ok, true);
  assert.deepEqual(timeline.consumeDueEvents(0), []);
  assert.deepEqual(timeline.consumeDueEvents(1).map(event => event.eventId), ['a']);
  assert.deepEqual(timeline.consumeDueEvents(2).map(event => event.eventId), ['b']);
});

test('timeline updates duplicate event ids instead of appending', () => {
  const timeline = createSceneEventTimeline();
  timeline.queueEvent({ channel: 'pointer.drag.move', eventId: 'drag:1', applyTick: 2, payload: { x: 1 } });
  timeline.queueEvent({ channel: 'pointer.drag.move', eventId: 'drag:1', applyTick: 2, payload: { x: 2 } });
  const due = timeline.consumeDueEvents(2);
  assert.equal(due.length, 1);
  assert.deepEqual(due[0].payload, { x: 2 });
  assert.equal(timeline.getEventHistory().length, 1);
});

test('timeline reports replay when an already consumed event id is updated', () => {
  const timeline = createSceneEventTimeline();
  timeline.queueEvent({ channel: 'pointer.click', eventId: 'click:1', applyTick: 1, payload: { value: 1 } });
  timeline.consumeDueEvents(1);
  const result = timeline.queueEvent(
    { channel: 'pointer.click', eventId: 'click:1', applyTick: 1, payload: { value: 2 } },
    { currentTick: 3 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.replayRequired, true);
});

test('timeline advances revision and rejects old future events', () => {
  const timeline = createSceneEventTimeline();
  assert.equal(timeline.queueEvent({ channel: 'future.old', eventId: 'old', applyTick: 20 }).ok, true);
  const branch = timeline.queueEvent({
    channel: 'branch',
    eventId: 'branch',
    timelineRevision: 1,
    branchTick: 10,
    eventRevision: 1,
    applyTick: 10,
  });
  assert.equal(branch.ok, true);
  assert.equal(timeline.getTimelineState().timelineRevision, 1);
  assert.equal(timeline.getTimelineState().timelineForkTick, 10);
  assert.equal(timeline.queueEvent({
    channel: 'stale.future',
    eventId: 'stale',
    timelineRevision: 0,
    applyTick: 21,
  }).ok, false);
});

test('timeline clear drops history and rejects duplicate clears', () => {
  const timeline = createSceneEventTimeline();
  timeline.queueEvent({ channel: 'pointer.click', eventId: 'click', applyTick: 1 });
  assert.equal(timeline.clearEventHistory({
    timelineId: 'default',
    timelineRevision: 2,
    timelineClearRevision: 1,
  }), true);
  assert.deepEqual(timeline.getPendingEvents(), []);
  assert.deepEqual(timeline.getEventHistory(), []);
  assert.equal(timeline.getTimelineState().timelineRevision, 2);
  assert.equal(timeline.getTimelineState().timelineClearRevision, 1);
  assert.equal(timeline.clearEventHistory({
    timelineId: 'default',
    timelineRevision: 2,
    timelineClearRevision: 1,
  }), false);
});

test('sceneEventToRuntimeEvent produces Loomlet-compatible env event fields', () => {
  const runtimeEvent = sceneEventToRuntimeEvent({
    channel: 'pointer.click',
    eventId: 'click',
    eventRevision: 4,
    applyTick: 8,
    target: 'box-1',
    sourcePeerId: 'peer-1',
    timestamp: 2,
    payload: { button: 0 },
  });
  assert.equal(runtimeEvent.type, 'pointer.click');
  assert.equal(runtimeEvent.channel, 'pointer.click');
  assert.equal(runtimeEvent.target, 'box-1');
  assert.equal(runtimeEvent.objectId, 'box-1');
  assert.equal(runtimeEvent.timestamp, 2);
  assert.equal(runtimeEvent.eventRevision, 4);
  assert.deepEqual(runtimeEvent.payload, { button: 0 });
});

test('sceneEventToRuntimeEvent preserves collision and schedule fields', () => {
  const runtimeEvent = sceneEventToRuntimeEvent({
    channel: 'physics.collision.enter',
    eventId: 'collision:1',
    objectIdA: 'box-1',
    objectIdB: 'sphere-2',
    pairKey: 'box-1|sphere-2',
    tick: 75,
    frameId: 120,
    timestamp: 1.25,
  });
  assert.equal(runtimeEvent.objectIdA, 'box-1');
  assert.equal(runtimeEvent.objectIdB, 'sphere-2');
  assert.equal(runtimeEvent.pairKey, 'box-1|sphere-2');
  assert.equal(runtimeEvent.tick, 75);
  assert.equal(runtimeEvent.frameId, 120);
});

test('timeline clear rejects revision regression by default', () => {
  const timeline = createSceneEventTimeline({ timelineRevision: 3 });
  assert.equal(timeline.clearEventHistory({
    timelineId: 'default',
    timelineRevision: 1,
    timelineClearRevision: 1,
  }), false);
  assert.equal(timeline.getTimelineState().timelineRevision, 3);
  assert.equal(timeline.getTimelineState().timelineClearRevision, 0);
});

test('timeline clear can explicitly allow canonical revision regression', () => {
  const timeline = createSceneEventTimeline({ timelineRevision: 3 });
  assert.equal(timeline.clearEventHistory({
    timelineId: 'default',
    timelineRevision: 1,
    timelineClearRevision: 1,
  }, { allowRevisionRegression: true }), true);
  assert.equal(timeline.getTimelineState().timelineRevision, 1);
  assert.equal(timeline.getTimelineState().timelineClearRevision, 1);
});
