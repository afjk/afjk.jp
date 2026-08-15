import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffTargetSession } from './target.js';

function createFakeTargetWindow(opener) {
  const listeners = new Map();
  return {
    opener,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    async emitMessage(event) { return await listeners.get('message')?.(event); },
    hasMessageListener() { return listeners.has('message'); },
  };
}

const validMessage = {
  type: 'scene-sync-handoff',
  version: 1,
  mode: 'add',
  roomId: 'room-42',
  sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [] },
  embeddedAssets: {},
};

test('target ignores unsolicited, non-handoff, and source-mismatched messages', async () => {
  const replies = [];
  const opener = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const plainWindow = createFakeTargetWindow(opener);
  const plain = createHandoffTargetSession({
    windowRef: plainWindow,
    locationRef: { search: '' },
    validateMessage: () => ({ valid: true }),
  });
  assert.equal(plain.enabled, false);
  assert.equal(plain.ready(), false);
  assert.equal(plainWindow.hasMessageListener(), false);

  const handoffWindow = createFakeTargetWindow(opener);
  const diagnostics = [];
  const session = createHandoffTargetSession({
    windowRef: handoffWindow,
    locationRef: { search: '?handoff=1' },
    validateMessage: () => ({ valid: true }),
    applyMessage: async () => {},
    onDiagnostic: (reason) => diagnostics.push(reason),
  });
  session.ready();
  await handoffWindow.emitMessage({ source: {}, origin: 'https://source.test', data: validMessage });
  assert.equal(replies.length, 1); // READY only
  assert.deepEqual(diagnostics, []);
});

test('target sends READY, joins requested room, imports, and ACKs without scene data', async () => {
  const replies = [];
  const opener = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const windowRef = createFakeTargetWindow(opener);
  const order = [];
  const session = createHandoffTargetSession({
    windowRef,
    locationRef: { search: '?handoff=1&room=room-42' },
    validateMessage: (message) => ({
      valid: true,
      roomId: message.roomId,
      sceneDocument: message.sceneDocument,
      embeddedAssets: message.embeddedAssets,
    }),
    ensureRoom: async (roomId) => order.push(`room:${roomId}`),
    applyMessage: async () => order.push('apply'),
  });

  assert.equal(session.ready(), true);
  assert.deepEqual(replies[0], {
    message: { type: 'scene-sync-ready', version: 1 },
    origin: '*',
  });
  await windowRef.emitMessage({ source: opener, origin: 'https://source.test', data: validMessage });
  assert.deepEqual(order, ['room:room-42', 'apply']);
  assert.deepEqual(replies[1], {
    message: { type: 'scene-sync-handoff-ack', version: 1, status: 'ok' },
    origin: 'https://source.test',
  });
  assert.equal(JSON.stringify(replies[1]).includes('sceneDocument'), false);
  assert.equal(session.getState().complete, true);
});

test('target visibly diagnoses invalid payloads and uses safe ACKs for opaque origins', async () => {
  const replies = [];
  const diagnostics = [];
  const opener = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const windowRef = createFakeTargetWindow(opener);
  const session = createHandoffTargetSession({
    windowRef,
    locationRef: { search: '?handoff=1' },
    validateMessage: () => ({ valid: false, reason: 'unsupported-handoff-mode' }),
    onDiagnostic: (reason) => diagnostics.push(reason),
  });
  session.ready();
  await windowRef.emitMessage({
    source: opener,
    origin: 'null',
    data: { ...validMessage, mode: 'replace' },
  });
  assert.deepEqual(diagnostics, ['unsupported-handoff-mode']);
  assert.deepEqual(replies[1], {
    message: {
      type: 'scene-sync-handoff-ack', version: 1, status: 'error', reason: 'unsupported-handoff-mode',
    },
    origin: '*',
  });
});
