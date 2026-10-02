// Play/Edit gizmo and peer-lock regression. Local endpoints, isolated rooms/contexts.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const out = path.resolve(process.env.AFJK_GIZMO_OUTPUT || 'logs/play-gizmo-browser-smoke');
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
const snapshot = async (page, id) => page.evaluate(id => window.__sceneSyncDebug.objects.get(id), id);
const transform = o => ({ position:o.position, rotation:o.rotation, scale:o.scale });
async function shell(page,id) { await page.evaluate(id => window.sceneSyncShell.switchTo(id,{updateUrl:true}),id); }
async function mode(page, value, studio=true) {
  const selector = studio ? `[data-studio-mode="${value}"]`
    : `#scene-sync-shell-mode-switcher button:has-text("${value==='edit'?'Edit':'Play'}")`;
  await tapButton(page, selector);
  // Player is lazy-loaded; wait for shell mounting, not a fixed frame delay.
  if (!studio) await wait(page, selector => {
    const button=document.querySelectorAll('#scene-sync-shell-mode-switcher button');
    const target=[...button].find(el=>el.textContent===selector);
    return target?.getAttribute('aria-pressed')==='true' && !target.disabled;
  }, value==='edit'?'Edit':'Play');
}
async function wireSince(start, kind, id, client='Gizmo A') {
  for(let i=0;i<50;i++) {
    if(result.sent.slice(start).some(m=>m.client===client && m.kind===kind && m.objectId===id))return;
    await delay(100);
  }
  assert.fail(`missing ${client} ${kind} ${id}`);
}
async function playState(page,id) {
  assert.deepEqual(await selection(page),[]);
  assert.equal((await snapshot(page,id)).transformControlsAttached,false);
}
try {
  const a = await open('Gizmo A');
  const b = await open('Gizmo B');
  const fixture=await a.page.evaluate(()=>{
    const c=document.createElement('canvas');c.width=256;c.height=160;
    const g=c.getContext('2d');g.fillStyle='#87ceeb';g.fillRect(0,0,256,160);
    g.fillStyle='#ffd34d';g.beginPath();g.arc(200,35,20,0,Math.PI*2);g.fill();
    g.fillStyle='#2a8659';g.beginPath();g.moveTo(0,160);g.lineTo(80,40);g.lineTo(180,160);g.fill();
    g.fillStyle='#54b977';g.beginPath();g.moveTo(95,160);g.lineTo(180,75);g.lineTo(256,160);g.fill();
    return c.toDataURL().split(',')[1];
  });
  const file=path.join(out,'landscape.png');await writeFile(file,Buffer.from(fixture,'base64'));
  await addImage(a.page,file);await count(a.page,1);await count(b.page,1);
  const id=(await objects(a.page))[0].objectId;await selected(a.page,id);
  for(const studio of [true,false]) {
    for(const tool of ['translate','rotate','scale']) {
      await shell(a.page,'studio');
      await tapButton(a.page,`[data-studio-tool="${tool}"]`);
      if(!studio)await shell(a.page,'editor');
      const start=result.sent.length;
      await mode(a.page,'interact',studio);await playState(a.page,id);
      await wireSince(start,'scene-unlock',id);
      assert.equal(result.sent.slice(start).filter(m=>m.client==='Gizmo A'&&m.kind==='scene-lock').length,0);
      if(studio)assert.equal(await a.page.locator('[data-studio-card]').getAttribute('data-show'),'false');
      if(tool==='scale')await a.page.screenshot({path:path.join(out,studio?'studio-play-after.png':'player-after.png')});
      const restoreStart=result.sent.length;
      await mode(a.page,'edit',studio);await selected(a.page,id);
      assert.equal((await snapshot(a.page,id)).transformControlsAttached,true);
      await wireSince(restoreStart,'scene-lock',id);
      pass(`${studio?'Studio':'Editor/Player'} ${tool}: Play detaches/unlocks; Edit restores`);
    }
  }
  await shell(a.page,'studio');
  await a.page.screenshot({path:path.join(out,'edit-restored.png')});
  // Verify real editing after restoration, then the same gesture in Play.
  await tapButton(a.page,'[data-studio-tool="translate"]');
  const original=transform(await snapshot(a.page,id));
  await swipe(a,[194,325],[194,290]);
  const moved=transform(await snapshot(a.page,id));assert.notDeepEqual(moved.position,original.position);
  await tapButton(a.page,'[data-studio-undo]');
  await wait(a.page,({id,position})=>window.__sceneSyncDebug.objects.get(id).position.every((v,i)=>Math.abs(v-position[i])<1e-6),{id,position:original.position});
  pass('restored Edit gizmo accepts touch move and undo');
  for(const tool of ['translate','rotate','scale']) {
    await tapButton(a.page,`[data-studio-tool="${tool}"]`);
    await mode(a.page,'interact');const before=transform(await snapshot(a.page,id));const start=result.sent.length;
    await swipe(a,[194,325],[194,290]);await doubleTap(a,id);
    assert.deepEqual(transform(await snapshot(a.page,id)),before);await playState(a.page,id);
    assert.equal(result.sent.slice(start).filter(m=>m.client==='Gizmo A'&&['scene-lock','scene-delta'].includes(m.kind)).length,0);
    await mode(a.page,'edit');await selected(a.page,id);
    pass(`Studio ${tool}: Play touch cannot transform or select`);
  }
  // A releases its edit lock in Play. B can select it; A must not steal it back.
  await mode(a.page,'interact');await delay(300);
  await doubleTap(b,id);await selected(b.page,id);await delay(300);
  const lockedStart=result.sent.length;await mode(a.page,'edit');
  assert.deepEqual(await selection(a.page),[]);
  assert.equal(result.sent.slice(lockedStart).filter(m=>m.client==='Gizmo A'&&m.kind==='scene-lock').length,0);
  pass('second client selects during Play; Edit return respects its lock');
  await tapButton(b.page,'[data-studio-deselect]');await delay(300);
  await doubleTap(a,id);await selected(a.page,id);await mode(a.page,'interact');await delay(300);
  await doubleTap(b,id);await selected(b.page,id);
  await tapButton(b.page,'[data-studio-delete]');await count(a.page,0);await count(b.page,0);
  await mode(a.page,'edit');assert.deepEqual(await selection(a.page),[]);
  pass('remote deletion during Play is not resurrected on Edit return');
  for(const studio of [true,false]) {
    await shell(a.page,studio?'studio':'editor');
    const start=result.sent.length;
    for(let i=0;i<3;i++){await mode(a.page,'interact',studio);assert.deepEqual(await selection(a.page),[]);await mode(a.page,'edit',studio);}
    assert.equal(result.sent.slice(start).filter(m=>m.client==='Gizmo A'&&['scene-lock','scene-unlock'].includes(m.kind)).length,0);
    pass(`${studio?'Studio':'Editor/Player'} unselected repeated Play/Edit adds no locks`);
  }
  assert.deepEqual(result.errors,[]);result.ok=true;
} catch(error) {result.error=error.stack;process.exitCode=1;console.error(error);}
finally {await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));await browser.close();}
