// Local-only menu regression. AI is replaced by a counter; no pairing is sent.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { localChromiumOptions } from './lib/local-chromium.mjs';

const base = process.env.AFJK_WEB_ORIGIN || 'http://127.0.0.1:8888';
const presence = process.env.AFJK_PRESENCE_URL || 'ws://127.0.0.1:8787';
for (const url of [base, presence]) assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname));
const out = path.resolve(process.env.AFJK_MENU_OUTPUT || 'logs/menu-browser-smoke');
await mkdir(out, { recursive: true });
const result = { ok: false, checks: [], menus: {}, errors: [] };
const browser = await chromium.launch(localChromiumOptions());
let page;
const check = name => { result.checks.push(name); console.log(`PASS ${name}`); };
try {
  for (const mobile of [true, false]) {
    const surface = mobile ? 'mobile' : 'desktop';
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      isMobile: mobile, hasTouch: mobile,
      permissions: ['clipboard-read', 'clipboard-write'],
      ...(mobile ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' } : {}),
    });
    await context.addInitScript(() => {
      localStorage.setItem('sceneSync.welcomeSeen', 'true');
      localStorage.setItem('sceneSync.displayName', 'Menu check');
    });
    page = await context.newPage();
    page.on('pageerror', error => result.errors.push(error.message));
    await page.goto(`${base}/scenesync/?shell=studio&room=mn-${mobile ? 'm' : 'd'}-${Date.now().toString(36)}&presence=${encodeURIComponent(presence)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.sceneSyncShell?.current() === 'studio' && window.__sceneSyncDebug?.getRoomLifecycle().ready, null, { timeout: 60000 });
    await page.evaluate(async () => {
      const { getSceneSyncShellRuntime } = await import('/assets/js/scenesync/ui/dom.js');
      const commands = getSceneSyncShellRuntime().core.commands;
      window.menuCalls = {};
      window.menuClipboardRead = navigator.clipboard.read.bind(navigator.clipboard);
      window.menuClipboardReadText = navigator.clipboard.readText.bind(navigator.clipboard);
      for (const name of ['openRoomSettings', 'exportScene', 'openHelp', 'startAiLink']) {
        const original = commands[name];
        commands[name] = (...args) => {
          window.menuCalls[name] = (window.menuCalls[name] || 0) + 1;
          if (name !== 'startAiLink') return original(...args);
        };
      }
    });
    const click = selector => mobile ? page.locator(selector).tap() : page.locator(selector).click();
    for (const shell of ['studio', 'editor']) {
      await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, 'read', { configurable: true, value: window.menuClipboardRead });
        Object.defineProperty(navigator.clipboard, 'readText', { configurable: true, value: window.menuClipboardReadText });
      });
      await page.evaluate(shell => window.sceneSyncShell.switchTo(shell), shell);
      const studio = shell === 'studio';
      const menu = studio ? '[data-studio-menu]' : '#editor-scene-menu .editor-scene-menu-panel';
      const toggle = studio ? '[data-studio-menu-btn]' : '#editor-scene-menu summary';
      const add = studio ? '[data-studio-add]' : '#add-btn';
      const action = key => studio ? `[data-studio-${key}]` : ({ room: '#editor-room-open-btn', export: '#export-btn', ai: '#link-btn', help: '#help-btn' })[key];
      await click(toggle);
      result.menus[`${surface}-${shell}`] = await page.locator(`${menu} button:visible`).allTextContents();
      assert.equal(result.menus[`${surface}-${shell}`][0].trim(), 'ルーム設定');
      await page.screenshot({ path: `${out}/${surface}-${shell}-more.png` });
      await click(toggle);
      assert.equal(await page.locator(menu).isVisible(), false);
      await click(toggle); await click(toggle);
      assert.equal(await page.locator(menu).isVisible(), false);
      await click(toggle);
      if (mobile) await page.touchscreen.tap(300, 180); else await page.mouse.click(700, 180);
      assert.equal(await page.locator(menu).isVisible(), false);
      await click(toggle); await page.keyboard.press('Escape');
      assert.equal(await page.locator(menu).isVisible(), false);
      check(`${surface}/${shell}: menu toggles, outside tap, Escape`);

      await click(toggle); await click(action('room'));
      await page.locator('#mobile-room-sheet').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '共有URLをコピー', exact: true }).click();
      const shared = new URL(await page.evaluate(() => navigator.clipboard.readText()));
      assert.equal(shared.searchParams.get('room'), new URL(page.url()).searchParams.get('room'));
      assert.equal(await page.locator('#mobile-room-sheet').isVisible(), false);
      await click(toggle); await click(action('room'));
      await click('#mobile-room-sheet-close');
      await click(toggle); await click(action('export'));
      await page.locator('#export-dialog').waitFor({ state: 'visible' });
      assert.equal(await page.locator(menu).isVisible(), false);
      await click('#export-dialog-close');
      await click(toggle); await click(action('help'));
      await page.locator('#welcome-dialog').waitFor({ state: 'visible' });
      const popupReady = context.waitForEvent('page');
      await page.locator('#welcome-dialog a[href="/scenesync/privacy/"]').click();
      const privacy = await popupReady;
      await privacy.waitForLoadState('domcontentloaded');
      assert.ok((await privacy.locator('body').innerText()).includes('プライバシーポリシー'));
      assert.equal(new URL(privacy.url()).pathname, '/scenesync/privacy/');
      await privacy.close();
      await page.bringToFront();
      await click('#welcome-close');
      const before = await page.evaluate(() => window.menuCalls.startAiLink || 0);
      await click(toggle); await click(action('ai'));
      assert.equal(await page.evaluate(() => window.menuCalls.startAiLink), before + 1);
      assert.equal(await page.locator(menu).isVisible(), false);
      check(`${surface}/${shell}: room/share, Export, Help/privacy, AI handler once (stubbed)`);

      if (studio) {
        await click(toggle); await click('[data-studio-menu] [data-studio-details]');
        await page.locator('#scene-inspector-panel').waitFor({ state: 'visible' });
        await click('#scene-inspector-close');
      } else {
        const player = mobile ? '#editor-scene-menu button[title="Player controls"]' : '#settings-panel .mobile-collapsible-row button[title="Player controls"]';
        if (mobile) await click(toggle);
        await click(player);
        await page.locator('.scene-sync-editor-player-panel').waitFor({ state: 'visible' });
        await click('.scene-sync-editor-player-panel [data-player-close]');
        assert.equal(await page.locator('.scene-sync-editor-player-panel').isVisible(), false);
        if (!mobile) {
          await click('#scene-inspector-toggle');
          await page.locator('#scene-inspector-panel').waitFor({ state: 'visible' });
          await click('#scene-inspector-close');
        }
      }
      check(`${surface}/${shell}: advanced controls preserved`);

      if (mobile) {
        await click(add);
        assert.deepEqual(await page.locator('#mobile-action-sheet .mobile-sheet-actions button').allTextContents(), ['画像を追加', 'ファイルを追加', 'URLを追加（メディア / SuperSplat）', 'クリップボードから追加', '背景']);
        await page.screenshot({ path: `${out}/${surface}-${shell}-plus.png` });
        await click('#mobile-action-sheet-close');
        for (const id of ['#mobile-add-image-btn', '#mobile-add-glb-btn']) {
          await click(add);
          const chooserReady = page.waitForEvent('filechooser');
          await click(id);
          await (await chooserReady).setFiles([]);
          assert.equal(await page.locator('#mobile-action-sheet').isVisible(), false);
        }
        await click(add); await click('#mobile-add-media-url-btn');
        await page.locator('#media-url-dialog').waitFor({ state: 'visible' });
        await click('#media-url-cancel-btn');
        // Supply local test text without reading the host clipboard.
        const objectsBeforePaste = await page.evaluate(async () => (await import('/assets/js/scenesync/ui/dom.js')).getSceneSyncShellRuntime().core.getEditorState().objectCount);
        await page.evaluate(() => {
          Object.defineProperty(navigator.clipboard, 'read', { configurable: true, value: async () => [{ types: ['text/plain'], getType: async () => new Blob(['Menu clipboard test'], { type: 'text/plain' }) }] });
        });
        await click(add); await click('#mobile-paste-btn');
        await page.waitForFunction(async before => (await import('/assets/js/scenesync/ui/dom.js')).getSceneSyncShellRuntime().core.getEditorState().objectCount > before, objectsBeforePaste, { timeout: 20000 });
        assert.equal(await page.locator('#mobile-action-sheet').isVisible(), false);
        await click(add); await click('#mobile-env-open-btn');
        await page.locator('#mobile-env-select').selectOption('outdoor_night');
        assert.equal(await page.locator('#env-select').inputValue(), 'outdoor_night');
        await page.locator('#mobile-env-select').selectOption('outdoor_day');
        await click('#mobile-env-sheet-close');
        await click(add);
        await page.touchscreen.tap(20, 100);
        assert.equal(await page.locator('#mobile-action-sheet').isVisible(), false);
        check(`${surface}/${shell}: five add actions, picker/URL/clipboard text import/background routes`);
      } else {
        const chooserReady = page.waitForEvent('filechooser');
        await click(add); await (await chooserReady).setFiles([]);
        check(`${surface}/${shell}: desktop + file picker preserved`);
      }
      await click(toggle); await click(action('room'));
      await page.evaluate(() => window.sceneSyncShell.switchTo('player'));
      assert.equal(await page.locator('.mobile-sheet:visible').count(), 0);
      assert.equal(await page.locator('.scene-sync-editor-player-panel').count(), 0);
      assert.equal(await page.locator('[data-studio-menu]').count(), 0);
      await page.evaluate(shell => window.sceneSyncShell.switchTo(shell), shell);
      await click(toggle); await click(action('ai'));
      assert.equal(await page.evaluate(() => window.menuCalls.startAiLink), before + 2);
      if (mobile) {
        for (const sheet of ['add', 'background']) {
          await click(add);
          if (sheet === 'background') await click('#mobile-env-open-btn');
          await page.evaluate(() => window.sceneSyncShell.switchTo('player'));
          assert.equal(await page.locator('.mobile-sheet:visible, #paste-sheet:visible').count(), 0);
          await page.evaluate(shell => window.sceneSyncShell.switchTo(shell), shell);
        }
        for (const viewport of [{ width: 844, height: 390 }, { width: 320, height: 568 }]) {
          await page.setViewportSize(viewport);
          await click(toggle);
          const bounds = await page.locator(menu).boundingBox();
          assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1, JSON.stringify(bounds));
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1, JSON.stringify(bounds));
          await page.locator(`${menu} [data-scene-clear]`).scrollIntoViewIfNeeded();
          assert.equal(await page.locator(`${menu} [data-scene-clear]`).evaluate(button => {
            const rect = button.getBoundingClientRect();
            return [0.2, 0.5, 0.8].every(fraction => button.contains(document.elementFromPoint(rect.x + rect.width * fraction, rect.y + rect.height / 2)));
          }), true, 'Clear remains reachable above editing toolbars');
          await page.screenshot({ path: `${out}/${surface}-${shell}-${viewport.width}x${viewport.height}.png` });
          await page.keyboard.press('Escape');
        }
        await page.setViewportSize({ width: 390, height: 844 });
      }
      check(`${surface}/${shell}: shell switching cleans sheets/Player and keeps one AI handler`);
    }
    if (mobile) {
      await page.goto(`${base}/scenesync/?shell=editor&dev=1&room=menu-dev-${Date.now().toString(36)}&presence=${encodeURIComponent(presence)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.sceneSyncShell?.current() === 'editor' && window.__sceneSyncDebug?.getRoomLifecycle().ready, null, { timeout: 60000 });
      await click('#editor-scene-menu summary');
      await click('#mobile-dev-open-btn');
      await page.locator('#scene-inspector-panel').waitFor({ state: 'visible' });
      await click('#scene-inspector-close');
      check('mobile/editor: dev=1 preserves Dev in the management menu');
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
