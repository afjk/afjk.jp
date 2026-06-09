import { test } from 'node:test';
import * as assert from 'node:assert';

import {
  parseLoomletGraphClipboardText,
  isGraph,
  isEmptyGraph,
  normalizeScope,
} from '../../../html/assets/js/scenesync/components/loomlet-graph-clipboard.js';

// 注意: parser は scope（'scene' / { object: 'box-1' } 等）を保持・正規化するが、
// これはあくまで parse 結果。実際の paste 適用側（scene.js tryHandleLoomletGraphPaste）
// では MVP 方針として parsed.scope を尊重せず、常に「選択中オブジェクト」へ
// 上書きして attach / clear する。以下の scope 関連テストは parser の挙動のみを
// 検証しており、最終的な貼り付け先を意味しない点に注意。

test('raw graph is parsed as set', () => {
  const text = JSON.stringify({
    nodes: [{ id: 'clock', type: 'clock' }],
    edges: [],
  });
  const result = parseLoomletGraphClipboardText(text);
  assert.ok(result);
  assert.strictEqual(result.kind, 'set');
  assert.deepStrictEqual(result.scope, { object: 'selected' });
  assert.strictEqual(result.graph.nodes.length, 1);
});

test('empty graph is parsed as clear', () => {
  const text = JSON.stringify({ nodes: [], edges: [] });
  const result = parseLoomletGraphClipboardText(text);
  assert.ok(result);
  assert.strictEqual(result.kind, 'clear');
  assert.deepStrictEqual(result.scope, { object: 'selected' });
});

test('scene-graph-set message is parsed', () => {
  const text = JSON.stringify({
    type: 'scene-graph-set',
    scope: { object: 'selected' },
    graph: { nodes: [{ id: 'a', type: 'clock' }], edges: [] },
  });
  const result = parseLoomletGraphClipboardText(text);
  assert.ok(result);
  assert.strictEqual(result.kind, 'set');
  assert.deepStrictEqual(result.scope, { object: 'selected' });
  assert.strictEqual(result.graph.nodes.length, 1);
});

test('scene-graph-set with empty graph is parsed as clear', () => {
  const text = JSON.stringify({
    type: 'scene-graph-set',
    scope: { object: 'selected' },
    graph: { nodes: [], edges: [] },
  });
  const result = parseLoomletGraphClipboardText(text);
  assert.ok(result);
  assert.strictEqual(result.kind, 'clear');
});

test('scene-graph-clear message is parsed', () => {
  const text = JSON.stringify({
    type: 'scene-graph-clear',
    scope: { object: 'selected' },
  });
  const result = parseLoomletGraphClipboardText(text);
  assert.ok(result);
  assert.strictEqual(result.kind, 'clear');
  assert.deepStrictEqual(result.scope, { object: 'selected' });
});

test('plain text returns null', () => {
  assert.strictEqual(parseLoomletGraphClipboardText('こんにちは、世界'), null);
});

test('invalid JSON returns null', () => {
  assert.strictEqual(parseLoomletGraphClipboardText('{ nodes: ['), null);
});

test('nodes that are not an array returns null', () => {
  const text = JSON.stringify({ nodes: {}, edges: [] });
  assert.strictEqual(parseLoomletGraphClipboardText(text), null);
});

test('edges that are not an array returns null', () => {
  const text = JSON.stringify({ nodes: [], edges: {} });
  assert.strictEqual(parseLoomletGraphClipboardText(text), null);
});

test('array JSON returns null', () => {
  assert.strictEqual(parseLoomletGraphClipboardText('[]'), null);
  assert.strictEqual(parseLoomletGraphClipboardText('[{"nodes":[],"edges":[]}]'), null);
});

test('non-string input returns null', () => {
  assert.strictEqual(parseLoomletGraphClipboardText(null), null);
  assert.strictEqual(parseLoomletGraphClipboardText(undefined), null);
  assert.strictEqual(parseLoomletGraphClipboardText({ nodes: [], edges: [] }), null);
});

test('isGraph guards', () => {
  assert.strictEqual(isGraph({ nodes: [], edges: [] }), true);
  assert.strictEqual(isGraph({ nodes: {}, edges: [] }), false);
  assert.strictEqual(isGraph([]), false);
  assert.strictEqual(isGraph(null), false);
});

test('isEmptyGraph', () => {
  assert.strictEqual(isEmptyGraph({ nodes: [], edges: [] }), true);
  assert.strictEqual(isEmptyGraph({ nodes: [{ id: 'a' }], edges: [] }), false);
  assert.strictEqual(isEmptyGraph({ nodes: [], edges: [{ from: 'a', to: 'b' }] }), false);
});

test('normalizeScope variations', () => {
  assert.deepStrictEqual(normalizeScope(undefined), { object: 'selected' });
  assert.deepStrictEqual(normalizeScope(null), { object: 'selected' });
  assert.strictEqual(normalizeScope('scene'), 'scene');
  assert.strictEqual(normalizeScope({ scene: true }), 'scene');
  assert.deepStrictEqual(normalizeScope({ object: 'selected' }), { object: 'selected' });
  assert.deepStrictEqual(normalizeScope({ object: 'box-1' }), { object: 'box-1' });
  assert.deepStrictEqual(normalizeScope({}), { object: 'selected' });
});
