import test from 'node:test';
import assert from 'node:assert/strict';
import { HANDOFF_TOKEN_BOOTSTRAP_KEY, consumeTokenBootstrap } from './token-bootstrap.js';
import { encodeInlineHandoffPayload, MAX_INLINE_HANDOFF_ENCODED_BYTES } from './inline-payload.js';

const record = { token: 'a'.repeat(64), sessionId: 's'.repeat(22), requestId: 'r'.repeat(22), roomId: 'room-42' };

test('token bootstrap consumes a valid record exactly once and rejects stale malformed data', () => {
  const values = new Map([[HANDOFF_TOKEN_BOOTSTRAP_KEY, JSON.stringify(record)]]);
  const storage = { getItem: (key) => values.get(key) || null, removeItem: (key) => values.delete(key) };
  assert.deepEqual(consumeTokenBootstrap({ windowRef: {}, storageRef: storage }), record);
  assert.equal(consumeTokenBootstrap({ windowRef: {}, storageRef: storage }), null);
  values.set(HANDOFF_TOKEN_BOOTSTRAP_KEY, '{bad');
  assert.equal(consumeTokenBootstrap({ windowRef: {}, storageRef: storage }), null);
  const fallback = { __SCENE_SYNC_HANDOFF_TOKEN_BOOTSTRAP__: record, get sessionStorage() { throw new Error('blocked'); } };
  assert.deepEqual(consumeTokenBootstrap({ windowRef: fallback }), record);
  assert.equal(consumeTokenBootstrap({ windowRef: fallback }), null);
});

test('token bootstrap consumes a bounded inline fragment record once', () => {
  const inlinePayload = encodeInlineHandoffPayload({ kind: 'scene-sync-inline-handoff', version: 1, sessionId: record.sessionId, requestId: record.requestId, roomId: record.roomId, payload: { version: 1, mode: 'embedded', sceneDocument: { objects: [] }, embeddedAssets: {} } });
  const inline = { inlinePayload };
  const values = new Map([[HANDOFF_TOKEN_BOOTSTRAP_KEY, JSON.stringify(inline)]]);
  const storage = { getItem: (key) => values.get(key) || null, removeItem: (key) => values.delete(key) };
  assert.deepEqual(consumeTokenBootstrap({ windowRef: {}, storageRef: storage }), inline);
  assert.equal(consumeTokenBootstrap({ windowRef: {}, storageRef: storage }), null);
  values.set(HANDOFF_TOKEN_BOOTSTRAP_KEY, JSON.stringify({ ...inline, extra: true }));
  assert.equal(consumeTokenBootstrap({ windowRef: {}, storageRef: storage }), null);
  values.set(HANDOFF_TOKEN_BOOTSTRAP_KEY, JSON.stringify({ ...record, inlinePayload }));
  assert.equal(consumeTokenBootstrap({ windowRef: {}, storageRef: storage }), null, 'mixed server-token and inline records are rejected');
  values.set(HANDOFF_TOKEN_BOOTSTRAP_KEY, JSON.stringify({ inlinePayload: 'a'.repeat(MAX_INLINE_HANDOFF_ENCODED_BYTES + 1) }));
  assert.equal(consumeTokenBootstrap({ windowRef: {}, storageRef: storage }), null, 'oversized inline records are rejected');
});
