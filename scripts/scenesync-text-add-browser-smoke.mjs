// All edits in this test are isolated loopback fixtures, never deployed rooms.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { localChromiumOptions } from './lib/local-chromium.mjs';

const base = process.env.AFJK_WEB_ORIGIN || 'http://127.0.0.1:8888';
const presence = process.env.AFJK_PRESENCE_URL || 'ws://127.0.0.1:8787';
for (const url of [base, presence]) assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname));
const out = 'logs/text-add';
await mkdir(out, { recursive: true });
const result = { ok: false, checks: [], errors: [], security: { chromiumSandbox: true, ignoreHTTPSErrors: false } };
const browser = await chromium.launch(localChromiumOptions());
const room = `text-add-${Date.now().toString(36)}`;
const pass = name => { result.checks.push(name); console.log('PASS', name); };
const wait = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 45000 });
const ready = page => wait(page, () => window.__sceneSyncDebug?.getRoomLifecycle().ready && !!window.sceneSyncShell);
const ids = page => page.evaluate(() => window.__sceneSyncDebug.objects.list().filter(id => id !== 'sample-cube'));
const count = (page, n) => wait(page, n => window.__sceneSyncDebug.objects.list().filter(id => id !== 'sample-cube').length === n, n);
const object = (page, id) => page.evaluate(id => window.__sceneSyncDebug.objects.get(id), id);
const textEquals = (page, id, text) => wait(page, ({ id, text }) => window.__sceneSyncDebug.objects.get(id)?.asset?.text === text, { id, text });
async function open(name, fail = false, mobile = false) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 800 },
    ignoreHTTPSErrors: false,
    ...(mobile ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' } : {}),
  });
  await context.addInitScript(({ name, fail }) => {
    localStorage.setItem('sceneSync.welcomeSeen', 'true');
    localStorage.setItem('sceneSync.displayName', name);
    if (!fail) return;
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return /^(webgl2?|experimental-webgl)$/.test(type) ? null : getContext.call(this, type, ...args);
    };
  }, { name, fail });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => result.errors.push({ name, message: error.message }));
  const sent = [];
  page.on('websocket', ws => ws.on('framesent', ({ payload }) => {
    try { const m = JSON.parse(payload); if (m.payload?.kind) sent.push(m.payload); } catch {}
  }));
  await page.goto(`${base}/scenesync/?dev=1&shell=editor&room=${room}&presence=${encodeURIComponent(presence)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ready(page);
  assert.equal(await page.evaluate(async () => (await import('/assets/js/scenesync/scene.js')).presenceState.linkManager.isLinked()), false);
  assert.equal(await page.evaluate(() => window.__sceneSyncDebug.renderer().available), !fail);
  return { page, context, sent };
}
async function openDialog(page) {
  const menu = page.locator('#editor-scene-menu');
  if (!await menu.evaluate(el => el.open)) await menu.locator('summary').click();
  await page.locator('#editor-add-text').click();
  await page.locator('#text-add-dialog').waitFor({ state: 'visible' });
}
async function fill(page, text, position) {
  await page.locator('#text-add-content').fill(text);
  for (const [index, axis] of ['x', 'y', 'z'].entries()) await page.locator(`#text-add-${axis}`).fill(String(position[index]));
}
async function add(page, text, position, duplicate = false) {
  const before = await ids(page);
  await openDialog(page); await fill(page, text, position);
  if (duplicate) await page.evaluate(() => {
    const form = document.getElementById('text-add-form'); form.requestSubmit(); form.requestSubmit();
  });
  else await page.locator('#text-add-submit').click();
  await page.locator('#text-add-dialog').waitFor({ state: 'hidden' });
  await count(page, before.length + 1);
  const [id] = (await ids(page)).filter(id => !before.includes(id));
  assert.ok(id); await textEquals(page, id, text); return id;
}
const selected = (page, id) => wait(page, id => window.__sceneSyncDebug.getSelection().selectedObjectIds.join() === id, id);

try {
  const check = await browser.newPage(); await check.goto('chrome://sandbox');
  result.security.status = await check.locator('body').innerText();
  assert.match(result.security.status, /You are adequately sandboxed/); await check.close();
  const a = await open('visual editor');
  const original = 'Existing user note';
  const existing = await add(a.page, original, [-1.8, 1, 0]);
  const point = await a.page.evaluate(id => window.__sceneSyncDebug.objects.screenPoint(id), existing);
  assert.ok(point?.visible); await a.page.mouse.click(point.clientX, point.clientY); await selected(a.page, existing);
  const baseline = await object(a.page, existing);

  const b = await open('state-only editor', true);
  await count(b.page, 1); await textEquals(b.page, existing, original);
  await wait(b.page, () => document.querySelectorAll('#peers-list .peer-editing').length > 0);
  const reply = 'やあ、af！一緒に作ろう。';
  const position = [2.25, 1.25, -0.5];
  const replyId = await add(b.page, reply, position, true);
  await count(a.page, 2); await textEquals(a.page, replyId, reply);
  for (const peer of [a, b]) {
    const added = await object(peer.page, replyId);
    assert.deepEqual(added.position, position); assert.equal(added.asset.type, 'text'); assert.equal(added.asset.format, 'plain');
    assert.equal(added.asset.source, 'inline');
    const kept = await object(peer.page, existing);
    assert.deepEqual(kept.asset, baseline.asset); assert.deepEqual(kept.position, baseline.position);
  }
  assert.equal(b.sent.filter(m => m.kind === 'scene-add' && m.objectId === replyId).length, 1);
  await selected(a.page, existing);
  await b.page.screenshot({ path: `${out}/state-only-added.png` });
  pass('state-only numeric text add sends one scene-add, syncs literal Japanese text and preserves the locked existing object');

  await b.page.keyboard.press('Control+z');
  for (const peer of [a, b]) await count(peer.page, 1);
  await b.page.keyboard.press('Control+Shift+z');
  for (const peer of [a, b]) { await count(peer.page, 2); await textEquals(peer.page, replyId, reply); }
  pass('state-only text creation supports synchronized undo and redo');

  await openDialog(a.page); await a.page.locator('#text-add-cancel').focus();
  await a.page.keyboard.press('Delete'); await a.page.keyboard.press('Control+z');
  for (const peer of [a, b]) { await count(peer.page, 2); await textEquals(peer.page, existing, original); }
  await a.page.locator('#text-add-cancel').click();
  pass('modal button focus shields the selected object from editor Delete and Undo shortcuts');

  await openDialog(b.page); await fill(b.page, ' \n ', [0, 1, 0]);
  await b.page.locator('#text-add-submit').click(); await b.page.locator('#text-add-error').waitFor({ state: 'visible' });
  await fill(b.page, 'Must not add', [0, 1, 0]); await b.page.locator('#text-add-y').fill('');
  await b.page.locator('#text-add-submit').click();
  assert.equal(await b.page.locator('#text-add-y').evaluate(el => el.validity.valid), false);
  assert.equal((await ids(b.page)).length, 2);
  await b.page.locator('#text-add-cancel').click();
  pass('empty text, missing numeric coordinates and cancel make no object');

  const literalGraph = JSON.stringify({ nodes: [], edges: [] });
  const normalId = await add(a.page, literalGraph, [0, 2.25, -1]);
  await count(b.page, 3); await textEquals(b.page, normalId, literalGraph);
  await textEquals(a.page, existing, original); await selected(a.page, existing);
  assert.equal((await object(a.page, normalId)).asset.format, 'plain');
  pass('normal-mode add creates a separate literal text panel while another text panel stays selected');

  await a.page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', 'Normal pasted replacement');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  for (const peer of [a, b]) { await count(peer.page, 3); await textEquals(peer.page, existing, 'Normal pasted replacement'); }
  await a.page.keyboard.press('Control+z');
  for (const peer of [a, b]) await textEquals(peer.page, existing, original);
  await textEquals(b.page, replyId, reply);
  pass('normal visual paste still replaces the selected text; undo restores it and leaves new objects untouched');

  await openDialog(b.page); await fill(b.page, 'Not allowed in viewer', [0, 1, 0]);
  await b.page.evaluate(() => window.sceneSyncShell.switchTo('viewer'));
  assert.equal(await b.page.locator('#text-add-submit').isDisabled(), true);
  await b.page.evaluate(() => document.getElementById('text-add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await b.page.locator('#text-add-error').waitFor({ state: 'visible' });
  assert.equal((await ids(b.page)).length, 3);
  await b.page.locator('#text-add-cancel').click();
  await b.page.evaluate(() => window.sceneSyncShell.switchTo('editor'));
  pass('switching an open form to the viewer prevents creation, including a forced submit event');

  await openDialog(b.page); await fill(b.page, 'Not allowed while disconnected', [0, 1, 0]);
  const oldId = await b.page.evaluate(() => window.__sceneSyncDebug.presence().id);
  await b.page.evaluate(async () => (await import('/assets/js/scenesync/scene.js')).presenceState.ws.close(1000, 'local text-add regression'));
  await wait(b.page, () => !window.__sceneSyncDebug.getRoomLifecycle().ready);
  assert.equal(await b.page.locator('#text-add-submit').isDisabled(), true);
  await b.page.evaluate(() => document.getElementById('text-add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await b.page.locator('#text-add-error').waitFor({ state: 'visible' });
  await wait(b.page, old => window.__sceneSyncDebug.getRoomLifecycle().ready && window.__sceneSyncDebug.presence().id !== old, oldId);
  await b.page.locator('#text-add-cancel').click();
  for (const peer of [a, b]) await count(peer.page, 3);
  pass('disconnect disables creation; reconnect retains scene contents and does not submit the draft');

  const c = await open('late mobile state-only peer', true, true);
  await count(c.page, 3); await textEquals(c.page, replyId, reply);
  assert.deepEqual((await object(c.page, replyId)).position, position);
  await openDialog(c.page); await fill(c.page, reply, position);
  const bounds = await c.page.locator('#text-add-dialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y >= 0 && bounds.y + bounds.height <= 845);
  await c.page.screenshot({ path: `${out}/mobile-text-dialog.png` });
  await c.page.locator('#text-add-cancel').click();
  const replyPoint = await a.page.evaluate(id => window.__sceneSyncDebug.objects.screenPoint(id), replyId);
  await a.page.mouse.click(replyPoint.clientX, replyPoint.clientY); await selected(a.page, replyId);
  await a.page.keyboard.press('f');
  await a.page.screenshot({ path: `${out}/normal-rendered.png` });
  pass('late state-only peer receives text assets and numeric positions; mobile dialog fits the viewport');
  assert.equal([...a.sent, ...b.sent, ...c.sent].some(m => m.kind.startsWith('ai-')), false);
  assert.deepEqual(result.errors, []);
  result.ok = true;
} catch (error) {
  result.failure = error.message; throw error;
} finally {
  await browser.close(); await writeFile(`${out}/browser-result.json`, JSON.stringify(result, null, 2));
}
