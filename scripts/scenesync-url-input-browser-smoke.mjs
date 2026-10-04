// Local mobile form regression. Chromium does not reproduce iOS Safari's focus zoom or keyboard.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { localChromiumOptions } from './lib/local-chromium.mjs';

const base = process.env.AFJK_WEB_ORIGIN || 'http://127.0.0.1:8888';
const presence = process.env.AFJK_PRESENCE_URL || 'ws://127.0.0.1:8787';
for (const url of [base, presence]) {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Use local development endpoints');
}
const out = path.resolve(process.env.AFJK_URL_INPUT_OUTPUT || 'logs/url-input-browser-smoke');
await mkdir(out, { recursive: true });
const audit = process.env.AFJK_URL_INPUT_AUDIT === '1';
const result = {
  ok: false,
  cases: [],
  errors: [],
  security: { chromiumSandbox: true, ignoreHTTPSErrors: false },
  limitations: 'Mobile Chromium; reduced viewport checks are not the iOS software keyboard or Safari automatic focus zoom.',
};
const browser = await chromium.launch(localChromiumOptions());

async function tap(page, selector) {
  await page.locator(selector).tap();
  await page.waitForTimeout(250);
}
async function openDialog(page, shell) {
  await tap(page, shell === 'studio' ? '[data-studio-add]' : '#add-btn');
  await tap(page, '#mobile-add-media-url-btn');
  await page.locator('#media-url-input').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.activeElement.id === 'media-url-input');
}
async function snapshot(page, label) {
  return page.evaluate(label => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return {
      label,
      fontSize: getComputedStyle(document.querySelector('#media-url-input')).fontSize,
      formatFontSize: getComputedStyle(document.querySelector('#media-url-format')).fontSize,
      active: document.activeElement.id,
      viewport: document.querySelector('meta[name=viewport]').content,
      width: innerWidth,
      height: innerHeight,
      scale: visualViewport.scale,
      scrollWidth: document.documentElement.scrollWidth,
      dialog: rect('.media-url-content'),
      input: rect('#media-url-input'),
      cancel: rect('#media-url-cancel-btn'),
    };
  }, label);
}

try {
  const sandbox = await browser.newPage();
  await sandbox.goto('chrome://sandbox');
  result.security.status = await sandbox.locator('body').innerText();
  assert.match(result.security.status, /You are adequately sandboxed/);
  await sandbox.close();

  for (const shell of ['editor', 'studio']) {
    for (const [width, height] of [[390, 844], [320, 568], [844, 390], [390, 300]]) {
      // A fresh context avoids carrying Chromium's emulated rotation zoom across cases.
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: true,
        hasTouch: true,
        ignoreHTTPSErrors: false,
        locale: 'ja-JP',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
      });
      await context.addInitScript(() => {
        localStorage.setItem('sceneSync.welcomeSeen', 'true');
        localStorage.setItem('sceneSync.displayName', '入力確認');
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => result.errors.push(error.message));
      const url = new URL('/scenesync/', base);
      url.search = new URLSearchParams({ shell, dev: '1', room: `url-${Date.now().toString(36)}`, presence });
      await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(shell => window.sceneSyncShell?.current() === shell
        && window.__sceneSyncDebug?.getRoomLifecycle().ready, shell, { timeout: 45000 });

      await openDialog(page, shell);
      const label = `${shell}-${width}x${height}`;
      const initial = await snapshot(page, `${label}-focus`);
      result.cases.push(initial);
      await page.screenshot({ path: `${out}/${label}-focus.png` });
      if (!audit) {
        assert.ok(parseFloat(initial.fontSize) >= 16, `${label}: URL text must avoid small-text focus zoom`);
        assert.ok(parseFloat(initial.formatFontSize) >= 16, `${label}: format text must be at least 16px`);
        assert.doesNotMatch(initial.viewport, /user-scalable\s*=\s*(no|0)|maximum-scale\s*=/i);
        assert.equal(initial.width, width);
        assert.ok(initial.scrollWidth <= width + 1, `${label}: no horizontal overflow`);
        assert.ok(initial.dialog.top >= 0 && initial.dialog.bottom <= height + 1,
          `${label}: dialog must stay reachable in a reduced viewport`);
      }
      await page.locator('#media-url-input').fill('https://example.invalid/local-test_vr180_sbs.jpg');
      await page.locator('#media-url-format').selectOption('vr180:sbs');
      assert.match(await page.locator('#media-url-hint').innerText(), /VR180/);
      await page.locator('#media-url-cancel-btn').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/${label}-filled.png` });
      // Cancel never requests or uploads the entered URL.
      await tap(page, '#media-url-cancel-btn');
      await page.locator('#media-url-dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => visualViewport.scale), initial.scale);

      await openDialog(page, shell);
      assert.equal(await page.locator('#media-url-input').inputValue(), '');
      await page.locator('#media-url-input').fill('not-a-url');
      await page.keyboard.press('Enter');
      assert.ok(await page.locator('#media-url-dialog').isVisible());
      assert.equal(await page.locator('#media-url-input').inputValue(), 'not-a-url');
      if (!audit) {
        const invalid = await snapshot(page, `${label}-invalid`);
        result.cases.push(invalid);
        assert.ok(invalid.dialog.top >= 0 && invalid.dialog.bottom <= height + 1,
          `${label}: validation notice must leave dialog reachable`);
      }
      await page.keyboard.press('Escape');
      await page.locator('#media-url-dialog').waitFor({ state: 'hidden' });
      await page.screenshot({ path: `${out}/${label}-closed.png` });
      console.log('PASS', label);
      await context.close();
    }
  }
  assert.deepEqual(result.errors, []);
  result.ok = true;
} catch (error) {
  result.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2));
  await browser.close();
}
