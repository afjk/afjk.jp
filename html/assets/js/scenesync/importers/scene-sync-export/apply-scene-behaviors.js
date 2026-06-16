function isBehaviorGraph(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges)
  );
}

export function applySceneDocumentBehaviors(behaviors, {
  managedObjects,
  applySceneGraphOperation,
  broadcast,
  source = 'scene-sync-export-import',
} = {}) {
  if (!behaviors || typeof behaviors !== 'object' || Array.isArray(behaviors)) {
    return { applied: 0, skipped: 0, operations: [] };
  }
  if (typeof applySceneGraphOperation !== 'function') {
    return { applied: 0, skipped: 0, operations: [] };
  }

  let applied = 0;
  let skipped = 0;
  const operations = [];

  function applyOperation(operation) {
    const ok = applySceneGraphOperation(operation);
    if (ok === false) {
      skipped += 1;
      return;
    }
    broadcast?.(operation);
    operations.push(operation);
    applied += 1;
  }

  if (isBehaviorGraph(behaviors.scene)) {
    applyOperation({
      type: 'scene-graph-set',
      scope: 'scene',
      graph: behaviors.scene,
      source,
    });
  }

  const objectGraphs =
    behaviors.objects &&
    typeof behaviors.objects === 'object' &&
    !Array.isArray(behaviors.objects)
      ? behaviors.objects
      : null;

  if (objectGraphs) {
    for (const [objectId, graph] of Object.entries(objectGraphs)) {
      if (!isBehaviorGraph(graph)) {
        skipped += 1;
        continue;
      }
      if (managedObjects instanceof Map && !managedObjects.has(objectId)) {
        skipped += 1;
        continue;
      }
      applyOperation({
        type: 'scene-graph-set',
        scope: { object: objectId },
        graph,
        source,
      });
    }
  }

  return { applied, skipped, operations };
}
