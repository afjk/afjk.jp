#!/usr/bin/env node
// Drive the 3DGS Worker smoke page in a real browser.
//
//   npm run test:e2e:scene-sync-3dgs-worker
//
// The Node tests cover the Worker client against a stub and the worker module
// against a `self` shim, but neither exercises the thing that actually has to
// work in production: constructing a real module Worker from a served URL,
// transferring buffers across the boundary, and inflating gzip inside it.
//
// Nothing here loads three.js, so the page runs without the CDN importmap the
// editor depends on.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const htmlRoot = path.join(repoRoot, 'html');
const browserPath = path.join(repoRoot, '.playwright-browsers');

process.env.PLAYWRIGHT_BROWSERS_PATH ||= browserPath;

const SMOKE_PATH = '/scenesync/experiments/3dgs-worker-smoke.html';

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.glb', 'model/gltf-binary'],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const filePath = path.join(htmlRoot, relative);

      // Refuse anything that escapes the served root.
      if (!filePath.startsWith(htmlRoot)) {
        res.writeHead(403).end('forbidden');
        return;
      }

      const body = await readFile(filePath);
      const type = mimeTypes.get(path.extname(filePath)) || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'content-length': body.byteLength });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function main() {
  const { chromium } = await import('playwright');
  const { server, origin } = await startServer();

  // Environments that ship a pre-installed Chromium can point at it rather
  // than having Playwright download a matching build.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage();

    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));

    await page.goto(`${origin}${SMOKE_PATH}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__workerSmoke?.done === true, { timeout: 30_000 });

    const outcome = await page.evaluate(() => window.__workerSmoke);

    for (const entry of outcome.results) {
      const status = entry.ok ? 'PASS' : 'FAIL';
      console.log(`  ${status}  ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
    }

    if (consoleErrors.length > 0) {
      console.log('\nconsole errors:');
      for (const error of consoleErrors) console.log(`  ${error}`);
    }

    assert(outcome.results.length > 0, 'smoke page reported no checks');
    assert(outcome.failed === 0, `${outcome.failed} check(s) failed`);

    console.log(`\n3DGS worker smoke passed (${outcome.results.length} checks).`);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(`\n3DGS worker smoke FAILED: ${error.message}`);
  process.exit(1);
});
