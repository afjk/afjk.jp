import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPresenceServer } from '../src/server.mjs';

const token = 'a'.repeat(64);
const sessionId = 's'.repeat(22);
const requestId = 'r'.repeat(22);
const payload = { version: 1, mode: 'embedded', sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [] }, embeddedAssets: {} };
let server; let baseUrl; let dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'handoff-token-test-'));
  server = createPresenceServer({ handoffTokenDir: dir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); });

async function post(path, body, headers = {}) {
  return fetch(baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('upload CORS is public; same-origin bound claim is one-use', async () => {
  const preflight = await fetch(baseUrl + '/scene-sync/handoff-tokens/upload', { method: 'OPTIONS' });
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  const upload = await post('/scene-sync/handoff-tokens/upload', { token, sessionId, requestId, payload }, { origin: 'null' });
  assert.equal(upload.status, 201);
  const wrong = await post('/scene-sync/handoff-tokens/claim', { token, sessionId, requestId: 'q'.repeat(22) }, { origin: 'https://afjk.jp', 'sec-fetch-site': 'same-origin' });
  assert.equal(wrong.status, 202);
  const claim = await post('/scene-sync/handoff-tokens/claim', { token, sessionId, requestId }, { origin: 'https://afjk.jp', 'sec-fetch-site': 'same-origin' });
  assert.equal(claim.status, 200);
  assert.equal(claim.headers.get('access-control-allow-origin'), null);
  assert.deepEqual((await claim.json()).payload, payload);
  const replay = await post('/scene-sync/handoff-tokens/claim', { token, sessionId, requestId }, { origin: 'https://afjk.jp', 'sec-fetch-site': 'same-origin' });
  assert.equal(replay.status, 202);
});

test('URL payload upload requires matching public Origin', async () => {
  const response = await post('/scene-sync/handoff-tokens/upload', {
    token: 'b'.repeat(64), sessionId, requestId,
    payload: { version: 1, mode: 'url', sourceUrl: 'https://elsewhere.test/export/' },
  }, { origin: 'https://afjk.jp' });
  assert.equal(response.status, 403);
});

test('concurrent bound claims have exactly one winner', async () => {
  const concurrentToken = 'c'.repeat(64);
  assert.equal((await post('/scene-sync/handoff-tokens/upload', { token: concurrentToken, sessionId, requestId, payload }, { origin: 'null' })).status, 201);
  const headers = { origin: 'https://afjk.jp', 'sec-fetch-site': 'same-origin' };
  const results = await Promise.all([
    post('/scene-sync/handoff-tokens/claim', { token: concurrentToken, sessionId, requestId }, headers),
    post('/scene-sync/handoff-tokens/claim', { token: concurrentToken, sessionId, requestId }, headers),
  ]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 202]);
});
