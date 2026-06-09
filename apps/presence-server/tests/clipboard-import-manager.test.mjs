import { test } from 'node:test';
import * as assert from 'node:assert';

import { ClipboardImportManager } from '../../../html/assets/js/scenesync/components/clipboard-import-manager.js';

// paste listener 登録のみに使われる軽量な container モック
function makeContainer() {
  return {
    listeners: [],
    addEventListener(type, fn) { this.listeners.push([type, fn]); },
    removeEventListener() {},
  };
}

function makeManager(overrides = {}) {
  const toasts = [];
  const manager = new ClipboardImportManager({
    container: makeContainer(),
    showToast: (msg) => toasts.push(msg),
    handleFile: async () => ({ objectId: 'file-1' }),
    handleUrl: async () => ({ objectId: 'url-1' }),
    handleText: async () => ({ objectId: 'txt-1' }),
    ...overrides,
  });
  return { manager, toasts };
}

test('importPayload returns { ok: true } on successful text import', async () => {
  const { manager, toasts } = makeManager();
  const result = await manager.importPayload({ kind: 'text', text: 'hello' }, null);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.kind, 'text');
  assert.deepStrictEqual(result.result, { objectId: 'txt-1' });
  assert.ok(toasts.includes('クリップボードからテキストを追加しました'));
});

test('importPayload suppresses generic toast when handler returns suppressToast', async () => {
  const { manager, toasts } = makeManager({
    handleText: async () => ({ suppressToast: true }),
  });
  const result = await manager.importPayload({ kind: 'text', text: '{"nodes":[],"edges":[]}' }, null);
  // 成功扱い（Loomlet graph として consume されたケース）
  assert.strictEqual(result.ok, true);
  assert.ok(!toasts.includes('クリップボードからテキストを追加しました'));
});

test('importPayload returns { ok: true } for file and url', async () => {
  const { manager } = makeManager();
  const fileResult = await manager.importPayload({ kind: 'file', file: {} }, null);
  assert.strictEqual(fileResult.ok, true);
  assert.strictEqual(fileResult.kind, 'file');

  const urlResult = await manager.importPayload({ kind: 'url', url: 'https://example.com' }, null);
  assert.strictEqual(urlResult.ok, true);
  assert.strictEqual(urlResult.kind, 'url');
});

test('importPayload returns { ok: false } when handler throws', async () => {
  const { manager, toasts } = makeManager({
    handleText: async () => { throw new Error('boom'); },
  });
  const result = await manager.importPayload({ kind: 'text', text: 'x' }, null);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.kind, 'text');
  assert.ok(toasts.includes('boom'));
});

test('importPayload returns { ok: false } for unsupported payload', async () => {
  const { manager, toasts } = makeManager();
  const result = await manager.importPayload({ kind: 'empty' }, null);
  assert.strictEqual(result.ok, false);
  assert.ok(toasts.includes('このクリップボード内容は読み込めません'));
});

test('pasteFromNavigatorClipboard with silent does not show error toast when clipboard unavailable', async () => {
  // Node 環境では navigator.clipboard が undefined のため fallback は全てスキップされる
  const { manager, toasts } = makeManager();
  const result = await manager.pasteFromNavigatorClipboard(null, { silent: true });
  assert.strictEqual(result, null);
  assert.ok(!toasts.includes('クリップボードを読み取れません'));
});

test('pasteFromNavigatorClipboard without silent shows error toast when clipboard unavailable', async () => {
  const { manager, toasts } = makeManager();
  const result = await manager.pasteFromNavigatorClipboard(null);
  assert.strictEqual(result, null);
  assert.ok(toasts.includes('クリップボードを読み取れません'));
});
