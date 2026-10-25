// Loopback-only rooms; every pairing endpoint is mocked. No real link or token.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { localChromiumOptions } from './lib/local-chromium.mjs';

const base = process.env.AFJK_WEB_ORIGIN || 'http://127.0.0.1:8888';
const presence = process.env.AFJK_PRESENCE_URL || 'ws://127.0.0.1:8787';
for (const url of [base, presence]) assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname));
const failRenderer = process.env.AFJK_AI_RENDERER_FAILURE !== '0';
const mode = failRenderer ? 'state-only' : 'normal';
const out = `logs/ai-link/${mode}`;
await mkdir(out, { recursive: true });
const result = { ok: false, checks: [], errors: [], requests: [], security: { chromiumSandbox: true, ignoreHTTPSErrors: false } };
const browser = await chromium.launch(localChromiumOptions());
const gates = [];
let page;
const pass = name => { result.checks.push(name); console.log('PASS', name); };
const wait = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 30000 });
const visible = selector => page.locator(selector).waitFor({ state: 'visible' });
const hidden = () => page.locator('#pairing-dialog').waitFor({ state: 'hidden' });
const codeEquals = code => wait(code => document.getElementById('pairing-code').textContent === code && document.getElementById('pairing-step-code').style.display === 'block', code);
async function open() {
  await page.locator('#editor-scene-menu summary').click();
  await page.locator('#link-btn').click();
  await visible('#pairing-dialog');
  assert.equal(await page.locator('#editor-scene-menu').getAttribute('open'), null);
}
async function repeatOpen() {
  await page.evaluate(async () => {
    const { getSceneSyncShellRuntime } = await import('/assets/js/scenesync/ui/dom.js');
    const command = getSceneSyncShellRuntime().core.commands.startAiLink;
    command(); command();
  });
}
async function requestCount(expected) {
  const start = Date.now();
  while (gates.length < expected && Date.now() - start < 10000) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(gates.length, expected);
}
function finish(index, code = '123456', error = false) {
  gates[index].resolve(error ? { error: true } : { code, expiresAt: Date.now() + 300000 });
}
async function establish() {
  await page.evaluate(async () => {
    const { presenceState } = await import('/assets/js/scenesync/scene.js');
    // Synthetic UI metadata only: no token, server redeem, or authorization.
    presenceState.linkManager.establishLink({ linkId: 'mock-local-ui-link', roomId: presenceState.room, expiresAt: Date.now() + 300000 });
  });
}
async function switchRoom(suffix) {
  await page.evaluate(code => window.__sceneSyncDebug.sceneClear.switchRoom(code), `ai-ui-${Date.now().toString(36)}-${suffix}`);
  await wait(() => window.__sceneSyncDebug?.getRoomLifecycle().ready && window.__sceneSyncDebug.presence().connected);
}

try {
  const sandbox = await browser.newPage();
  await sandbox.goto('chrome://sandbox');
  result.security.status = await sandbox.locator('body').innerText();
  assert.match(result.security.status, /You are adequately sandboxed/); await sandbox.close();
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, ignoreHTTPSErrors: false });
  await context.addInitScript(failRenderer => {
    localStorage.setItem('sceneSync.welcomeSeen', 'true');
    localStorage.setItem('sceneSync.displayName', 'Mock pairing check');
    if (!failRenderer) return;
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return /^(webgl2?|experimental-webgl)$/.test(type) ? null : original.call(this, type, ...args);
    };
  }, failRenderer);
  await context.route(/\/link\/(initiate|revoke|redeem)(?:\?|$)/, async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'Access-Control-Allow-Origin': new URL(base).origin, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.protocol, 'http:');
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    assert.equal(request.method(), 'POST');
    assert.equal(request.headers().authorization, undefined);
    assert.ok(!url.pathname.endsWith('/redeem'), 'Never redeem a code during UI verification');
    result.requests.push({ url: url.href, method: request.method(), bodyKeys: Object.keys(request.postDataJSON()).sort() });
    if (url.pathname.endsWith('/revoke')) return route.fulfill({ json: { ok: true }, headers });
    assert.deepEqual(Object.keys(request.postDataJSON()).sort(), ['peerId', 'roomId', 'userId']);
    const gate = {};
    gate.promise = new Promise(resolve => { gate.resolve = resolve; }); gates.push(gate);
    const response = await gate.promise;
    if (response.error) return route.abort('failed');
    return route.fulfill({ json: response, headers });
  });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(`${base}/scenesync/?dev=1&shell=editor&room=ai-ui-${Date.now().toString(36)}&presence=${encodeURIComponent(presence)}`, { waitUntil: 'domcontentloaded' });
  await wait(() => window.__sceneSyncDebug?.getRoomLifecycle().ready && !!window.sceneSyncShell);
  assert.equal(await page.evaluate(() => window.__sceneSyncDebug.renderer().available), !failRenderer);
  const initialObjects = await page.evaluate(() => window.__sceneSyncDebug.objects.list());

  await open(); await visible('#pairing-status'); await requestCount(1);
  assert.equal(await page.locator('#pairing-code').isVisible(), false);
  assert.equal(await page.locator('#btn-copy-pairing-code').isEnabled(), false);
  await repeatOpen(); assert.equal(gates.length, 1);
  await page.screenshot({ path: `${out}/loading.png` });
  await page.locator('#btn-cancel-pairing').click(); await hidden();
  await open(); await requestCount(1); finish(0); await codeEquals('123456');
  await page.locator('#btn-cancel-pairing').click(); await hidden();
  await open(); await codeEquals('123456'); assert.equal(gates.length, 1);
  pass(`${mode} entry shows loading before HTTP initiation; repeated clicks and close/reopen reuse one request and its code`);

  await page.evaluate(async () => {
    const { core } = (await import('/assets/js/scenesync/ui/dom.js')).getSceneSyncShellRuntime();
    window.aiShortcutCalls = 0;
    for (const name of ['deleteSelected', 'undo', 'redo']) core.commands[name] = () => { window.aiShortcutCalls++; };
  });
  await page.locator('#btn-cancel-pairing').focus();
  await page.keyboard.press('Delete'); await page.keyboard.press('Control+z');
  // Also protect shortcuts if another menu returns focus outside this modal.
  await page.evaluate(() => document.getElementById('add-btn').focus());
  await page.keyboard.press('Delete'); await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(() => window.aiShortcutCalls), 0);
  await page.locator('#btn-cancel-pairing').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.getElementById('pairing-dialog').contains(document.activeElement)), true);
  await page.keyboard.press('Escape'); await hidden();
  pass('AI dialog shields scene shortcuts, traps Tab and closes with Escape');

  await open(); await establish(); await visible('#pairing-step-linked');
  // Capturing a software-rendered frame can outlast the two-second auto-close.
  // Take the screenshot after manually reopening, when auto-close is disabled.
  await page.keyboard.press('Escape'); await hidden(); await open();
  await visible('#pairing-step-linked');
  await page.screenshot({ path: `${out}/linked.png` });
  await page.waitForTimeout(2200);
  assert.equal(await page.locator('#pairing-dialog').isVisible(), true);
  assert.equal(gates.length, 1);
  await page.locator('#btn-revoke-link').click(); await hidden();
  pass('mock completion switches to linked state; manual reopen clears auto-close, and mocked revoke resets the UI');

  await open(); await requestCount(2); finish(1, undefined, true);
  await visible('#pairing-error');
  assert.match(await page.locator('#pairing-error').innerText(), /fetch/i);
  await visible('#btn-retry-pairing');
  await page.screenshot({ path: `${out}/error.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator('#pairing-dialog .pairing-content').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y >= 0 && bounds.y + bounds.height <= 845, JSON.stringify(bounds));
  await page.screenshot({ path: `${out}/mobile-error.png` });
  await page.evaluate(() => { document.getElementById('btn-retry-pairing').click(); document.getElementById('btn-retry-pairing').click(); });
  await requestCount(3); await visible('#pairing-status');
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.keyboard.press('Escape'); await hidden();
  finish(2, '333333');
  await wait(() => document.getElementById('pairing-dialog').style.display === 'none');
  await open(); await codeEquals('333333'); assert.equal(gates.length, 3);
  pass('network errors remain visible with retry; duplicate retry is suppressed and late success cannot reopen a cancelled dialog');

  await page.locator('#btn-cancel-pairing').click();
  await switchRoom('a'); await open(); await requestCount(4);
  await switchRoom('b'); await hidden(); await open(); await requestCount(5);
  finish(4, '555555'); await codeEquals('555555');
  finish(3, undefined, true);
  await page.waitForTimeout(150);
  await codeEquals('555555');
  pass('room/peer changes close pending UI; an old room failure cannot overwrite the new room code');

  await page.locator('#btn-cancel-pairing').click();
  await switchRoom('c'); await open(); await requestCount(6);
  await establish(); await visible('#pairing-step-linked');
  finish(5, '666666');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#pairing-step-linked').isVisible(), true);
  await hidden();
  await open(); await visible('#pairing-step-linked');
  await page.locator('#btn-revoke-link').click(); await hidden();
  pass('completion invalidates a pending initiation; its late response cannot replace linked state, and auto-close works');
  assert.deepEqual(await page.evaluate(() => window.__sceneSyncDebug.objects.list()), initialObjects);
  assert.equal(await page.evaluate(async () => (await import('/assets/js/scenesync/scene.js')).presenceState.linkManager.getLinkToken()), null);
  assert.deepEqual(result.errors, []);
  result.ok = true;
} catch (error) {
  result.error = error.stack;
  await page?.screenshot({ path: `${out}/failure.png`, timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  for (const gate of gates) gate.resolve({ error: true });
  await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2));
  await browser.close();
}
