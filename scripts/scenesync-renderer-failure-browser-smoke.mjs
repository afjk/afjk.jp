// Loopback-only regression: real Three.js with WebGL contexts denied on selected
// peers. Never run this test against a deployed room.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { localChromiumOptions } from './lib/local-chromium.mjs';

const base = process.env.AFJK_WEB_ORIGIN || 'http://127.0.0.1:8888';
const presence = process.env.AFJK_PRESENCE_URL || 'ws://127.0.0.1:8787';
for (const url of [base, presence]) assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname));
const api = presence.replace(/^ws/, 'http');
const out = 'logs/renderer-failure';
await mkdir(out, { recursive: true });
const result = { ok: false, checks: [], errors: [], renderers: [], security: { chromiumSandbox: true } };
const browser = await chromium.launch(localChromiumOptions());
const room = `renderer-${Date.now().toString(36)}`;
const pass = name => { result.checks.push(name); console.log('PASS', name); };
const wait = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 45000 });
const ready = page => wait(page, () => window.__sceneSyncDebug?.getRoomLifecycle().ready);
const snapshot = page => page.evaluate(() => ({
  presence: window.__sceneSyncDebug.presence(),
  lifecycle: window.__sceneSyncDebug.getRoomLifecycle(),
  renderer: window.__sceneSyncDebug.renderer(),
  ids: window.__sceneSyncDebug.objects.list(),
}));
async function open(name, fail = false, webgpu = false, roomName = room, mobile = false) {
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
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => result.errors.push({ name, message: error.message }));
  await page.goto(`${base}/scenesync/?dev=1&shell=editor&room=${roomName}&presence=${encodeURIComponent(presence)}${webgpu ? '&webgpu=1' : ''}`);
  await ready(page);
  await wait(page, () => !!window.sceneSyncShell);
  result.renderers.push({ name, ...await snapshot(page) });
  assert.equal((await snapshot(page)).renderer.available, !fail);
  return { page, context };
}
async function post(page, payload, roomName = room) {
  const state = await snapshot(page);
  const response = await fetch(`${api}/api/room/${roomName}/broadcast`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, sceneEpoch: state.lifecycle.epoch }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function command(page, action, params = {}, roomName = room) {
  const state = await snapshot(page);
  const response = await post(page, { kind: 'ai-command', action, params, targetPeerId: state.presence.id }, roomName);
  return response.result;
}
const has = (page, id, exists = true) => wait(page, ({ id, exists }) => window.__sceneSyncDebug.objects.list().includes(id) === exists, { id, exists });
const selected = (page, id) => wait(page, id => window.__sceneSyncDebug.getSelection().selectedObjectIds.join() === id, id);
const primitive = id => ({ kind: 'scene-add', objectId: id, name: id, asset: { type: 'primitive', shape: 'box', color: '#26bfa6' }, position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
async function checkContents(page) {
  const box = await page.evaluate(() => window.__sceneSyncDebug.objects.get('existing-box'));
  assert.ok(box); assert.deepEqual(box.position, [0, 1, 0]);
  assert.equal(box.name, 'existing-box');
  assert.deepEqual(box.rotation, [0, 0, 0, 1]);
  assert.deepEqual(box.scale, [1, 1, 1]);
  assert.deepEqual(box.asset, { type: 'primitive', shape: 'box', color: '#26bfa6' });
}

try {
  const check = await browser.newPage(); await check.goto('chrome://sandbox');
  result.security.status = await check.locator('body').innerText();
  assert.match(result.security.status, /You are adequately sandboxed/); await check.close();
  const a = await open('visual-peer');
  await post(a.page, primitive('existing-box')); await has(a.page, 'existing-box');
  assert.equal((await command(a.page, 'screenshot', { mode: 'image', maxWidth: 320 })).ok, true);
  pass('healthy WebGL initialization and screenshot');

  const b = await open('state-peer-webgl', true);
  await has(b.page, 'existing-box'); await checkContents(b.page); await checkContents(a.page);
  assert.equal(await b.page.locator('#scene-rendering-unavailable').count(), 1);
  assert.equal(await b.page.locator('#xr-button-container button').count(), 0);
  assert.equal(await b.page.evaluate(() => window.__sceneSyncDebug.objects.screenPoint('existing-box')), null);
  await b.page.screenshot({ path: `${out}/degraded-editor.png` });
  assert.equal(await b.page.evaluate(() => document.dispatchEvent(new DragEvent('drop', { cancelable: true }))), false);
  pass('WebGL2 failure still joins and receives existing content with visible degraded feedback');

  const c = await open('state-peer-webgpu', true, true, room, true);
  await has(c.page, 'existing-box'); await checkContents(c.page);
  const screenshot = await command(c.page, 'screenshot', { mode: 'image' });
  assert.equal(screenshot.ok, false); assert.match(screenshot.error, /rendering is unavailable/);
  assert.equal(await c.page.evaluate(async () => {
    try { await window.__sceneSyncDebug.dragDropManager.handleFile(new File(['x'], 'x.glb')); return 'unexpected success'; }
    catch (error) { return error.message; }
  }).then(message => /3D描画/.test(message)), true);
  await c.page.setViewportSize({ width: 390, height: 800 });
  await c.page.screenshot({ path: `${out}/degraded-mobile.png` });
  pass('WebGPU unavailable plus null WebGL context degrades safely; screenshot/file placement reject and resize works');

  const userId = (await snapshot(b.page)).presence.userId;
  await post(b.page, { ...primitive('editable-box'), onBehalfOf: userId });
  for (const peer of [a, b, c]) await has(peer.page, 'editable-box');
  await b.page.keyboard.press('Control+z');
  for (const peer of [a, b, c]) await has(peer.page, 'editable-box', false);
  await b.page.keyboard.press('Control+Shift+z');
  for (const peer of [a, b, c]) await has(peer.page, 'editable-box');
  pass('state-only participant adds, undoes and redoes shared objects using normal keyboard commands');

  await post(b.page, { kind: 'scene-delta', objectId: 'editable-box', position: [2, 1, 0], onBehalfOf: userId });
  for (const peer of [a, b, c]) await wait(peer.page, () => {
    const debug = window.__sceneSyncDebug;
    return debug.objects.get('editable-box')?.position[0] === 2 && debug.getActiveTransformTweenCount() === 0;
  });
  pass('transform tweens reach their final shared state without a renderer');

  await command(b.page, 'selectObject', { objectId: 'editable-box' }); await selected(b.page, 'editable-box');
  await wait(a.page, () => document.querySelectorAll('#peers-list .peer-editing').length > 0);
  const lockedPoint = await a.page.evaluate(() => window.__sceneSyncDebug.objects.screenPoint('editable-box'));
  await a.page.mouse.click(lockedPoint.clientX, lockedPoint.clientY);
  await selected(a.page, '');
  await b.page.keyboard.press('Delete');
  for (const peer of [a, b, c]) await has(peer.page, 'editable-box', false);
  await b.page.keyboard.press('Control+z');
  for (const peer of [a, b, c]) await has(peer.page, 'editable-box');
  pass('selection locks and selection-by-id work; delete and undo synchronize from the state-only editor');

  const envId = await b.page.evaluate(() => {
    const select = document.getElementById('env-select');
    const next = [...select.options].find(option => option.value && option.value !== select.value).value;
    select.value = next; select.dispatchEvent(new Event('change')); return next;
  });
  for (const peer of [a, b, c]) await wait(peer.page, envId => document.getElementById('env-select').value === envId, envId);
  await b.page.keyboard.press('Control+z');
  for (const peer of [a, b, c]) await wait(peer.page, envId => document.getElementById('env-select').value !== envId, envId);
  pass('environment intent synchronizes and undoes without PMREM processing');

  // Exercise the existing state editor rather than introducing a new control API.
  await b.page.locator('#scene-inspector-toggle').click();
  await b.page.locator('#scene-inspector-edit').click();
  await b.page.locator('#scene-inspector-mode-json').click();
  const draft = JSON.parse(await b.page.locator('#scene-inspector-editor').inputValue());
  draft.objects['editable-box'].name = 'edited without rendering';
  await b.page.locator('#scene-inspector-editor').fill(JSON.stringify(draft));
  await b.page.locator('#scene-inspector-validate').click();
  await b.page.locator('#scene-inspector-apply').click();
  for (const peer of [a, b, c]) await wait(peer.page, () => window.__sceneSyncDebug.objects.get('editable-box')?.name === 'edited without rendering');
  await b.page.locator('#scene-inspector-close').click();
  pass('existing JSON scene editor broadcasts state edits without rendering');

  await b.page.evaluate(() => window.sceneSyncShell.switchTo('viewer'));
  const beforeViewer = (await snapshot(b.page)).ids.sort();
  await b.page.keyboard.press('Delete'); await b.page.keyboard.press('Control+z');
  assert.deepEqual((await snapshot(b.page)).ids.sort(), beforeViewer);
  await b.page.evaluate(() => window.sceneSyncShell.switchTo('editor'));
  pass('viewer shell retains its edit restrictions and editor can be remounted without a canvas');

  const oldId = (await snapshot(b.page)).presence.id;
  await b.page.evaluate(async () => { (await import('/assets/js/scenesync/scene.js')).presenceState.ws.close(1000, 'local renderer regression'); });
  await wait(b.page, oldId => window.__sceneSyncDebug?.getRoomLifecycle().ready && window.__sceneSyncDebug.presence().id !== oldId, oldId);
  await has(b.page, 'editable-box'); await checkContents(b.page);
  assert.equal(await b.page.locator('#scene-rendering-unavailable').count(), 1);
  pass('reconnect restores room state without duplicating renderer UI');

  await b.page.reload(); await ready(b.page); await has(b.page, 'editable-box'); await checkContents(b.page);
  assert.equal((await snapshot(b.page)).renderer.available, false);
  assert.equal(await b.page.locator('#scene-rendering-unavailable').count(), 1);
  pass('repeated page initialization stays connected and preserves contents');

  // A room with only state peers must also be able to provide authoritative state.
  await a.context.close(); await c.context.close();
  const d = await open('late-visual-peer');
  await has(d.page, 'existing-box'); await has(d.page, 'editable-box'); await checkContents(d.page);
  const point = await d.page.evaluate(() => window.__sceneSyncDebug.objects.screenPoint('existing-box'));
  assert.ok(point?.visible); await d.page.mouse.click(point.clientX, point.clientY);
  await selected(d.page, 'existing-box');
  await d.page.screenshot({ path: `${out}/healthy-editor.png` });
  pass('state-only peer serves existing room to late healthy peer and visual pointer selection still works');

  const soloRoom = `${room}-solo`;
  const solo = await open('solo-state-peer', true, false, soloRoom);
  await post(solo.page, primitive('solo-box'), soloRoom); await has(solo.page, 'solo-box');
  assert.equal((await command(solo.page, 'selectObject', { objectId: 'solo-box' }, soloRoom)).ok, true);
  pass('first participant recovers a fresh room even with no renderer');
  assert.deepEqual(result.errors, []);
  result.ok = true;
} finally {
  await browser.close();
  await writeFile(`${out}/browser-result.json`, JSON.stringify(result, null, 2));
}
