import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffTargetSession, createHandoffTokenTargetSession, readHandoffTargetContext } from './target.js';

const sessionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const requestId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const targetSearch = `?handoff=1&handoffSession=${sessionId}&handoffRequest=${requestId}&room=room-42`;
const validMessage = {
  type: 'scene-sync-handoff', version: 1, sessionId, requestId, mode: 'add', roomId: 'room-42',
  sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [] }, embeddedAssets: {},
};

function createFakeTargetWindow(opener) {
  const listeners = new Map();
  return {
    opener,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    async emitMessage(event) { return await listeners.get('message')?.(event); },
    hasMessageListener() { return listeners.has('message'); },
  };
}

function validating(message, options) {
  if (message.sessionId !== options.expectedSessionId || message.requestId !== options.expectedRequestId) {
    return { valid: false, reason: 'handoff-session-mismatch' };
  }
  return {
    valid: true, roomId: options.expectedRoomId,
    sceneDocument: message.sceneDocument, embeddedAssets: message.embeddedAssets,
  };
}

test('target context accepts an optional sanitized room and rejects an invalid URL room', () => {
  const withoutRoom = readHandoffTargetContext({
    search: `?handoff=1&handoffSession=${sessionId}&handoffRequest=${requestId}`,
  });
  assert.equal(withoutRoom.valid, true);
  assert.equal(withoutRoom.roomId, null);
  assert.equal(readHandoffTargetContext({
    search: `?handoff=1&handoffSession=${sessionId}&handoffRequest=${requestId}&room=Room!`,
  }).valid, false);
});

test('target ignores non-handoff locations and source-mismatched messages', async () => {
  const replies = [];
  const opener = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const plainWindow = createFakeTargetWindow(opener);
  const plain = createHandoffTargetSession({ windowRef: plainWindow, locationRef: { search: '?handoff=1' } });
  assert.equal(plain.enabled, false);
  assert.equal(plainWindow.hasMessageListener(), false);

  const handoffWindow = createFakeTargetWindow(opener);
  createHandoffTargetSession({
    windowRef: handoffWindow, locationRef: { search: targetSearch },
    validateMessage: validating, applyMessage: async () => {},
  });
  assert.equal(replies.length, 1);
  await handoffWindow.emitMessage({ source: {}, origin: 'https://source.test', data: validMessage });
  assert.equal(replies.length, 1);
});

test('target sends bound READY immediately, then joins/imports and sends minimal ACK', async () => {
  const replies = [];
  const order = [];
  const opener = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const windowRef = createFakeTargetWindow(opener);
  const session = createHandoffTargetSession({
    windowRef, locationRef: { search: targetSearch }, validateMessage: validating,
    ensureRoom: async (roomId) => order.push(`room:${roomId}`),
    applyMessage: async () => order.push('apply'),
  });
  assert.deepEqual(replies[0], {
    message: { type: 'scene-sync-ready', version: 1, sessionId, requestId }, origin: '*',
  });
  await windowRef.emitMessage({ source: opener, origin: 'https://source.test', data: validMessage });
  assert.deepEqual(order, ['room:room-42', 'apply']);
  assert.deepEqual(replies[1], {
    message: { type: 'scene-sync-handoff-ack', version: 1, sessionId, requestId, status: 'ok' },
    origin: 'https://source.test',
  });
  assert.equal(JSON.stringify(replies[1]).includes('sceneDocument'), false);
  assert.equal(session.getState().complete, true);
});

test('target rejects cross-session messages, concurrent duplicate, and replay', async () => {
  const replies = [];
  const diagnostics = [];
  const opener = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const windowRef = createFakeTargetWindow(opener);
  let releaseApply;
  const applyGate = new Promise((resolve) => { releaseApply = resolve; });
  createHandoffTargetSession({
    windowRef, locationRef: { search: targetSearch }, validateMessage: validating,
    applyMessage: async () => await applyGate,
    onDiagnostic: (reason) => diagnostics.push(reason),
  });
  await windowRef.emitMessage({
    source: opener, origin: 'https://source.test', data: { ...validMessage, requestId: sessionId },
  });
  assert.equal(replies.at(-1).message.reason, 'handoff-session-mismatch');

  const first = windowRef.emitMessage({ source: opener, origin: 'https://source.test', data: validMessage });
  await Promise.resolve();
  await windowRef.emitMessage({ source: opener, origin: 'https://source.test', data: validMessage });
  assert.equal(replies.at(-1).message.reason, 'handoff-busy');
  releaseApply();
  await first;
  await windowRef.emitMessage({ source: opener, origin: 'https://source.test', data: validMessage });
  assert.equal(replies.at(-1).message.reason, 'handoff-replay');
  assert.ok(diagnostics.includes('handoff-busy'));
  assert.ok(diagnostics.includes('handoff-replay'));
});

test('target preserves visible diagnostic and safe coded import error ACK for opaque source', async () => {
  const replies = [];
  const diagnostics = [];
  const opener = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const windowRef = createFakeTargetWindow(opener);
  createHandoffTargetSession({
    windowRef, locationRef: { search: targetSearch }, validateMessage: validating,
    applyMessage: async () => {
      const error = new Error('private detail');
      error.code = 'handoff-object-id-conflict';
      throw error;
    },
    onDiagnostic: (reason) => diagnostics.push(reason),
  });
  await windowRef.emitMessage({ source: opener, origin: 'null', data: validMessage });
  assert.equal(diagnostics.at(-1), 'handoff-object-id-conflict');
  assert.deepEqual(replies.at(-1), {
    message: {
      type: 'scene-sync-handoff-ack', version: 1, sessionId, requestId,
      status: 'error', reason: 'handoff-object-id-conflict',
    },
    origin: '*',
  });
});

test('target sends a timeout error ACK and releases busy after an aborted loader', async () => {
  const replies = [];
  const opener = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const windowRef = createFakeTargetWindow(opener);
  let attempts = 0;
  const session = createHandoffTargetSession({
    windowRef, locationRef: { search: targetSearch }, validateMessage: validating,
    applyMessage: async () => {
      attempts += 1;
      const error = new Error('deadline'); error.code = 'handoff-url-timeout'; throw error;
    },
  });
  await windowRef.emitMessage({ source: opener, origin: 'https://source.test', data: validMessage });
  assert.equal(replies.at(-1).message.reason, 'handoff-url-timeout');
  assert.equal(session.getState().busy, false);
  await windowRef.emitMessage({ source: opener, origin: 'https://source.test', data: validMessage });
  assert.equal(attempts, 2);
  assert.equal(replies.at(-1).message.reason, 'handoff-url-timeout');
});

test('target binds URL handoff sourceUrl to the postMessage origin', async () => {
  const replies = [];
  const opener = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const windowRef = createFakeTargetWindow(opener);
  let applied = 0;
  createHandoffTargetSession({
    windowRef, locationRef: { search: targetSearch },
    validateMessage: (message, options) => ({ valid: true, roomId: options.expectedRoomId, sourceUrl: message.sourceUrl }),
    applyMessage: async () => { applied += 1; },
  });
  const urlMessage = { type: 'scene-sync-handoff', sessionId, requestId, sourceUrl: 'https://publisher.test/world/' };
  await windowRef.emitMessage({ source: opener, origin: 'https://wrong.test', data: urlMessage });
  assert.equal(replies.at(-1).message.reason, 'handoff-source-origin-mismatch');
  assert.equal(applied, 0);
  await windowRef.emitMessage({ source: opener, origin: 'https://publisher.test', data: urlMessage });
  assert.equal(replies.at(-1).message.status, 'ok');
  assert.equal(applied, 1);
});

test('token target claims once then applies embedded and URL payloads exclusively', async () => {
  const token = 'a'.repeat(64);
  const windowRef = { setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout() {}, location: { href: 'https://afjk.jp/scenesync/' } };
  const calls = [];
  const embedded = createHandoffTokenTargetSession({
    windowRef, locationRef: windowRef.location,
    bootstrap: { token, sessionId, requestId, roomId: 'room-42' },
    fetchRef: async () => ({ status: 200, ok: true, json: async () => ({ payload: { version: 1, mode: 'embedded', sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [] }, embeddedAssets: {} } }) }),
    ensureRoom: async (room) => calls.push(`room:${room}`), applyPayload: async (payload) => calls.push(payload.mode),
  });
  await embedded.ready();
  assert.deepEqual(calls, ['room:room-42', 'embedded']);
  const urlCalls = [];
  const url = createHandoffTokenTargetSession({
    windowRef, locationRef: windowRef.location,
    bootstrap: { token: 'b'.repeat(64), sessionId, requestId, roomId: null },
    fetchRef: async () => ({ status: 200, ok: true, json: async () => ({ payload: { version: 1, mode: 'url', sourceUrl: 'https://static.test/world/' } }) }),
    applyPayload: async (payload) => urlCalls.push(payload.sourceUrl),
  });
  await url.ready();
  assert.deepEqual(urlCalls, ['https://static.test/world/']);
});
