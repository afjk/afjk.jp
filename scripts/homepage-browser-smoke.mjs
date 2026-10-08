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
const report = { checks: [], security: { chromiumSandbox: true, ignoreHTTPSErrors: false }, liveX: { status: 'not checked' } };
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
      await page.locator('#posts').scrollIntoViewIfNeeded();
      await page.locator('.posts-more a').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.posts-more a').getAttribute('href'), 'https://x.com/afjk01');
      await page.screenshot({ animations: 'disabled', path: `${out}/${width}-${lang}-posts-blocked.png` });
      await page.screenshot({ animations: 'disabled', path: `${out}/${width}-${lang}-full.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    pass(`${width}px: 17 cards, repeated language toggles, persisted language, no horizontal overflow, real blocked-widget fallback`);
    await context.close();
  }
  const liveContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: false });
  // Do not touch the production stats service; only the existing X embed is observed.
  await liveContext.route('https://afjk.jp/presence/stats', route => route.abort());
  const live = await liveContext.newPage();
  const failedRequests = [];
  live.on('requestfailed', r => { if (/twitter|x\.com/.test(r.url())) failedRequests.push({ url: r.url().split('?')[0], error: r.failure()?.errorText }); });
  await live.goto(origin, { waitUntil: 'domcontentloaded' });
  await live.locator('#posts').scrollIntoViewIfNeeded();
  try {
    await live.locator('.posts-timeline iframe').waitFor({ state: 'visible', timeout: 20000 });
    report.liveX.status = 'iframe visible; post contents require visual review';
  } catch { report.liveX.status = 'timeline iframe did not become visible within 20 seconds; profile fallback remains available'; }
  report.liveX.failedRequests = failedRequests;
  report.liveX.frames = live.frames().map(frame => frame.url().split('?')[0]);
  assert.equal(await live.locator('.posts-more a').getAttribute('href'), 'https://x.com/afjk01');
  await noOverflow(live, 'live X desktop');
  await live.screenshot({ animations: 'disabled', path: `${out}/live-x-desktop.png` });
  await liveContext.close();
  console.log('LIVE X', report.liveX.status);
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
