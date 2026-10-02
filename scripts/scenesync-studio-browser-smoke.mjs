// Run against local Scene Sync/Presence endpoints. Uses isolated rooms/contexts.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const out = path.resolve(process.env.AFJK_STUDIO_OUTPUT || 'logs/studio-browser-smoke');
const base = process.env.AFJK_WEB_ORIGIN || 'http://127.0.0.1:8888';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'local development only');
const presence = process.env.AFJK_PRESENCE_URL || 'ws://127.0.0.1:8787';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(presence).hostname), 'local Presence only');
const url = `${base}/scenesync/?shell=studio&dev=1&room=studio-test-${Date.now().toString(36)}&presence=${encodeURIComponent(presence)}`;
const result = { url, ok: false, checks: [], errors: [], sent: [], received: [] };
await mkdir(out, { recursive: true });
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const proxy = proxyUrl ? new URL(proxyUrl) : null;
const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: true,
  ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
  ...(process.env.AFJK_CHROMIUM_PATH ? { executablePath: process.env.AFJK_CHROMIUM_PATH } : {}),
  ...(proxy ? { proxy: {
    server: proxy.origin,
    bypass: 'localhost,127.0.0.1,[::1]',
    ...(proxy.username ? {
      username: decodeURIComponent(proxy.username),
      password: decodeURIComponent(proxy.password),
    } : {}),
  } } : {}),
});
const pass = (name, detail = {}) => { result.checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
async function open(name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true, ignoreHTTPSErrors: false, locale: 'ja-JP',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await context.addInitScript(name => {
    localStorage.setItem('sceneSync.welcomeSeen', 'true');
    localStorage.setItem('sceneSync.displayName', name);
  }, name);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => result.errors.push({ name, error: e.message }));
  page.on('websocket', ws => {
    for (const [event, list] of [['framesent', result.sent], ['framereceived', result.received]]) {
      ws.on(event, ({ payload }) => { try {
        const m = JSON.parse(payload).payload;
        if (m?.kind) list.push({ client: name, ...m });
      } catch {} });
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.__sceneSyncDebug?.presence?.().connected, null, { timeout: 45000 });
  return { page, cdp: await context.newCDPSession(page) };
}
const objects = page => page.evaluate(() => window.__sceneSyncDebug.objects.list()
  .filter(id => id !== 'sample-cube').map(id => window.__sceneSyncDebug.objects.get(id)));
const selection = page => page.evaluate(() => window.__sceneSyncDebug.getSelection().selectedObjectIds);
async function wait(page, fn, arg) { await page.waitForFunction(fn, arg, { timeout: 20000 }); }
async function count(page, n) {
  await wait(page, n => window.__sceneSyncDebug.objects.list().filter(id => id !== 'sample-cube').length === n, n);
}
async function selected(page, id) {
  await wait(page, id => window.__sceneSyncDebug.getSelection().selectedObjectIds.join() === id, id);
}
async function equalScale(page, id, scale) {
  await wait(page, ({ id, scale }) => window.__sceneSyncDebug.objects.get(id)?.scale.every((x,i) => Math.abs(x - scale[i]) < 1e-6), { id, scale });
}
async function tapButton(page, selector) { await page.locator(selector).tap(); await delay(200); }
async function addImage(page, file) {
  await tapButton(page, '[data-studio-add]');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), tapButton(page, '#mobile-add-image-btn')]);
  await chooser.setFiles(file);
}
async function doubleTap(client, id) {
  const p = await client.page.evaluate(id => window.__sceneSyncDebug.objects.screenPoint(id), id);
  const requests = [];
  for (const type of ['touchStart', 'touchEnd', 'touchStart', 'touchEnd']) {
    requests.push(client.cdp.send('Input.dispatchTouchEvent', { type,
      touchPoints: type === 'touchStart' ? [{ x: p.clientX, y: p.clientY, id: 1 }] : [] }));
  }
  // Queue in order: software-rendering round trips can exceed the double-tap window.
  await Promise.all(requests); await delay(300);
}
async function swipe(client, from, to) {
  await client.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1], id: 1 }] });
  for (let i = 1; i <= 8; i++) {
    await client.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from[0] + (to[0]-from[0])*i/8, y: from[1] + (to[1]-from[1])*i/8, id: 1 }] });
    await delay(35);
  }
  await client.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await delay(300);
}
async function inspectorEdit(page, id, changes) {
  await tapButton(page, '[data-studio-menu-btn]');
  await tapButton(page, '[data-studio-menu] [data-studio-details]');
  await page.locator('#scene-inspector-edit').click();
  await page.locator('#scene-inspector-mode-json').click();
  const editor = page.locator('#scene-inspector-editor');
  const document = JSON.parse(await editor.inputValue());
  Object.assign(document.objects[id], changes);
  await editor.fill(JSON.stringify(document, null, 2));
  await page.locator('#scene-inspector-validate').click();
  await page.locator('#scene-inspector-apply').click();
  await page.locator('#scene-inspector-close').click();
  await page.keyboard.press('Escape');
}
try {
  const a = await open('Studio A');
  const b = await open('Studio B');
  const fixture = await a.page.evaluate(() => {
    const c = document.createElement('canvas'); c.width=256; c.height=160;
    const g=c.getContext('2d'); g.fillStyle='#87ceeb';g.fillRect(0,0,256,160);
    g.fillStyle='#ffd34d';g.beginPath();g.arc(200,35,20,0,Math.PI*2);g.fill();
    g.fillStyle='#2a8659';g.beginPath();g.moveTo(0,160);g.lineTo(80,40);g.lineTo(180,160);g.fill();
    return c.toDataURL().split(',')[1];
  });
  const file = path.join(out, 'landscape.png'); await writeFile(file, Buffer.from(fixture, 'base64'));
  await addImage(a.page, file); await count(a.page, 1);
  const first = (await objects(a.page))[0]; await selected(a.page, first.objectId);
  assert.equal(await a.page.locator('[data-studio-card]').getAttribute('data-show'), 'true');
  await a.page.screenshot({ path: path.join(out, 'studio-add-selected.png') });
  pass('new image automatically selected after loading');

  await count(b.page, 1);
  for (let i = 0; i < 100 && !result.received.some(m => m.client === 'Studio B' && m.kind === 'scene-lock' && m.objectId === first.objectId); i++) await delay(50);
  assert.ok(result.received.some(m => m.client === 'Studio B' && m.kind === 'scene-lock' && m.objectId === first.objectId));
  assert.deepEqual(await selection(b.page), []);
  await doubleTap(b, first.objectId); assert.deepEqual(await selection(b.page), []);
  pass('remote addition does not select; creator lock prevents second-client selection');

  await addImage(a.page, file); await count(a.page, 2); await count(b.page, 2);
  const second = (await objects(a.page)).find(o => o.objectId !== first.objectId);
  await selected(a.page, second.objectId);
  assert.equal((await objects(a.page)).find(o => o.objectId === first.objectId).asset.url, first.asset.url);
  assert.deepEqual(await selection(b.page), []);
  pass('second + image is new, not replacement; remote selection unaffected');
  await tapButton(a.page, '[data-studio-undo]'); await count(a.page, 1); await count(b.page, 1);
  await tapButton(a.page, '[data-studio-redo]'); await count(a.page, 2); await count(b.page, 2);
  pass('new addition undo/redo synchronizes to second client');

  // Use the first image's original placement for the previously failing gesture.
  await doubleTap(a, second.objectId); await selected(a.page, second.objectId);
  await tapButton(a.page, '[data-studio-tool="translate"]');
  await swipe(a, [194,325], [194,290]);
  await tapButton(a.page, '[data-studio-tool="rotate"]'); await swipe(a, [260,368], [295,335]);
  await tapButton(a.page, '[data-studio-tool="scale"]'); await swipe(a, [194,350], [216,368]);
  const scaled = (await objects(a.page)).find(o => o.objectId === second.objectId).scale;
  assert.ok(scaled.every(x => x > 0 && x < 1)); await equalScale(b.page, second.objectId, scaled);
  await tapButton(a.page, '[data-studio-undo]'); await equalScale(a.page, second.objectId, [1,1,1]); await equalScale(b.page, second.objectId, [1,1,1]);
  await tapButton(a.page, '[data-studio-redo]'); await equalScale(a.page, second.objectId, scaled); await equalScale(b.page, second.objectId, scaled);
  await tapButton(a.page, '[data-studio-undo]'); await equalScale(a.page, second.objectId, [1,1,1]);
  pass('touch scale never crosses zero; scale undo/redo synchronize', { scale: scaled });

  await tapButton(a.page, '[data-studio-deselect]');
  await delay(500); await doubleTap(b, second.objectId); await selected(b.page, second.objectId);
  await inspectorEdit(b.page, second.objectId, { name: 'Edited by B', scale: [-1,1,1] });
  await equalScale(b.page, second.objectId, [-1,1,1]); await equalScale(a.page, second.objectId, [-1,1,1]);
  pass('lock release permits second-client edit; explicit negative scale and remote mirror preserved');

  await doubleTap(a, first.objectId); await selected(a.page, first.objectId);
  const priorUrl = (await objects(a.page)).find(o => o.objectId === first.objectId).asset.url;
  // A synthetic file-drop event exercises the normal drop/replacement handlers;
  // the editor interactions above use real Playwright/CDP mouse/touch events.
  await a.page.evaluate(({ fixture, id }) => {
    const point = window.__sceneSyncDebug.objects.screenPoint(id);
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([Uint8Array.from(atob(fixture), c => c.charCodeAt(0))], 'replacement.png', { type:'image/png' }));
    document.querySelector('canvas').dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true,
      clientX:point.clientX, clientY:point.clientY, dataTransfer }));
  }, { fixture, id:first.objectId });
  await wait(a.page, ({id, priorUrl}) => window.__sceneSyncDebug.objects.get(id)?.asset.url !== priorUrl, {id:first.objectId, priorUrl});
  assert.equal((await objects(a.page)).length, 2); await selected(a.page, first.objectId);
  const replacedUrl = (await objects(a.page)).find(o => o.objectId === first.objectId).asset.url;
  await wait(b.page, ({id,url}) => window.__sceneSyncDebug.objects.get(id)?.asset.url === url, {id:first.objectId,url:replacedUrl});
  pass('explicit image drop replaces the same object and synchronizes');

  const stampSelection = await selection(a.page);
  await a.page.keyboard.press('Control+c'); await a.page.keyboard.press('Control+v');
  await a.page.keyboard.press('Control+v'); await count(a.page, 3);
  await a.page.keyboard.press('Control+v'); await count(a.page, 4); await count(b.page, 4);
  assert.deepEqual(await selection(a.page), stampSelection);
  await a.page.keyboard.press('Escape');
  pass('two consecutive stamps keep selection and synchronize without auto-selecting copies');

  await doubleTap(a, first.objectId);
  // Ensure the pending import cannot take selection back after a user deselects.
  let releaseImage, imageStarted;
  const gate = new Promise(resolve => { releaseImage = resolve; });
  const started = new Promise(resolve => { imageStarted = resolve; });
  await a.page.route('**/presence/blob/*.png', async route => {
    if (route.request().method() === 'GET') { imageStarted(); await gate; }
    await route.continue();
  });
  await addImage(a.page, file);
  await Promise.race([started, delay(15000).then(() => { throw new Error('image load did not start'); })]);
  await tapButton(a.page, '[data-studio-deselect]');
  releaseImage(); await count(a.page, 5); await count(b.page, 5); await delay(300);
  assert.deepEqual(await selection(a.page), []);
  await a.page.unroute('**/presence/blob/*.png');
  pass('delayed image completion respects a newer deselection');

  for (const [width,height] of [[390,844],[320,568],[844,390],[568,320]]) {
    await a.page.setViewportSize({ width, height }); await delay(300);
    const rects = await a.page.evaluate(() => {
      const rect = s => document.querySelector(s).getBoundingClientRect().toJSON();
      return { mode: rect('.studio-mode-pill'), status: rect('#status'), card: rect('[data-studio-card]'),
        buttons: [...document.querySelectorAll('[data-studio-card] button')].map(el => el.getBoundingClientRect().toJSON()) };
    });
    const xOverlap = Math.min(rects.mode.right,rects.status.right)-Math.max(rects.mode.left,rects.status.left);
    const yOverlap = Math.min(rects.mode.bottom,rects.status.bottom)-Math.max(rects.mode.top,rects.status.top);
    assert.ok(xOverlap <= 0 || yOverlap <= 0, 'mode/status must not overlap');
    assert.ok(rects.card.left >= 0 && rects.card.right <= width, `card stays within viewport: ${JSON.stringify(rects)}`);
    assert.equal(await a.page.evaluate(() => window.innerWidth), width, 'canvas must not hold the previous mobile viewport width');
    for (const button of rects.buttons) assert.ok(button.left >= 0 && button.right <= width, 'selection actions stay within viewport');
    await a.page.screenshot({ path: path.join(out, `studio-${width}x${height}.png`) });
    pass(`layout ${width}x${height}`, { rects });
  }
  await a.page.setViewportSize({ width:390, height:844 });
  assert.deepEqual(result.errors, []);
  result.ok = true;
} catch (error) {
  result.failure = error.stack; console.error(error); process.exitCode = 1;
} finally {
  await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  await browser.close();
}
