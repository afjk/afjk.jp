import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WORKS } from '../html/assets/js/worksData.js';

const root = fileURLToPath(new URL('../html/', import.meta.url));
const out = path.resolve('logs/homepage-browser');
await mkdir(out, { recursive: true });
const report = { checks: [], security: { chromiumSandbox: true, ignoreHTTPSErrors: false }, liveX: { observations: [] } };
const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const pass = label => { report.checks.push(label); console.log('PASS', label); };
async function noOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth }));
  dimensions.width = page.viewportSize().width;
  assert.ok(dimensions.scroll <= dimensions.width, `${label}: horizontal overflow ${JSON.stringify(dimensions)}`);
}
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, ignoreDefaultArgs: ['--enable-unsafe-swiftshader'] });
  const security = await browser.newPage();
  await security.goto('chrome://sandbox');
  report.security.status = await security.locator('body').innerText();
  assert.match(report.security.status, /You are adequately sandboxed/);
  await security.close();
  for (const width of [1280, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600, ignoreHTTPSErrors: false });
    // Exercise the real fallback with external scripts blocked, never mocked tweets.
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'networkidle' });
    for (const lang of ['ja', 'en', 'ja', 'en']) {
      await page.locator(`#btn-${lang}`).click();
      assert.equal(await page.locator('html').getAttribute('lang'), lang);
      assert.equal(await page.locator('.work-card').count(), WORKS.length);
      assert.equal(await page.locator('.work-card h3').allTextContents().then(t => t.map(x => x.trim()).join('|')), WORKS.map(w => w.title[lang]).join('|'));
      await noOverflow(page, `${width}/${lang}`);
    }
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    for (const lang of ['ja', 'en']) {
      await page.locator(`#btn-${lang}`).click();
      await page.locator('#works').evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.screenshot({ animations: 'disabled', path: `${out}/${width}-${lang}-works.png` });
      await page.locator('#posts').evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
      assert.equal(await page.locator('.selected-post').count(), 4);
      assert.equal(await page.locator('.selected-post-link').count(), 4);
      assert.equal(await page.locator('#posts h2').innerText(), lang === 'ja' ? 'ピックアップ' : 'Selected posts');
      for (const link of await page.locator('.selected-post-link').all()) assert.ok(await link.isVisible());
      await page.locator('.posts-more a').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.posts-more a').getAttribute('href'), 'https://x.com/afjk01');
      await page.screenshot({ animations: 'disabled', path: `${out}/${width}-${lang}-posts-blocked.png` });
      await page.screenshot({ animations: 'disabled', path: `${out}/${width}-${lang}-full.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    pass(`${width}px: 17 cards, repeated language toggles, persisted language, no horizontal overflow, real blocked-widget fallback`);
    await context.close();
  }
  for (const width of [1280, 390, 320]) {
    const liveContext = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600, ignoreHTTPSErrors: false });
    // Only observe public post widgets; never send test traffic to production stats.
    await liveContext.route('https://afjk.jp/presence/stats', route => route.abort());
    const live = await liveContext.newPage();
    const observation = { width, status: 'not checked', failedRequests: [] };
    live.on('requestfailed', r => { if (/twitter|x\.com/.test(r.url())) observation.failedRequests.push({ url: r.url().split('?')[0], error: r.failure()?.errorText }); });
    await live.goto(origin, { waitUntil: 'domcontentloaded' });
    await live.locator('#posts').evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
    try {
      await live.waitForFunction(() => [...document.querySelectorAll('.selected-post iframe')].filter(frame => frame.getBoundingClientRect().height > 100).length === 4, null, { timeout: 20000 });
      observation.status = 'four post iframes visible; screenshots recorded for content review';
    } catch { observation.status = 'not all four post iframes became visible within 20 seconds; individual fallback links remain available'; }
    observation.visibleEmbeds = await live.locator('.selected-post iframe').evaluateAll(frames => frames.filter(frame => frame.getBoundingClientRect().height > 100).length);
    observation.posts = [];
    for (let index = 0; index < 4; index++) {
      const card = live.locator('.selected-post').nth(index);
      await card.scrollIntoViewIfNeeded();
      const handle = await card.locator('iframe').elementHandle();
      const frame = handle ? await handle.contentFrame() : null;
      let contentReady = false;
      if (frame) {
        try {
          await frame.waitForFunction(() => document.body.innerText.includes('afjk'), null, { timeout: 15000 });
          contentReady = true;
        } catch { /* Record unavailable external content without inventing a pass. */ }
      }
      observation.posts.push({ number: index + 1, contentReady });
      await card.screenshot({ animations: 'disabled', path: `${out}/live-x-${width}-post-${index + 1}.png` });
    }
    assert.equal(await live.locator('.selected-post-link').count(), 4);
    for (const link of await live.locator('.selected-post-link').all()) assert.ok(await link.isVisible());
    await noOverflow(live, `live X ${width}px`);
    await live.locator('#posts').screenshot({ animations: 'disabled', path: `${out}/live-x-${width}.png` });
    report.liveX.observations.push(observation);
    await liveContext.close();
    console.log('LIVE X', width, observation.status);
  }
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
