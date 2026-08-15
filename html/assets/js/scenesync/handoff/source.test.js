import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffSourceController } from './source.js';

function createPopup() {
  const sent = [];
  return {
    closed: false,
    sent,
    postMessage: (message, origin) => sent.push({ message, origin }),
    close() { this.closed = true; },
  };
}

function createFakeWindow(popups = []) {
  const listeners = new Map();
  const timeouts = new Map();
  const intervals = new Map();
  let nextId = 1;
  let randomByte = 1;
  const opened = [];
  return {
    crypto: {
      getRandomValues(bytes) {
        bytes.fill(randomByte++);
        return bytes;
      },
    },
    location: { href: 'file:///portable-scene.html' },
    open(url, name) {
      opened.push({ url, name });
      return popups.shift() || null;
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
    fireTimeout() { const [id, fn] = timeouts.entries().next().value || []; timeouts.delete(id); fn?.(); },
    pollClosed() { intervals.values().next().value?.(); },
    opened,
  };
}

const sceneDocument = { format: 'scene-sync-export-scene', version: 2, objects: [] };
const embeddedAssets = {};

test('source completes bound READY/SEND/ACK and resets READY to import timeout', () => {
  const popup = createPopup();
  const windowRef = createFakeWindow([popup]);
  const states = [];
  const controller = createHandoffSourceController({
    windowRef, targetUrl: 'https://afjk.jp/scenesync/', sceneDocument, embeddedAssets,
    onStateChange: (detail) => states.push(detail),
  });
  const opened = controller.open(' Room-42! ');
  const url = new URL(opened.url);
  assert.equal(url.searchParams.get('room'), 'room-42');
  assert.equal(url.searchParams.get('handoffSession'), opened.sessionId);
  assert.equal(url.searchParams.get('handoffRequest'), opened.requestId);

  windowRef.emitMessage({
    source: popup, origin: 'https://afjk.jp',
    data: { type: 'scene-sync-ready', version: 1, sessionId: opened.sessionId, requestId: 'wrongwrongwrongwrong' },
  });
  assert.equal(popup.sent.length, 0);
  windowRef.emitMessage({
    source: popup, origin: 'https://afjk.jp',
    data: { type: 'scene-sync-ready', version: 1, sessionId: opened.sessionId, requestId: opened.requestId },
  });
  assert.equal(popup.sent[0].message.sessionId, opened.sessionId);
  assert.equal(popup.sent[0].message.requestId, opened.requestId);
  assert.equal(controller.getState(), 'waiting-ack');

  windowRef.emitMessage({
    source: popup, origin: 'https://afjk.jp',
    data: {
      type: 'scene-sync-handoff-ack', version: 1,
      sessionId: opened.sessionId, requestId: opened.requestId, status: 'ok',
    },
  });
  assert.equal(controller.getState(), 'complete');
  assert.equal(states.at(-1).message, 'Opened in Scene Sync.');
});

test('source separates READY/import timeout and reports popup blocked/closed', () => {
  const readyPopup = createPopup();
  const readyWindow = createFakeWindow([readyPopup]);
  const readyStates = [];
  const ready = createHandoffSourceController({
    windowRef: readyWindow, sceneDocument, embeddedAssets,
    onStateChange: (detail) => readyStates.push(detail),
  });
  ready.open();
  readyWindow.fireTimeout();
  assert.equal(readyStates.at(-1).reason, 'ready-timeout');

  const importPopup = createPopup();
  const importWindow = createFakeWindow([importPopup]);
  const importStates = [];
  const importing = createHandoffSourceController({
    windowRef: importWindow, sceneDocument, embeddedAssets,
    onStateChange: (detail) => importStates.push(detail),
  });
  const opened = importing.open();
  importWindow.emitMessage({
    source: importPopup, origin: 'https://afjk.jp',
    data: { type: 'scene-sync-ready', version: 1, sessionId: opened.sessionId, requestId: opened.requestId },
  });
  importWindow.fireTimeout();
  assert.equal(importStates.at(-1).reason, 'import-timeout');

  const blocked = createHandoffSourceController({
    windowRef: createFakeWindow(), sceneDocument, embeddedAssets,
  });
  assert.equal(blocked.open().reason, 'blocked');

  const closedPopup = createPopup();
  const closedWindow = createFakeWindow([closedPopup]);
  const closed = createHandoffSourceController({ windowRef: closedWindow, sceneDocument, embeddedAssets });
  closed.open();
  closedPopup.closed = true;
  closedWindow.pollClosed();
  assert.equal(closed.getState(), 'failed');
});

test('retry closes the old popup and ignores stale READY/ACK messages', () => {
  const firstPopup = createPopup();
  const secondPopup = createPopup();
  const windowRef = createFakeWindow([firstPopup, secondPopup]);
  const controller = createHandoffSourceController({ windowRef, sceneDocument, embeddedAssets });
  const first = controller.open();
  const second = controller.open();
  assert.equal(firstPopup.closed, true);
  assert.notEqual(first.sessionId, second.sessionId);
  windowRef.emitMessage({
    source: firstPopup, origin: 'https://afjk.jp',
    data: { type: 'scene-sync-ready', version: 1, sessionId: first.sessionId, requestId: first.requestId },
  });
  assert.equal(secondPopup.sent.length, 0);
  windowRef.emitMessage({
    source: secondPopup, origin: 'https://afjk.jp',
    data: { type: 'scene-sync-ready', version: 1, sessionId: second.sessionId, requestId: second.requestId },
  });
  windowRef.emitMessage({
    source: firstPopup, origin: 'https://afjk.jp',
    data: {
      type: 'scene-sync-handoff-ack', version: 1,
      sessionId: first.sessionId, requestId: first.requestId, status: 'ok',
    },
  });
  assert.equal(controller.getState(), 'waiting-ack');
});
