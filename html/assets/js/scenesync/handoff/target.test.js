import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffTargetSession, readHandoffTargetContext } from './target.js';

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
