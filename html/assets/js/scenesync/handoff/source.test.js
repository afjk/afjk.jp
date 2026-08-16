import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffSourceController, isEmbeddedPopupUnsupported } from './source.js';

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
    setTimeout(fn, delay) { const id = nextId++; timeouts.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn) { const id = nextId++; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    emitMessage(event) { return listeners.get('message')?.(event); },
    fireTimeout() { const [id, entry] = timeouts.entries().next().value || []; timeouts.delete(id); entry?.fn?.(); },
    timeoutDelays() { return [...timeouts.values()].map((entry) => entry.delay); },
    pollClosed() { intervals.values().next().value?.(); },
    opened,
  };
}

const sceneDocument = { format: 'scene-sync-export-scene', version: 2, objects: [] };
const embeddedAssets = {};
const oversizedInlineAssets = {
  'assets/large.bin': { mime: 'application/octet-stream', base64: 'A'.repeat(600 * 1024) },
};

test('embedded popup guidance is proof-only for sandboxed current frame', () => {
  const top = {}; top.top = top;
  assert.equal(isEmbeddedPopupUnsupported(top), false, 'top-level remains enabled');
  const unsandboxed = { top: {}, frameElement: { getAttribute: () => null } };
  assert.equal(isEmbeddedPopupUnsupported(unsandboxed), false, 'ordinary iframe remains enabled');
  assert.equal(isEmbeddedPopupUnsupported({ top: {}, frameElement: null }), false, 'no frame element is inconclusive');
  assert.equal(isEmbeddedPopupUnsupported({ top: {}, frameElement: { hasAttribute: () => true, getAttribute: () => '' } }), true, 'empty sandbox blocks popups');
  assert.equal(isEmbeddedPopupUnsupported({ top: {}, frameElement: { hasAttribute: () => true, getAttribute: () => 'allow-scripts allow-same-origin' } }), true);
  const allowed = { top: {}, frameElement: { getAttribute: () => 'allow-scripts allow-popups' } };
  assert.equal(isEmbeddedPopupUnsupported(allowed), false, 'allow-popups remains enabled');
  assert.equal(isEmbeddedPopupUnsupported({ top: {}, frameElement: { hasAttribute: () => true, getAttribute: () => 'ALLOW-POPUPS' } }), false);
  assert.equal(isEmbeddedPopupUnsupported({ top: {}, frameElement: { hasAttribute: () => true, getAttribute: () => 'allow-popups-to-escape-sandbox' } }), true);
  const blocked = { top: {}, frameElement: { getAttribute: () => 'allow-scripts allow-forms' } };
  assert.equal(isEmbeddedPopupUnsupported(blocked), true, 'explicit sandbox without allow-popups is unsupported');
  const inaccessible = { get top() { throw new Error('cross-origin'); } };
  assert.equal(isEmbeddedPopupUnsupported(inaccessible), false, 'inaccessible frame is inconclusive');
  assert.equal(isEmbeddedPopupUnsupported({ top: {}, get frameElement() { throw new Error('cross-origin'); } }), false);
});

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

test('source sends URL-only handoffs without embedded scene data', () => {
  const popup = createPopup();
  const windowRef = createFakeWindow([popup]);
  const controller = createHandoffSourceController({ windowRef, sourceUrl: 'https://static.example/world/' });
  const opened = controller.open();
  windowRef.emitMessage({ source: popup, origin: 'https://afjk.jp', data: {
    type: 'scene-sync-ready', version: 1, sessionId: opened.sessionId, requestId: opened.requestId,
  } });
  assert.equal(popup.sent[0].message.sourceUrl, 'https://static.example/world/');
  assert.equal('sceneDocument' in popup.sent[0].message, false);
  assert.equal('embeddedAssets' in popup.sent[0].message, false);
  assert.ok(windowRef.timeoutDelays().includes(13 * 60 * 1000));
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

test('oversized embedded token transfer is explicit, opens before upload, and uploads after a null opener', async () => {
  const windowRef = createFakeWindow();
  const order = [];
  const controller = createHandoffSourceController({
    windowRef, targetUrl: 'https://target.test/scenesync/', sceneDocument, embeddedAssets: oversizedInlineAssets,
    fetchRef: async (url, init) => { order.push({ kind: 'fetch', url, init }); return { ok: true }; },
  });
  assert.equal(controller.open().reason, 'blocked');
  assert.equal(order.length, 0, 'ordinary popup failure never uploads');
  const opened = controller.openToken('Room-42!');
  assert.equal(windowRef.opened.length, 2);
  assert.equal(order.length, 0, 'window.open remains synchronous before fetch');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(order.length, 1);
  assert.equal(new URL(order[0].url).origin, 'https://target.test');
  assert.equal(order[0].init.credentials, 'omit');
  const body = JSON.parse(order[0].init.body);
  assert.match(body.token, /^[a-f0-9]{64}$/);
  assert.equal(body.payload.mode, 'embedded');
  assert.equal(new URL(opened.url).hash.includes(body.token), true);
  assert.equal(new URL(opened.url).hash.includes('handoffInline'), false);
});

test('small embedded token transfer uses a fragment-only inline payload and no upload', () => {
  const windowRef = createFakeWindow();
  const calls = [];
  const controller = createHandoffSourceController({
    windowRef, targetUrl: 'https://target.test/scenesync/', sceneDocument, embeddedAssets,
    fetchRef: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); },
  });
  const opened = controller.openToken('Room-42!');
  const url = new URL(opened.url);
  assert.equal(opened.inline, true);
  assert.equal(windowRef.opened.length, 1);
  assert.equal(calls.length, 0);
  assert.match(url.hash, /^#sceneSyncHandoffInline=v1\.[A-Za-z0-9_-]+$/u);
  assert.equal(controller.getState(), 'token-ready');
});

test('token transfer sends URL payload without embedded scene data', async () => {
  const windowRef = createFakeWindow(); let body = null;
  const controller = createHandoffSourceController({ windowRef, targetUrl: 'https://target.test/', sourceUrl: 'https://static.test/world/', fetchRef: async (_url, init) => { body = JSON.parse(init.body); return { ok: true }; } });
  controller.openToken(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(body.payload, { version: 1, mode: 'url', sourceUrl: 'https://static.test/world/' });
});

test('hung token upload times out and stale completion cannot overwrite a retry', async () => {
  const windowRef = createFakeWindow();
  const states = []; let resolveFirst;
  const controller = createHandoffSourceController({
    windowRef, sceneDocument, embeddedAssets: oversizedInlineAssets, tokenUploadTimeoutMs: 1,
    fetchRef: () => new Promise((resolve) => { resolveFirst = resolve; }), onStateChange: (detail) => states.push(detail),
  });
  controller.openToken(); await Promise.resolve();
  windowRef.fireTimeout();
  assert.equal(states.at(-1).state, 'token-failed');
  controller.openToken(); await Promise.resolve();
  resolveFirst?.({ ok: true }); await Promise.resolve();
  assert.notEqual(states.at(-1).state, 'token-ready', 'stale first upload cannot win retry state');
});

test('CSP-blocked oversized Single HTML upload gives regular-tab guidance', async () => {
  const windowRef = createFakeWindow(); const states = [];
  const controller = createHandoffSourceController({
    windowRef, sceneDocument, embeddedAssets: oversizedInlineAssets,
    fetchRef: async () => { throw new TypeError('Failed to fetch'); },
    onStateChange: (detail) => states.push(detail),
  });
  controller.openToken(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1).state, 'token-failed');
  assert.match(states.at(-1).message, /Download the Single HTML|regular tab/u);
});
