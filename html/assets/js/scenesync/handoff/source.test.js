import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffSourceController } from './source.js';

function createFakeWindow({ popup = null } = {}) {
  const listeners = new Map();
  const timeouts = new Map();
  const intervals = new Map();
  let nextId = 1;
  const opened = [];
  return {
    location: { href: 'file:///portable-scene.html' },
    open(url, name) {
      opened.push({ url, name });
      return popup;
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    setTimeout(fn) { const id = nextId++; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn) { const id = nextId++; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    emitMessage(event) { return listeners.get('message')?.(event); },
    fireTimeout() { const fn = timeouts.values().next().value; fn?.(); },
    pollClosed() { const fn = intervals.values().next().value; fn?.(); },
    opened,
  };
}

const sceneDocument = { format: 'scene-sync-export-scene', version: 2, objects: [] };
const embeddedAssets = {};

test('source opens on demand and completes READY/SEND/ACK with origin and source binding', () => {
  const sent = [];
  const popup = { closed: false, postMessage: (message, origin) => sent.push({ message, origin }) };
  const windowRef = createFakeWindow({ popup });
  const states = [];
  const controller = createHandoffSourceController({
    windowRef,
    targetUrl: 'https://afjk.jp/scenesync/',
    sceneDocument,
    embeddedAssets,
    onStateChange: (detail) => states.push(detail),
  });

  const opened = controller.open(' Room-42! ');
  assert.equal(opened.opened, true);
  assert.equal(new URL(opened.url).searchParams.get('handoff'), '1');
  assert.equal(new URL(opened.url).searchParams.get('room'), 'room-42');

  windowRef.emitMessage({ source: {}, origin: 'https://afjk.jp', data: { type: 'scene-sync-ready', version: 1 } });
  windowRef.emitMessage({ source: popup, origin: 'https://attacker.test', data: { type: 'scene-sync-ready', version: 1 } });
  assert.equal(sent.length, 0);
  windowRef.emitMessage({ source: popup, origin: 'https://afjk.jp', data: { type: 'scene-sync-ready', version: 1 } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].origin, 'https://afjk.jp');
  assert.equal(sent[0].message.type, 'scene-sync-handoff');
  assert.equal(sent[0].message.roomId, 'room-42');
  assert.equal(controller.getState(), 'waiting-ack');

  windowRef.emitMessage({
    source: popup,
    origin: 'https://afjk.jp',
    data: { type: 'scene-sync-handoff-ack', version: 1, status: 'ok' },
  });
  assert.equal(controller.getState(), 'complete');
  assert.equal(states.at(-1).message, 'Opened in Scene Sync.');
  controller.dispose();
});

test('source reports popup blocked, READY timeout, and popup closed', () => {
  const blockedWindow = createFakeWindow({ popup: null });
  const blocked = createHandoffSourceController({
    windowRef: blockedWindow, sceneDocument, embeddedAssets,
  });
  assert.equal(blocked.open().reason, 'blocked');
  assert.equal(blocked.getState(), 'failed');

  const popup = { closed: false, postMessage() {} };
  const timeoutWindow = createFakeWindow({ popup });
  const timeout = createHandoffSourceController({
    windowRef: timeoutWindow, sceneDocument, embeddedAssets,
  });
  timeout.open();
  timeoutWindow.fireTimeout();
  assert.equal(timeout.getState(), 'failed');

  const closedWindow = createFakeWindow({ popup });
  const closed = createHandoffSourceController({
    windowRef: closedWindow, sceneDocument, embeddedAssets,
  });
  popup.closed = false;
  closed.open();
  popup.closed = true;
  closedWindow.pollClosed();
  assert.equal(closed.getState(), 'failed');
});
