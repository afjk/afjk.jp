import { Loom } from './loom.js';
import { LoomSceneSync } from './loom-scenesync.js';

export function createSceneSyncLoomIntegration({
  getObjectById,
  send,
  getServerTime,
  isObjectBeingEdited,
  showToast,
}) {
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
