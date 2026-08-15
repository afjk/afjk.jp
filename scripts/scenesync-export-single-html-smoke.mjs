import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { VIEWER_SOURCES } from '../html/assets/js/scenesync-export/export/build-export-package.js';
import { buildSingleHtmlDocument } from '../html/assets/js/scenesync-export/export/single-html-format.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repoRoot, '.playwright-browsers');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadViewerFiles() {
  const files = {};
  for (const { src, dest, binary = false, transform = null } of VIEWER_SOURCES) {
    const absolutePath = path.join(repoRoot, 'html', src.replace(/^\//u, ''));
    const raw = await readFile(absolutePath);
    const content = binary ? raw : raw.toString('utf8');
    files[dest] = typeof transform === 'function' ? transform(content) : content;
  }
  return files;
}

async function startServer(html) {
  const server = createServer((request, response) => {
    if (request.url !== '/' && request.url !== '/index.html') {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/` };
}

const sceneDocument = {
  format: 'scene-sync-export-scene',
  version: 2,
  units: 'meters',
  objects: [
    {
      id: 'ground', position: [0, -0.1, 0], rotation: [0, 0, 0, 1], scale: [4, 0.2, 4],
      asset: { type: 'primitive', primitive: 'box', color: '#555555' },
      physics: { enabled: true, bodyType: 'static', shape: 'box', halfExtents: [2, 0.1, 2] },
    },
    {
      id: 'box', position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      asset: { type: 'primitive', primitive: 'box', color: '#4488ff' },
      physics: { enabled: true, bodyType: 'dynamic', shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    },
  ],
  physics: { enabled: true, duration: 2, worldOptions: { gravity: -9.81 } },
  behaviors: { scene: { nodes: [], edges: [] } },
};

let browser;
let server;
try {
  const viewerFiles = await loadViewerFiles();
  const html = await buildSingleHtmlDocument({
    sceneDocument,
    manifest: {
      format: 'scene-sync-export', version: 1,
      singleHtml: { format: 'single-html-v1', version: 1 },
    },
    viewerFiles,
  });
  const serverInfo = await startServer(html);
  server = serverInfo.server;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(serverInfo.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading-overlay')?.classList.contains('hidden'), null, { timeout: 20000 });
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => ({
    format: document.querySelector('meta[name="scene-sync-export-format"]')?.content,
    hasAssets: Boolean(window.__SCENE_SYNC_SINGLE_HTML_ASSET_URLS__),
    hasSceneDocument: Boolean(window.__SCENE_SYNC_SINGLE_HTML_SCENE_DOCUMENT__),
    canvasWidth: document.getElementById('viewer-canvas')?.width || 0,
  }));
  assert(pageErrors.length === 0, `Page errors: ${pageErrors.join('\n')}`);
  assert(state.format === 'single-html-v1', 'Single HTML format marker was not preserved');
  assert(state.hasAssets && state.hasSceneDocument, 'Embedded resolver payload was not initialized');
  assert(state.canvasWidth > 0, 'Viewer canvas was not initialized');
  console.log(JSON.stringify({ status: 'passed', ...state }, null, 2));
} finally {
  await browser?.close();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
