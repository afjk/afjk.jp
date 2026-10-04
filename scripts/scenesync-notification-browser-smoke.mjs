// Local real-browser coverage for notifications displayed together with controls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { localChromiumOptions } from './lib/local-chromium.mjs';
import { inspectNotificationGeometry } from './lib/notification-geometry.mjs';
const base = process.env.AFJK_WEB_ORIGIN || 'http://127.0.0.1:8888';
const presence = process.env.AFJK_PRESENCE_URL || 'ws://127.0.0.1:8787';
for (const url of [base, presence]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
const out = path.resolve(process.env.AFJK_NOTIFICATION_OUTPUT || 'logs/notification-browser-smoke');
await mkdir(out, { recursive: true });
const result = { ok: false, checks: [], cases: [], errors: [], security: { chromiumSandbox: true, ignoreHTTPSErrors: false } };
const browser = await chromium.launch(localChromiumOptions());
const run = Date.now().toString(36);
// A previously cached pre-region writer. Serving it for the unversioned URL
// recreates the deployment mix that puts the toast at document y=0.
const oldToast = `let timer; export function showToast(input,duration=2500) {
  const el=document.getElementById('toast'); if(!el)return;
  el.textContent=typeof input==='string'?input:input?.message||String(input);
  el.classList.add('show'); clearTimeout(timer);
  timer=setTimeout(()=>el.classList.remove('show'),duration);
}`;
let legacyLoads = 0;
result.notificationModuleRequests = [];
let page;
const record = label => { result.checks.push(label); console.log('PASS', label); };
async function show(message, duration = 60000) {
  await page.evaluate(async ({ message, duration }) => (await import('/assets/js/scenesync/ui/toast.js')).showToast(message, duration), { message, duration });
  await page.waitForTimeout(350);
}
async function verify(label, selector = '#toast') {
  const data = await page.evaluate(inspectNotificationGeometry, { selector, label });
  result.cases.push(data);
  assert.deepEqual(data.overlaps, [], `${label}: notification overlaps controls`);
  assert.deepEqual(data.headerOverlaps, [], `${label}: header surfaces overlap each other`);
  assert.deepEqual(data.blocked, [], `${label}: controls lost their pointer target`);
  assert.ok(data.visible, `${label}: notification must stay visible`);
  assert.ok(data.rect.left >= 0 && data.rect.right <= data.viewport.width + 1 && data.rect.top >= 0 && data.rect.bottom <= data.viewport.height + 1, `${label}: notice clipped`);
}
try {
  const sandboxPage = await browser.newPage();
  await sandboxPage.goto('chrome://sandbox');
  result.security.status = await sandboxPage.locator('body').innerText();
  assert.match(result.security.status, /You are adequately sandboxed/);
  result.security.browser = browser.version();
  await sandboxPage.close();
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 568 }, { width: 568, height: 320 }]) {
    if (process.env.AFJK_NOTIFICATION_WIDTH && viewport.width !== Number(process.env.AFJK_NOTIFICATION_WIDTH)) continue;
    const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' });
    await context.addInitScript(name => { localStorage.setItem('sceneSync.welcomeSeen', 'true'); localStorage.setItem('sceneSync.displayName', name); }, process.env.AFJK_NOTIFICATION_NAME || '長い名前の参加者から通知表示を確認しています');
    page = await context.newPage();
    await page.route('**/ui/toast.js', route => {
      legacyLoads++;
      return route.fulfill({ contentType: 'text/javascript', body: oldToast });
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (/\/(toast|scene-clear-ui|notification-layout)\.js$/.test(url.pathname)) result.notificationModuleRequests.push(url.pathname + url.search);
    });
    page.on('pageerror', error => result.errors.push(error.message));
    for (const shell of ['studio', 'editor', 'player']) {
      if (process.env.AFJK_NOTIFICATION_SHELL && shell !== process.env.AFJK_NOTIFICATION_SHELL) continue;
      const label = `${shell}-${viewport.width}x${viewport.height}`;
      await page.goto(`${base}/scenesync/?shell=${shell}&dev=1&room=nt-${run}-${viewport.width}-${shell}&presence=${encodeURIComponent(presence)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(shell => window.sceneSyncShell?.current() === shell && window.__sceneSyncDebug?.getRoomLifecycle().ready, shell, { timeout: 60000 });
      assert.equal(await page.evaluate(() => innerWidth), viewport.width, 'test must use the requested layout viewport');
      await show('オブジェクトをコピーしました'); await verify(`${label}-short`);
      // Exercise the actual websocket error -> application toast path, not
      // only a direct import of the notification implementation.
      await page.evaluate(async () => {
        const { presenceState } = await import('/assets/js/scenesync/scene.js');
        presenceState.ws.send(JSON.stringify({ type: 'broadcast', payload: {
          kind: 'scene-add', sceneEpoch: 'outdated-notification-regression', objectId: 'must-not-be-added'
        } }));
      });
      await page.waitForFunction(() => document.querySelector('#toast.show')?.textContent
        === 'シーンが更新されました。再接続またはクライアントの更新が必要です。');
      await page.waitForTimeout(200);
      await verify(`${label}-reported-message`);
      const inspected = result.cases.at(-1).surfaces.map(x => x.id);
      assert.ok(inspected.includes('#status'), 'non-button connection status must be inspected');
      if (shell === 'editor') assert.ok(inspected.includes('#nickname-chip'), 'name header must be inspected');
      await page.screenshot({ path: `${out}/${label}-reported-message.png` });
      if (viewport.width === 390 && shell === 'studio') await page.screenshot({ path: `${out}/reported-message-studio.png` });
      await show('配置位置を選んでください。\nクリックで配置、Escで終了します。\n長い通知でも操作ボタンを隠しません。');
      await verify(`${label}-multiline`);
      if (viewport.width === 390) await page.screenshot({ path: `${out}/${label}-toast.png` });
      if (shell === 'editor') {
        page.once('dialog', dialog => dialog.dismiss());
        await page.locator('#nickname-chip').tap();
        await page.locator('#status').tap();
        await page.locator('#peers-panel').waitFor({ state: 'visible' });
        await page.waitForTimeout(350);
        await verify(`${label}-peer-panel`);
        await page.screenshot({ path: `${out}/${label}-peer-panel.png` });
        await page.locator('#status').tap();
      }
      if (shell !== 'player') {
        const menu = shell === 'studio' ? '[data-studio-menu-btn]' : '#editor-scene-menu summary';
        await page.locator(menu).tap();
        await page.waitForTimeout(350);
        await verify(`${label}-open-menu`, '#toast');
        await page.screenshot({ path: `${out}/${label}-menu.png` });
        await page.locator(menu).tap();
        await page.waitForTimeout(350);
        await verify(`${label}-closed-menu`);
        if (shell === 'studio' && viewport.width === 568) {
          await page.locator(menu).tap();
          await page.locator('[data-studio-help]').tap();
          await page.locator('#welcome-dialog').waitFor({ state: 'visible' });
          await verify(`${label}-scrolled-menu-help`);
          await page.locator('#welcome-close').tap();
        }
        if (shell === 'studio' && viewport.width === 390) {
          await page.locator(menu).tap(); await page.locator('[data-studio-export]').tap();
          await show('シーンが更新されました。再接続またはクライアントの更新が必要です。');
          await verify('important notification stays visible with export dialog');
          await page.screenshot({ path: `${out}/studio-export-notification.png` });
          await page.locator('#export-dialog-close').tap();
          await verify('important notification after export closes');
          record('important notification remains visible while dialog is open');
        }
      } else {
        const play = page.locator('[data-player-play-pause]');
        const before = await play.getAttribute('data-player-playing');
        await play.tap();
        await page.waitForFunction(before => document.querySelector('[data-player-play-pause]').dataset.playerPlaying !== before, before);
      }
      if (shell === 'editor') {
        await page.locator('#editor-scene-menu summary').tap();
        await page.locator('#editor-scene-menu button[title="Player controls"]').tap();
        await page.locator('.scene-sync-editor-player-panel').waitFor({ state: 'visible' });
        await verify(`${label}-embedded-player`);
        if (viewport.width === 568) await page.screenshot({ path: `${out}/${label}-embedded-player.png` });
        await page.locator('.scene-sync-editor-player-panel [data-player-play-pause]').tap();
        await page.locator('.scene-sync-editor-player-panel [data-player-close]').tap();
      }
      await show('シーンが更新されました。再接続またはクライアントの更新が必要です。');
      if (shell !== 'player') await page.locator(shell === 'studio' ? '[data-studio-menu-btn]' : '#editor-scene-menu summary').tap();
      const beforeClear = await page.evaluate(() => window.__sceneSyncDebug.getRoomLifecycle().epoch);
      await page.evaluate(async () => (await import('/assets/js/scenesync/ui/dom.js')).getSceneSyncShellRuntime().core.commands.requestSceneClear());
      await page.locator('[data-scene-action="cancel-clear"]').waitFor({ state: 'visible' });
      await page.waitForTimeout(150);
      await verify(`${label}-clear-countdown`, '#scene-clear-notice');
      await verify(`${label}-important-during-countdown`);
      await page.screenshot({ path: `${out}/${label}-countdown.png` });
      if (shell === 'player') {
        const play = page.locator('[data-player-play-pause]');
        const before = await play.getAttribute('data-player-playing');
        await play.tap();
        await page.waitForFunction(before => document.querySelector('[data-player-play-pause]').dataset.playerPlaying !== before, before);
      }
      await page.locator('[data-scene-action="cancel-clear"]').tap();
      await page.locator('#scene-clear-notice').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.__sceneSyncDebug.getRoomLifecycle().epoch), beforeClear, 'Cancel must preserve the scene epoch');
      if (shell !== 'player') {
        const menu = shell === 'studio' ? '[data-studio-menu-btn]' : '#editor-scene-menu summary';
        if (await page.evaluate(shell => shell === 'studio'
          ? document.querySelector('[data-studio-menu]').dataset.open === 'true'
          : document.querySelector('#editor-scene-menu').open, shell)) await page.locator(menu).tap();
        await verify(`${label}-cancelled-menu-closed`);
      }
      if (shell !== 'player') {
        // A real selected object exercises the card's scrollable area too.
        await page.evaluate(() => document.querySelector('#toast').classList.remove('show'));
        const epoch = await page.evaluate(() => window.__sceneSyncDebug.getRoomLifecycle().epoch);
        const objectId = `notice-box-${viewport.width}`;
        const response = await fetch(presence.replace('ws:', 'http:') + `/api/room/nt-${run}-${viewport.width}-${shell}/broadcast`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'scene-add', sceneEpoch: epoch, objectId, name: objectId,
            asset: { type: 'primitive', shape: 'box', color: '#26bfa6' }, position: [0,1,0], rotation: [0,0,0,1], scale: [1,1,1] })
        });
        assert.equal(response.status, 200);
        await page.waitForFunction(id => window.__sceneSyncDebug.objects.list().includes(id), objectId);
        const point = await page.evaluate(id => window.__sceneSyncDebug.objects.screenPoint(id), objectId);
        // Select through the existing dev hook to isolate notification layout
        // from touchscreen gesture timing. Card buttons below are real taps.
        await page.evaluate(point => window.__sceneSyncDebug.selectAt(point.clientX, point.clientY), point);
        await page.waitForFunction(id => window.__sceneSyncDebug.getSelection().selectedObjectIds.includes(id), objectId);
        await show('シーンが更新されました。再接続またはクライアントの更新が必要です。');
        await verify(`${label}-selected-card`);
        await page.screenshot({ path: `${out}/${label}-selection.png` });
        await page.locator(shell === 'studio' ? '[data-studio-tool="rotate"]' : '#btn-rotate').tap();
        assert.equal(await page.evaluate(async () => (await import('/assets/js/scenesync/ui/dom.js')).getSceneSyncShellRuntime().core.getEditorState().transformMode), 'rotate');
        await page.locator(shell === 'studio' ? '[data-studio-deselect]' : '#btn-deselect').tap();
        await page.waitForFunction(() => window.__sceneSyncDebug.getSelection().selectedObjectIds.length === 0);
      }
      if (shell === 'studio' && viewport.width === 390) {
        await show('短い通知が消えたら元の配置へ戻ります', 700);
        await page.waitForFunction(() => document.querySelector('#scene-notifications').hidden
          && !document.body.classList.contains('scene-sync-notice-active'));
        record('notification timeout releases reserved space');
      }
      record(`${label}: short/multiline/menu notification bounds, pointer targets and real Cancel/controls`);
    }
    await context.close();
  }
  assert.equal(legacyLoads, 0, 'new HTML must not load the stale unversioned notification writer');
  for (const name of ['toast', 'scene-clear-ui', 'notification-layout']) {
    const requests = result.notificationModuleRequests.filter(url => url.includes(`/${name}.js`));
    assert.ok(requests.length > 0 && requests.every(url => url.endsWith('?v=notification-header-1')),
      `${name} must use the notification layout revision from the import map`);
  }
  result.legacyLoads = legacyLoads;
  assert.deepEqual(result.errors, []);
  result.ok = true;
} catch (error) {
  result.error = error.stack;
  await page?.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2));
  await browser.close();
}
