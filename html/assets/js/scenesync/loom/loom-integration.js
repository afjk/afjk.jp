import { Loom } from './loom.js';
import { LoomSceneSync } from './loom-scenesync.js';

export function createSceneSyncLoomIntegration({
  getObjectById,
  send,
  getServerTime,
  isObjectBeingEdited,
  showToast,
}) {
  // TODO: Integrate Loomlet object graph evaluation with Scene Sync runtime time model.
  // Currently Loom uses its own requestAnimationFrame loop with wall-clock time.
  // Should be modified to:
  // 1. Call getObjectRuntimeTime(objectId) from Scene Sync
  // 2. Selected object graphs get t=0
  // 3. Deselected object graphs get advancing t from runtime origin reset on deselect
  // This will make object graph evaluation deterministic for late joiners and
  // multi-client synchronization, consistent with GLB animation behavior.

  const adapter = new LoomSceneSync({
    LoomClass: Loom,
    send,
    getServerTime,
    resolveTarget: (targetId) => {
      if (!targetId) return null;
      if (isObjectBeingEdited?.(targetId)) return null;
      return getObjectById(targetId);
    },
  });

  adapter.start();

  function isSceneGraphMessage(payload) {
    return payload &&
      typeof payload === 'object' &&
      typeof payload.type === 'string' &&
      payload.type.startsWith('scene-graph-');
  }

  function handlePayload(payload) {
    if (!isSceneGraphMessage(payload)) return false;

    try {
      adapter.handleMessage(payload);
      return true;
    } catch (error) {
      console.warn('[loom] failed to handle scene graph message:', error);
      showToast?.(`Loom graph error: ${error.code || error.message || 'unknown'}`);
      return true;
    }
  }

  function dispose() {
    if (typeof adapter.dispose === 'function') {
      adapter.dispose();
    } else {
      adapter.stop();
    }
  }

  return {
    handlePayload,
    exportState: () => adapter.exportState(),
    importState: (state) => adapter.importState(state),
    clearObjectGraph: (objectId) => adapter.clearObjectGraph(objectId),
    dispose,
    adapter,
  };
}
