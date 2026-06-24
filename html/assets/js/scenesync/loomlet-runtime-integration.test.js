import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLoomletHostEventsForRuntime } from './loomlet-runtime-integration.js';

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
