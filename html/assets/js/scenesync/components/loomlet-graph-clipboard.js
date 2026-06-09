// ── loomlet-graph-clipboard.js ─────────────────────────────
// 通常ペースト導線に統合する Loomlet graph paste parser。
//
// クリップボードの text を JSON parse し、以下を判定する。
//   - Raw graph JSON       ({ nodes: [], edges: [] })
//   - scene-graph-set message
//   - scene-graph-clear message
//
// 空 graph は attach せず clear として扱う。
// Loomlet graph として認識できない場合は null を返し、
// 呼び出し側は通常の text paste にフォールバックする。
// ──────────────────────────────────────────────────────────

export function parseLoomletGraphClipboardText(text) {
  if (typeof text !== 'string') return null;

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  if (isGraph(value)) {
    return {
      kind: isEmptyGraph(value) ? 'clear' : 'set',
      scope: { object: 'selected' },
      graph: value,
    };
  }

  if (value.type === 'scene-graph-set' && isGraph(value.graph)) {
    return {
      kind: isEmptyGraph(value.graph) ? 'clear' : 'set',
      scope: normalizeScope(value.scope),
      graph: value.graph,
    };
  }

  if (value.type === 'scene-graph-clear') {
    return {
      kind: 'clear',
      scope: normalizeScope(value.scope),
    };
  }

  return null;
}

export function isGraph(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges)
  );
}

export function isEmptyGraph(graph) {
  return graph.nodes.length === 0 && graph.edges.length === 0;
}

export function normalizeScope(scope) {
  if (!scope) return { object: 'selected' };
  if (scope === 'scene') return 'scene';
  if (scope?.scene === true) return 'scene';
  if (scope?.object === 'selected') return { object: 'selected' };
  if (typeof scope?.object === 'string') return { object: scope.object };
  return { object: 'selected' };
}
