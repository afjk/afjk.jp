import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSceneSyncPresenceUrl, getSceneSyncApiBaseUrl } from './presence-url.js';

test('default presence and API stay on the selected remote environment', () => {
  for (const origin of ['https://staging.afjk.jp', 'https://www.afjk.jp', 'https://afjk.jp', 'http://example.test:8080']) {
    const socket = resolveSceneSyncPresenceUrl(`${origin}/scenesync/?room=room`);
    assert.equal(socket, origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/presence');
    assert.equal(getSceneSyncApiBaseUrl(socket), origin + '/presence/api');
  }
});

test('local development keeps the existing port convention', () => {
  for (const host of ['localhost', '127.0.0.1']) {
    const socket = resolveSceneSyncPresenceUrl(`http://${host}:8888/scenesync/`);
    assert.equal(socket, 'ws://localhost:8787');
    assert.equal(getSceneSyncApiBaseUrl(socket), 'http://localhost:8787/api');
  }
});

test('ws/http and wss/https overrides share one correctly normalized API base', () => {
  for (const [input, socket, api] of [
    ['ws://127.0.0.1:8787', 'ws://127.0.0.1:8787/', 'http://127.0.0.1:8787/api'],
    ['http://127.0.0.1:8787/', 'ws://127.0.0.1:8787/', 'http://127.0.0.1:8787/api'],
    ['wss://staging.afjk.jp/presence', 'wss://staging.afjk.jp/presence', 'https://staging.afjk.jp/presence/api'],
    ['https://staging.afjk.jp/presence/', 'wss://staging.afjk.jp/presence/', 'https://staging.afjk.jp/presence/api'],
    ['/custom/presence/?transport=test', 'wss://example.test/custom/presence/?transport=test', 'https://example.test/custom/presence/api'],
    ['presence', 'wss://example.test/scenesync/presence', 'https://example.test/scenesync/presence/api'],
  ]) {
    const resolved = resolveSceneSyncPresenceUrl(`https://example.test/scenesync/?presence=${encodeURIComponent(input)}`);
    assert.equal(resolved, socket);
    assert.equal(getSceneSyncApiBaseUrl(resolved), api);
  }
});

test('unsupported protocols fail without falling back to production', () => {
  assert.throws(() => resolveSceneSyncPresenceUrl('https://staging.afjk.jp/?presence=ftp%3A%2F%2Fexample.test'), /protocol/);
  assert.throws(() => getSceneSyncApiBaseUrl('file:///presence'), /protocol/);
});
