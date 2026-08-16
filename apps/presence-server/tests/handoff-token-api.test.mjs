import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createPresenceServer } from '../src/server.mjs';
import { createHandoffTokenStore } from '../src/scenesync/handoff-token-store.mjs';

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

test('invalid partial upload leaves no task temp file', async () => {
  const response = await post('/scene-sync/handoff-tokens/upload', {
    token: 'd'.repeat(64), sessionId, requestId, payload: { version: 1, mode: 'embedded', sceneDocument: {}, embeddedAssets: {} },
  }, { origin: 'null' });
  assert.equal(response.status, 400);
  assert.equal(readdirSync(dir).some((name) => name.startsWith('.upload-')), false);
});

test('periodic orphan sweep removes only aged random upload parts', () => {
  const sweepDir = mkdtempSync(join(tmpdir(), 'handoff-token-orphan-'));
  try {
    const oldPart = join(sweepDir, '.upload-00000000-0000-0000-0000-000000000000.part');
    const freshPart = join(sweepDir, '.upload-11111111-1111-1111-1111-111111111111.part');
    writeFileSync(oldPart, 'old'); writeFileSync(freshPart, 'fresh');
    utimesSync(oldPart, new Date(0), new Date(0));
    const store = createHandoffTokenStore({ dir: sweepDir, now: () => 60_000, minFreeBytes: 0 });
    // Startup cleanup handles all pre-existing parts; recreate to specifically
    // exercise the periodic age guard.
    writeFileSync(oldPart, 'old'); writeFileSync(freshPart, 'fresh');
    utimesSync(oldPart, new Date(0), new Date(0));
    store.sweepOrphanUploads(30_000);
    assert.equal(readdirSync(sweepDir).includes(oldPart.split('/').pop()), false);
    assert.equal(readdirSync(sweepDir).includes(freshPart.split('/').pop()), true);
  } finally { rmSync(sweepDir, { recursive: true, force: true }); }
});

test('aborted backpressured client upload settles cleanup and releases capacity', async () => {
  await new Promise((resolve) => {
    const url = new URL(baseUrl + '/scene-sync/handoff-tokens/upload');
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 2 * 1024 * 1024 } }, resolve);
    req.on('error', resolve);
    // Large partial input drives the server writer through normal stream
    // backpressure before the client tears down its socket.
    req.write('{"token":"' + 'e'.repeat(64) + '","payload":"' + 'x'.repeat(512 * 1024));
    setTimeout(() => req.destroy(), 5);
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(readdirSync(dir).some((name) => name.startsWith('.upload-')), false);
  const response = await post('/scene-sync/handoff-tokens/upload', { token: 'f'.repeat(64), sessionId, requestId, payload }, { origin: 'null' });
  assert.equal(response.status, 201);
});
