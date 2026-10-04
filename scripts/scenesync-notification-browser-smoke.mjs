// Local real-browser coverage for notifications displayed together with controls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { localChromiumOptions } from './lib/local-chromium.mjs';
const base = process.env.AFJK_WEB_ORIGIN || 'http://127.0.0.1:8888';
const presence = process.env.AFJK_PRESENCE_URL || 'ws://127.0.0.1:8787';
for (const url of [base, presence]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
const out = path.resolve(process.env.AFJK_NOTIFICATION_OUTPUT || 'logs/notification-browser-smoke');
await mkdir(out, { recursive: true });
const result = { ok: false, checks: [], cases: [], errors: [], security: { chromiumSandbox: true, ignoreHTTPSErrors: false } };
const browser = await chromium.launch(localChromiumOptions());
const run = Date.now().toString(36);
let page;
const record = label => { result.checks.push(label); console.log('PASS', label); };
async function show(message, duration = 60000) {
  await page.evaluate(async ({ message, duration }) => (await import('/assets/js/scenesync/ui/toast.js')).showToast(message, duration), { message, duration });
  await page.waitForTimeout(350);
}
async function rememberControls() {
  await page.evaluate(() => {
    window.notificationControls = [...document.querySelectorAll('button,summary,select,input[type="range"]')].filter(el => {
      const r = el.getBoundingClientRect();
      return !el.closest('#scene-clear-notice') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        && r.width && r.height && r.top >= 0 && r.bottom <= innerHeight
        && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });
  });
}
async function verify(label, selector = '#toast') {
  const data = await page.evaluate(({ selector, label }) => {
    const el = document.querySelector(selector), r = el.getBoundingClientRect();
    const controls = window.notificationControls.filter(el => el.isConnected);
    const overlaps = [], blocked = [], coveredByMenu = [];
    for (const button of controls) {
      if (!button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const b = button.getBoundingClientRect().toJSON();
      // Menus/panels may become scrollable when messages reserve space. Only
      // their visible area is a pointer target; real taps below also test reach.
      for (let parent = button.parentElement; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent), clip = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
          b.top = Math.max(b.top, clip.top); b.bottom = Math.min(b.bottom, clip.bottom);
        }
        if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
          b.left = Math.max(b.left, clip.left); b.right = Math.min(b.right, clip.right);
        }
      }
      if (b.right - b.left < 10 || b.bottom - b.top < 10) continue;
      if (r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) overlaps.push(button.id || button.textContent || button.title);
      const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
      if (!button.contains(hit)) {
        // An open menu intentionally covers background controls. Record that
        // separately; it must never be the notification stealing the pointer.
        (hit?.closest('.editor-scene-menu-panel, .studio-menu') ? coveredByMenu : blocked)
          .push(button.id || button.textContent || button.title);
      }
    }
    const visible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    return { label, visible, rect: r.toJSON(), overlaps, blocked, coveredByMenu, viewport: { width: innerWidth, height: innerHeight } };
  }, { selector, label });
  result.cases.push(data);
  assert.deepEqual(data.overlaps, [], `${label}: notification overlaps controls`);
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
    await context.addInitScript(() => { localStorage.setItem('sceneSync.welcomeSeen', 'true'); localStorage.setItem('sceneSync.displayName', '長い名前の参加者から通知表示を確認しています'); });
    page = await context.newPage();
    page.on('pageerror', error => result.errors.push(error.message));
    for (const shell of ['studio', 'editor', 'player']) {
      if (process.env.AFJK_NOTIFICATION_SHELL && shell !== process.env.AFJK_NOTIFICATION_SHELL) continue;
      const label = `${shell}-${viewport.width}x${viewport.height}`;
      await page.goto(`${base}/scenesync/?shell=${shell}&dev=1&room=nt-${run}-${viewport.width}-${shell}&presence=${encodeURIComponent(presence)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(shell => window.sceneSyncShell?.current() === shell && window.__sceneSyncDebug?.getRoomLifecycle().ready, shell, { timeout: 60000 });
      assert.equal(await page.evaluate(() => innerWidth), viewport.width, 'test must use the requested layout viewport');
      await rememberControls();
      await show('オブジェクトをコピーしました'); await verify(`${label}-short`);
      await show('シーンが更新されました。再接続またはクライアントの更新が必要です。');
      await verify(`${label}-reported-message`);
      if (viewport.width === 390 && shell === 'studio') await page.screenshot({ path: `${out}/reported-message-studio.png` });
      await show('配置位置を選んでください。\nクリックで配置、Escで終了します。\n長い通知でも操作ボタンを隠しません。');
      await verify(`${label}-multiline`);
      if (viewport.width === 390) await page.screenshot({ path: `${out}/${label}-toast.png` });
      if (shell !== 'player') {
        const menu = shell === 'studio' ? '[data-studio-menu-btn]' : '#editor-scene-menu summary';
        await page.locator(menu).tap();
        await rememberControls(); await page.waitForTimeout(350);
        await verify(`${label}-open-menu`, '#toast');
        if (viewport.width === 568) await page.screenshot({ path: `${out}/${label}-menu.png` });
        await page.locator(menu).tap();
        await rememberControls(); await page.waitForTimeout(350);
        await verify(`${label}-closed-menu`);
        if (shell === 'studio' && viewport.width === 568) {
          await page.locator(menu).tap();
          await page.locator('[data-studio-help]').tap();
          await page.locator('#welcome-dialog').waitFor({ state: 'visible' });
          await rememberControls(); await verify(`${label}-scrolled-menu-help`);
          await page.locator('#welcome-close').tap();
        }
        if (shell === 'studio' && viewport.width === 390) {
          await page.locator(menu).tap(); await page.locator('[data-studio-export]').tap();
          await rememberControls();
          await show('シーンが更新されました。再接続またはクライアントの更新が必要です。');
          await verify('important notification stays visible with export dialog');
          await page.screenshot({ path: `${out}/studio-export-notification.png` });
          await page.locator('#export-dialog-close').tap();
          await rememberControls(); await verify('important notification after export closes');
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
        await rememberControls(); await verify(`${label}-embedded-player`);
        if (viewport.width === 568) await page.screenshot({ path: `${out}/${label}-embedded-player.png` });
        await page.locator('.scene-sync-editor-player-panel [data-player-play-pause]').tap();
        await page.locator('.scene-sync-editor-player-panel [data-player-close]').tap();
      }
      await show('シーンが更新されました。再接続またはクライアントの更新が必要です。');
      if (shell !== 'player') await page.locator(shell === 'studio' ? '[data-studio-menu-btn]' : '#editor-scene-menu summary').tap();
      await rememberControls();
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
        await rememberControls(); await verify(`${label}-cancelled-menu-closed`);
      }
      if (shell === 'studio') {
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
        await rememberControls();
        await show('シーンが更新されました。再接続またはクライアントの更新が必要です。');
        await verify(`${label}-selected-card`);
        await page.screenshot({ path: `${out}/${label}-selection.png` });
        await page.locator('[data-studio-tool="rotate"]').tap();
        assert.equal(await page.evaluate(async () => (await import('/assets/js/scenesync/ui/dom.js')).getSceneSyncShellRuntime().core.getEditorState().transformMode), 'rotate');
        await page.locator('[data-studio-deselect]').tap();
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
