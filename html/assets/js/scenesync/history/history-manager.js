export class HistoryManager {
  constructor(maxHistorySize = 100) {
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistorySize = maxHistorySize;
    this.onChange = null;
  }

  push(entry) {
    if (!entry || !entry.forward) return;
    this.undoStack.push(entry);
    this.redoStack = [];

    if (this.undoStack.length > this.maxHistorySize) {
      this.undoStack.shift();
    }

    this._notifyChange();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (!this.canUndo()) return null;
    const entry = this.undoStack.pop();
    this.redoStack.push(entry);
    this._notifyChange();
    return entry.backward;
  }

  redo() {
    if (!this.canRedo()) return null;
    const entry = this.redoStack.pop();
    this.undoStack.push(entry);
    this._notifyChange();
    return entry.forward;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this._notifyChange();
  }

  _notifyChange() {
    if (typeof this.onChange === 'function') {
      this.onChange({
        canUndo: this.canUndo(),
        canRedo: this.canRedo(),
        undoSize: this.undoStack.length,
        redoSize: this.redoStack.length,
      });
    }
  }

  getHistory(count = 10) {
    return this.undoStack.slice(-count).map(e => ({
      timestamp: e.timestamp,
      summary: e.summary,
    }));
  }

  static createAddEntry(objectId, asset, position, rotation, scale, name = '', meshPath = null) {
    const forward = {
      kind: 'scene-add',
      objectId,
      name,
      position,
      rotation,
      scale,
      asset,
    };
    if (meshPath) forward.meshPath = meshPath;

    return {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      summary: `Added ${name || objectId}`,
      forward,
      backward: {
        kind: 'scene-remove',
        objectId,
      },
    };
  }

  static createRemoveEntry(objectId, name, asset, position, rotation, scale, extra = {}) {
    const backward = {
      kind: 'scene-add',
      objectId,
      name,
      position,
      rotation,
      scale,
      asset,
    };

    if (extra.physics !== undefined) {
      backward.physics = extra.physics;
    }
    if (extra.audioSources !== undefined) {
      backward.audioSources = extra.audioSources;
    }

    return {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      summary: `Removed ${name || objectId}`,
      forward: {
        kind: 'scene-remove',
        objectId,
      },
      backward,
    };
  }

  static createDeltaEntry(objectId, name, beforePos, beforeRot, beforeScl, afterPos, afterRot, afterScl) {
    return {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      summary: `Modified ${name || objectId}`,
      forward: {
        kind: 'scene-delta',
        objectId,
        position: afterPos,
        rotation: afterRot,
        scale: afterScl,
      },
      backward: {
        kind: 'scene-delta',
        objectId,
        position: beforePos,
        rotation: beforeRot,
        scale: beforeScl,
      },
    };
  }

  static createEnvEntry(beforeEnvId, afterEnvId) {
    return {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      summary: `Environment changed to ${afterEnvId}`,
      forward: {
        kind: 'scene-env',
        envId: afterEnvId,
      },
      backward: {
        kind: 'scene-env',
        envId: beforeEnvId,
      },
    };
  }

  static createScenePhysicsEntry(beforePhysics, afterPhysics) {
    return {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      summary: afterPhysics?.enabled
        ? 'Scene physics enabled'
        : 'Scene physics disabled',
      forward: {
        kind: 'scene-physics',
        physics: afterPhysics || { enabled: false },
      },
      backward: {
        kind: 'scene-physics',
        physics: beforePhysics || { enabled: false },
      },
    };
  }

  static createBatchEntry(forwardActions, backwardActions, summary = 'Batch operation') {
    return {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      summary,
      forward: {
        kind: 'scene-batch',
        batchId: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        actions: forwardActions,
      },
      backward: {
        kind: 'scene-batch',
        batchId: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        actions: [...backwardActions].reverse(),
      },
    };
  }

  static createContentReplaceEntry(objectId, name, before, after) {
    return {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      summary: `Replaced content of ${name || objectId}`,
      forward: {
        kind: 'scene-delta',
        objectId,
        ...(after.name !== undefined ? { name: after.name } : {}),
        ...(after.position ? { position: after.position } : {}),
        ...(after.rotation ? { rotation: after.rotation } : {}),
        ...(after.scale ? { scale: after.scale } : {}),
        ...(after.asset !== undefined ? { asset: after.asset } : {}),
        ...(after.metadata !== undefined ? { metadata: after.metadata } : {}),
        ...(after.visible !== undefined ? { visible: after.visible } : {}),
        ...(after.audioSources !== undefined ? { audioSources: after.audioSources } : {}),
      },
      backward: {
        kind: 'scene-delta',
        objectId,
        ...(before.name !== undefined ? { name: before.name } : {}),
        ...(before.position ? { position: before.position } : {}),
        ...(before.rotation ? { rotation: before.rotation } : {}),
        ...(before.scale ? { scale: before.scale } : {}),
        ...(before.asset !== undefined ? { asset: before.asset } : {}),
        ...(before.metadata !== undefined ? { metadata: before.metadata } : {}),
        ...(before.visible !== undefined ? { visible: before.visible } : {}),
        ...(before.audioSources !== undefined ? { audioSources: before.audioSources } : {}),
      },
    };
  }

  static createSceneAddEntry(payload) {
    const clone = (value) => {
      if (value == null) return value;
      if (typeof structuredClone === 'function') return structuredClone(value);
      return JSON.parse(JSON.stringify(value));
    };

    return {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      summary: `Added ${payload.name || payload.objectId}`,
      forward: {
        kind: 'scene-add',
        objectId: payload.objectId,
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.position ? { position: [...payload.position] } : {}),
        ...(payload.rotation ? { rotation: [...payload.rotation] } : {}),
        ...(payload.scale ? { scale: [...payload.scale] } : {}),
        ...(payload.asset !== undefined ? { asset: clone(payload.asset) } : {}),
        ...(payload.metadata !== undefined ? { metadata: clone(payload.metadata) } : {}),
        ...(payload.visible !== undefined ? { visible: payload.visible } : {}),
        ...(payload.meshPath !== undefined ? { meshPath: payload.meshPath } : {}),
      },
      backward: {
        kind: 'scene-remove',
        objectId: payload.objectId,
      },
    };
  }
}

export function createHistoryManager() {
  return new HistoryManager();
}
