import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { localChromiumOptions } from './lib/local-chromium.mjs';

const base = process.env.AFJK_WEB_ORIGIN || 'http://127.0.0.1:8888';
const presence = process.env.AFJK_PRESENCE_URL || 'ws://127.0.0.1:8787';
for (const url of [base, presence]) assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname));
const out = path.resolve(process.env.AFJK_SELECTION_LOCKS_OUTPUT || 'logs/selection-locks-browser-smoke');
await mkdir(out, { recursive: true });
const result = { ok: false, checks: [], errors: [], states: [], frames: [], security: { chromiumSandbox: true, ignoreHTTPSErrors: false } };
const browser = await chromium.launch(localChromiumOptions());
const room = `locks-${Date.now().toString(36)}`;
const wait = (p, fn, arg) => p.waitForFunction(fn, arg, { timeout: 45000 });
const ready = p => wait(p, () => window.__sceneSyncDebug?.getRoomLifecycle().ready);
const ids = p => p.evaluate(() => window.__sceneSyncDebug.objects.list().filter(id => id !== 'sample-cube'));
const selection = p => p.evaluate(() => window.__sceneSyncDebug.getSelection().selectedObjectIds);
const count = (p, n) => wait(p, n => window.__sceneSyncDebug.objects.list().filter(id => id !== 'sample-cube').length === n, n);
const selected = (p, id) => wait(p, id => window.__sceneSyncDebug.getSelection().selectedObjectIds.join() === id, id);
const connectedId = p => p.evaluate(() => window.__sceneSyncDebug.presence().id);
const pass = name => { result.checks.push(name); console.log('PASS', name); };
async function tap(page, selector) { await page.locator(selector).tap(); await page.waitForTimeout(200); }
async function snapshot(label, client) {
  const state = await client.page.evaluate(() => ({ presence: window.__sceneSyncDebug.presence(), selection: window.__sceneSyncDebug.getSelection(), ids: window.__sceneSyncDebug.objects.list(), toast: document.querySelector('#toast').innerText }));
  result.states.push({ label, state });
  await client.page.screenshot({ path: `${out}/${label}.png` });
}
async function open(name, holdMesh = false) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: false, locale: 'ja-JP', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' });
  await context.addInitScript(name => { localStorage.setItem('sceneSync.welcomeSeen', 'true'); localStorage.setItem('sceneSync.displayName', name); }, name);
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const frames = [];
  page.on('pageerror', error => result.errors.push({ name, message: error.message }));
  page.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
    try { const message = JSON.parse(payload); frames.push(message); if (message.payload?.kind?.startsWith('scene-') || message.type === 'error') result.frames.push({ name, ...message }); } catch {}
  }));
  let release, started;
  if (holdMesh) {
    const gate = new Promise(resolve => { release = resolve; });
    let markStarted;
    started = new Promise(resolve => { markStarted = resolve; });
    await page.route('**/presence/blob/*', async route => { markStarted(); await gate; await route.continue().catch(() => {}); });
  }
  await page.goto(`${base}/scenesync/?shell=editor&dev=1&room=${room}&presence=${encodeURIComponent(presence)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(page, () => window.__sceneSyncDebug?.getRoomLifecycle);
  if (!holdMesh) await ready(page);
  return { page, context, frames, name, release, started, cdp: await context.newCDPSession(page) };
}
async function doubleTap(client, id) {
  const point = await client.page.evaluate(id => window.__sceneSyncDebug.objects.screenPoint(id), id);
  assert.ok(point?.visible);
  await Promise.all(['touchStart', 'touchEnd', 'touchStart', 'touchEnd'].map(type =>
    client.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchStart' ? [{ x: point.clientX, y: point.clientY, id: 1 }] : [] })));
  await client.page.waitForTimeout(350);
}
async function blocked(client, id, label) {
  await doubleTap(client, id);
  assert.deepEqual(await selection(client.page), [], label);
  assert.equal(await client.page.locator('#peers-list .peer-editing').count(), 1, 'owner editing badge is restored');
  await snapshot(label, client);
  assert.match(await client.page.locator('#toast').innerText(), /編集中/);
  pass(label);
}
async function addImage(page) {
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 400;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#7ecde5'; ctx.fillRect(0, 0, 600, 400);
    ctx.fillStyle = '#f4c75a'; ctx.beginPath(); ctx.arc(470, 85, 44, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2b9957'; ctx.beginPath(); ctx.moveTo(0, 400); ctx.lineTo(225, 100); ctx.lineTo(600, 400); ctx.fill();
    return c.toDataURL().split(',')[1];
  });
  const buffer = Buffer.from(png, 'base64'); await writeFile(`${out}/lock-photo.png`, buffer);
  await tap(page, '#add-btn');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), tap(page, '#mobile-add-image-btn')]);
  await chooser.setFiles({ name: 'lock-photo.png', mimeType: 'image/png', buffer });
  await count(page, 1); const [id] = await ids(page); await selected(page, id); return id;
}
async function waitHeld(client) {
  let timer;
  try {
    await Promise.race([client.started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected held mesh request')), 20000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(await client.page.evaluate(() => window.__sceneSyncDebug.getRoomLifecycle().ready), false);
}
async function clear(page) {
  const old = await page.evaluate(() => window.__sceneSyncDebug.getRoomLifecycle().epoch);
  await tap(page, '#editor-scene-menu summary'); await tap(page, '#editor-scene-clear');
  await wait(page, old => window.__sceneSyncDebug.getRoomLifecycle().epoch !== old, old); await ready(page); return old;
}

try {
  const check = await browser.newPage(); await check.goto('chrome://sandbox');
  result.security.status = await check.locator('body').innerText(); assert.match(result.security.status, /You are adequately sandboxed/); await check.close();
  const a = await open('所有者A'); let b = await open('参加者B');
  const id = await addImage(a.page); await count(b.page, 1);
  await blocked(b, id, 'normal-connection-blocked');
  const oldB = await connectedId(b.page);
  await b.page.evaluate(async () => { (await import('/assets/js/scenesync/scene.js')).presenceState.ws.close(1000, 'selection-lock regression'); });
  await wait(b.page, old => window.__sceneSyncDebug.getRoomLifecycle().ready && window.__sceneSyncDebug.presence().id !== old, oldB);
  await count(b.page, 1); await blocked(b, id, 'reconnect-blocked');
  await b.page.reload({ waitUntil: 'domcontentloaded' }); await ready(b.page); await count(b.page, 1);
  await blocked(b, id, 'reload-blocked');
  await tap(a.page, '#btn-deselect'); await doubleTap(b, id); await selected(b.page, id);
  await snapshot('unlock-allows-selection', b); pass('unlock-allows-selection');
  await tap(b.page, '#btn-deselect'); await doubleTap(a, id); await selected(a.page, id);
  await b.context.close(); b = await open('後参加B'); await count(b.page, 1);
  assert.equal(b.frames.find(m => m.payload?.kind === 'scene-state').payload.selectionLocks[id], await connectedId(a.page));
  await blocked(b, id, 'late-join-blocked');
  const oldA = await connectedId(a.page); await a.context.close();
  await wait(b.page, old => !window.__sceneSyncDebug.presence().peers.some(peer => peer.id === old), oldA);
  await doubleTap(b, id); await selected(b.page, id); await snapshot('departure-allows-selection', b); pass('departure-allows-selection');

  const c = await open('復元中C', true); await waitHeld(c);
  await tap(b.page, '#btn-deselect'); c.release(); await ready(c.page); await count(c.page, 1);
  await doubleTap(c, id); await selected(c.page, id); await snapshot('unlock-during-recovery', c); pass('unlock-during-recovery');
  await c.context.close(); await doubleTap(b, id); await selected(b.page, id);
  const d = await open('復元中D', true); await waitHeld(d);
  const ownerB = await connectedId(b.page); await b.context.close();
  await wait(d.page, old => !window.__sceneSyncDebug.presence().peers.some(peer => peer.id === old), ownerB);
  d.release(); await ready(d.page); await count(d.page, 1);
  await doubleTap(d, id); await selected(d.page, id); await snapshot('departure-during-recovery', d); pass('departure-during-recovery');

  const e = await open('復元中E', true); await waitHeld(e);
  const staleEpoch = await clear(d.page); await ready(e.page); e.release(); await e.page.waitForTimeout(700);
  await count(d.page, 0); await count(e.page, 0); assert.deepEqual(await selection(e.page), []);
  await snapshot('clear-during-recovery', e); pass('clear-during-recovery');
  const epoch = await d.page.evaluate(() => window.__sceneSyncDebug.getRoomLifecycle().epoch);
  const response = await fetch(`${base}/presence/api/room/${room}/broadcast`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'scene-add', sceneEpoch: epoch, objectId: id, name: 'Fresh object with reused ID', asset: { type: 'primitive', shape: 'box', color: '#3388ee' }, position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }) });
  assert.equal(response.status, 200); await count(d.page, 1); await count(e.page, 1);
  const staleFrameStart = d.frames.length;
  await d.page.evaluate(async ({ id, epoch }) => { (await import('/assets/js/scenesync/scene.js')).presenceState.ws.send(JSON.stringify({ type: 'broadcast', payload: { kind: 'scene-lock', objectId: id, sceneEpoch: epoch } })); }, { id, epoch: staleEpoch });
  await d.page.waitForTimeout(250); assert.ok(d.frames.slice(staleFrameStart).some(m => m.error === 'scene_epoch_mismatch'));
  await doubleTap(e, id); await selected(e.page, id); await snapshot('stale-lock-cannot-return-after-clear', e); pass('stale-lock-cannot-return-after-clear');
  assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) {
  result.failure = error.stack; console.error(error); process.exitCode = 1;
} finally {
  await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2)); await browser.close();
}
