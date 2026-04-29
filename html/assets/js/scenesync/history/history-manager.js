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

  static createRemoveEntry(objectId, name, asset, position, rotation, scale) {
    return {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      summary: `Removed ${name || objectId}`,
      forward: {
        kind: 'scene-remove',
        objectId,
      },
      backward: {
        kind: 'scene-add',
        objectId,
        name,
        position,
        rotation,
        scale,
        asset,
      },
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
}

export function createHistoryManager() {
  return new HistoryManager();
}
