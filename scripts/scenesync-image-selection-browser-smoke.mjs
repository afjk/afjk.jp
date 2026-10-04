// Local regression for image selection in both editing shells. Keep sandbox/TLS enabled.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { localChromiumOptions } from './lib/local-chromium.mjs';
const base = process.env.AFJK_WEB_ORIGIN || 'http://127.0.0.1:8888';
const presence = process.env.AFJK_PRESENCE_URL || 'ws://127.0.0.1:8787';
for (const endpoint of [base, presence]) assert.ok(['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname));
const out = path.resolve(process.env.AFJK_IMAGE_SELECTION_OUTPUT || 'logs/image-selection-browser-smoke');
await mkdir(out, { recursive: true });
const result = { ok: false, checks: [], errors: [], security: { chromiumSandbox: true, ignoreHTTPSErrors: false } };
const browser = await chromium.launch(localChromiumOptions());
const run = Date.now().toString(36);
let page;
const pass = name => { result.checks.push(name); console.log('PASS', name); };
const wait = (p, fn, arg) => p.waitForFunction(fn, arg, { timeout: 20000 });
const objects = p => p.evaluate(() => window.__sceneSyncDebug.objects.list().filter(id => id !== 'sample-cube').map(id => window.__sceneSyncDebug.objects.get(id)));
const selection = p => p.evaluate(() => window.__sceneSyncDebug.getSelection().selectedObjectIds);
const selected = (p, id) => wait(p, id => window.__sceneSyncDebug.getSelection().selectedObjectIds.join() === id, id);
const count = (p, n) => wait(p, n => window.__sceneSyncDebug.objects.list().filter(id => id !== 'sample-cube').length === n, n);
const snap = (p, id) => p.evaluate(id => window.__sceneSyncDebug.objects.get(id), id);
async function tap(p, selector) { await p.locator(selector).tap(); await p.waitForTimeout(250); }
function selector(shell, action) {
  const editor = { add: '#add-btn', deselect: '#btn-deselect', rotate: '#btn-rotate', translate: '#btn-move', undo: '#btn-undo' };
  return shell === 'editor' ? editor[action] : ['rotate', 'translate'].includes(action) ? `[data-studio-tool="${action}"]` : `[data-studio-${action}]`;
}
async function open(shell, room, name = 'さ') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    ignoreHTTPSErrors: false, locale: 'ja-JP',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' });
  await context.addInitScript(name => { localStorage.setItem('sceneSync.welcomeSeen', 'true'); localStorage.setItem('sceneSync.displayName', name); }, name);
  const p = await context.newPage(); p.setDefaultTimeout(15000); page = p;
  p.on('pageerror', error => result.errors.push({ shell, room, message: error.message }));
  await p.goto(`${base}/scenesync/?shell=${shell}&dev=1&room=isel-${run}-${room}&presence=${encodeURIComponent(presence)}`, { waitUntil: 'domcontentloaded' });
  await wait(p, shell => window.sceneSyncShell?.current() === shell && window.__sceneSyncDebug?.getRoomLifecycle().ready, shell);
  return { page: p, context, cdp: await context.newCDPSession(p) };
}
async function doubleTap(client, id) {
  const point = id ? await client.page.evaluate(id => window.__sceneSyncDebug.objects.screenPoint(id), id) : { clientX: 350, clientY: 600 };
  assert.ok(point);
  await Promise.all(['touchStart', 'touchEnd', 'touchStart', 'touchEnd'].map(type => client.cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchStart' ? [{ x: point.clientX, y: point.clientY, id: 1 }] : [],
  })));
  await client.page.waitForTimeout(400);
}
async function add(p, shell, file) {
  await tap(p, selector(shell, 'add'));
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), tap(p, '#mobile-add-image-btn')]);
  await chooser.setFiles(file);
}
async function move(client) {
  await client.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 194, y: 325, id: 1 }] });
  for (let i = 1; i <= 8; i++) await client.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 194, y: 325 - i * 35 / 8, id: 1 }] });
  await client.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.page.waitForTimeout(300);
}
async function gate(p, method, fail = false) {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let used = false;
  const pattern = '**/presence/blob/**';
  const handler = async route => {
    if (!used && route.request().method() === method) {
      used = true; started(); await pending;
      if (fail) return route.fulfill({ status: 503, body: 'test image load failure' });
    }
    await route.continue();
  };
  await p.route(pattern, handler);
  return { async wait() { await Promise.race([entered, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} image request did not start`)), 15000); timer.unref();
  })]); }, release, async close() { release(); await p.unroute(pattern, handler); } };
}
try {
  const sandbox = await browser.newPage(); await sandbox.goto('chrome://sandbox');
  result.security.status = await sandbox.locator('body').innerText(); assert.match(result.security.status, /You are adequately sandboxed/); await sandbox.close();
  for (const shell of ['editor', 'studio']) {
    const a = await open(shell, `${shell}-normal`);
    const b = await open(shell, `${shell}-normal`, '確認B');
    const fixture = await a.page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 160; const g = c.getContext('2d');
      g.fillStyle = '#87ceeb'; g.fillRect(0, 0, 256, 160); g.fillStyle = '#ffd34d'; g.beginPath(); g.arc(200, 35, 20, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#2a8659'; g.beginPath(); g.moveTo(0, 160); g.lineTo(80, 40); g.lineTo(180, 160); g.fill(); return c.toDataURL().split(',')[1];
    });
    const file = path.join(out, 'landscape.png'); await writeFile(file, Buffer.from(fixture, 'base64'));
    await add(a.page, shell, file); await count(a.page, 1);
    const first = (await objects(a.page))[0]; await selected(a.page, first.objectId);
    assert.equal((await snap(a.page, first.objectId)).transformControlsAttached, true);
    assert.ok(await a.page.locator(shell === 'editor' ? '#mobile-toolbar' : '[data-studio-card]').isVisible());
    await a.page.screenshot({ path: `${out}/${shell}-added-selected.png` });
    pass(`${shell}: normal + image selects the loaded object and shows editing controls`);
    await count(b.page, 1); await b.page.waitForTimeout(500); assert.deepEqual(await selection(b.page), []);
    await doubleTap(b, first.objectId); assert.deepEqual(await selection(b.page), []);
    pass(`${shell}: remote arrival stays unselected; creator's lock blocks the second client`);
    await move(a); const moved = await snap(a.page, first.objectId);
    assert.notDeepEqual(moved.position, first.position);
    await wait(b.page, ({ id, position }) => window.__sceneSyncDebug.objects.get(id)?.position.every((v, i) => Math.abs(v - position[i]) < 1e-6), { id: first.objectId, position: moved.position });
    await tap(a.page, selector(shell, 'undo'));
    await wait(a.page, first => window.__sceneSyncDebug.objects.get(first.objectId).position.every((v, i) => Math.abs(v - first.position[i]) < 1e-6), first);
    await tap(a.page, selector(shell, 'rotate'));
    await a.page.screenshot({ path: `${out}/${shell}-rotate-selected.png` });
    await tap(a.page, selector(shell, 'translate'));
    pass(`${shell}: immediate touch move synchronizes; undo and rotate controls work`);
    const priorUrl = (await snap(a.page, first.objectId)).asset.url;
    // File drop is synthetic; selection, toolbar and + file-picker actions are real touch events.
    await a.page.evaluate(({ fixture, id }) => {
      const point = window.__sceneSyncDebug.objects.screenPoint(id); const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([Uint8Array.from(atob(fixture), c => c.charCodeAt(0))], 'replacement.png', { type: 'image/png' }));
      document.querySelector('canvas').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: point.clientX, clientY: point.clientY, dataTransfer }));
    }, { fixture, id: first.objectId });
    await wait(a.page, ({ id, url }) => window.__sceneSyncDebug.objects.get(id)?.asset.url !== url, { id: first.objectId, url: priorUrl });
    await count(a.page, 1); await selected(a.page, first.objectId);
    const replacedUrl = (await snap(a.page, first.objectId)).asset.url;
    await wait(b.page, ({ id, url }) => window.__sceneSyncDebug.objects.get(id)?.asset.url === url, { id: first.objectId, url: replacedUrl });
    pass(`${shell}: explicit replacement retains object identity/selection and synchronizes`);
    await add(a.page, shell, file);
    if (shell === 'editor') {
      await wait(a.page, ({ id, url }) => window.__sceneSyncDebug.objects.get(id)?.asset.url !== url, { id: first.objectId, url: replacedUrl });
      await count(a.page, 1); await selected(a.page, first.objectId);
    } else {
      await count(a.page, 2); const second = (await objects(a.page)).find(o => o.objectId !== first.objectId); await selected(a.page, second.objectId);
    }
    pass(`${shell}: existing + behavior preserved (${shell === 'editor' ? 'selected image replacement' : 'new image addition'})`);
    const beforeStamps = (await objects(a.page)).length;
    const beforeStampSelection = await selection(a.page);
    await a.page.keyboard.press('Control+c'); await a.page.keyboard.press('Control+v');
    await a.page.keyboard.press('Control+v'); await count(a.page, beforeStamps + 1);
    await a.page.keyboard.press('Control+v'); await count(a.page, beforeStamps + 2); await count(b.page, beforeStamps + 2);
    assert.deepEqual(await selection(a.page), beforeStampSelection); await a.page.keyboard.press('Escape');
    pass(`${shell}: repeated stamps preserve selection and synchronize`);
    await a.context.close(); await b.context.close();

    for (const action of ['select', 'deselect', 'play', 'shell', 'lock', 'failed-load']) {
      const client = await open(shell, `${shell}-${action}`); const p = client.page;
      if (action === 'deselect') { await doubleTap(client, 'sample-cube'); await selected(p, 'sample-cube'); }
      const peer = action === 'lock' ? await open(shell, `${shell}-${action}`, 'ロックB') : null;
      const pending = await gate(p, ['lock', 'failed-load'].includes(action) ? 'GET' : 'POST', action === 'failed-load');
      try {
        await add(p, shell, file); await pending.wait();
        if (action === 'select') { await doubleTap(client, 'sample-cube'); await selected(p, 'sample-cube'); }
        if (action === 'deselect') { await tap(p, selector(shell, 'deselect')); assert.deepEqual(await selection(p), []); }
        if (action === 'play') await tap(p, shell === 'studio' ? '[data-studio-mode="interact"]' : '#scene-sync-shell-mode-switcher button:has-text("Play")');
        if (action === 'shell') await p.evaluate(shell => window.sceneSyncShell.switchTo(shell), shell === 'editor' ? 'studio' : 'editor');
        if (action === 'lock') {
          await count(peer.page, 1); const id = (await objects(peer.page))[0].objectId;
          await doubleTap(peer, id); await selected(peer.page, id); await p.waitForTimeout(400);
        }
        pending.release(); await count(p, 1); await p.waitForTimeout(500);
        const loaded = (await objects(p))[0];
        assert.deepEqual(await selection(p), [], `${shell}: ${action} completion must not take selection`);
        assert.equal(loaded.transformControlsAttached, false);
        if (action === 'failed-load') assert.match(loaded.name, /load failed/);
        else assert.doesNotMatch(loaded.name, /load failed/, 'guard checks require a successfully loaded image');
        if (action === 'play') await p.screenshot({ path: `${out}/${shell}-pending-play.png` });
        pass(`${shell}: pending image respects ${action}`);
      } finally { await pending.close(); await client.context.close(); if (peer) await peer.context.close(); }
    }
  }
  assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) {
  result.failure = error.stack; console.error(error); process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
} finally { await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2)); await browser.close(); }
