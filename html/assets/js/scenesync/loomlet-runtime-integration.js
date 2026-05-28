import {
  createSceneSyncRuntime,
  LoomletSceneSyncRuntimeVersion,
} from '../../vendor/loomlet/0.1.2/loomlet-scenesync-runtime.browser.js';

export const LOOMLET_RUNTIME_METADATA = Object.freeze({
  version: LoomletSceneSyncRuntimeVersion,
  graphVersion: 'scene-sync-graph-json-v1',
  adapter: 'scenesync',
});

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function scopeKey(scope) {
  if (scope === 'scene' || scope?.scene === true) return 'scene';
  if (scope && typeof scope === 'object' && typeof scope.object === 'string') {
    return `object:${scope.object}`;
  }
  throw new Error('scope must be "scene", { scene: true }, or { object }');
}

function objectIdForScope(scope) {
  return scope && typeof scope === 'object' && typeof scope.object === 'string'
    ? scope.object
    : null;
}

const OBJECT_TARGET_NODE_TYPES = new Set([
  'sceneSetPosition',
  'sceneOffsetPosition',
  'sceneSetRotation',
  'sceneSetScale',
  'sceneSetColor',
  'sceneSetVisible',
  'scene.setPosition',
  'scene.offsetPosition',
  'scene.setRotation',
  'scene.setScale',
  'scene.setColor',
  'scene.setVisible',
]);

function graphForRuntime(graph, scopeObjectId) {
  const cloned = cloneJson(graph);
  if (!scopeObjectId) return cloned;

  return {
    ...cloned,
    nodes: cloned.nodes.map((node) => {
      if (!OBJECT_TARGET_NODE_TYPES.has(node.type)) return node;
      const params = { ...(node.params || {}) };
      if (!params.target && !params.objectId) {
        params.target = scopeObjectId;
      }
      return { ...node, params };
    }),
  };
}

function setVector3(target, values) {
  if (!target) return;
  if (typeof target.set === 'function') {
    target.set(values[0], values[1], values[2]);
  } else {
    target.x = values[0];
    target.y = values[1];
    target.z = values[2];
  }
}

function setQuaternion(target, values) {
  if (!target) return;
  if (typeof target.set === 'function') {
    target.set(values[0], values[1], values[2], values[3]);
  } else {
    target.x = values[0];
    target.y = values[1];
    target.z = values[2];
    target.w = values[3];
  }
}

function clonePosition(position) {
  if (!position) return null;
  if (typeof position.clone === 'function') return position.clone();
  return {
    x: Number(position.x || 0),
    y: Number(position.y || 0),
    z: Number(position.z || 0),
  };
}

function createRuntimeManager({
  resolveTarget,
  getServerTime,
  getObjectRuntimeTime,
  isObjectBeingEdited,
  getViewerPosition,
  getViewerForward,
  getObjectHoverState,
  getObjectGazeState,
  getGazeHit,
  getLoomletHostEvents,
  clearLoomletHostEvents,
  getSceneClockStateForLoomlet,
  getInputRoutingMode,
}) {
  const runtimes = new Map();
  const definitions = new Map();
  const behaviorBases = new Map();

  function makeBaseKey(key, target) {
    return `${key}:${target}`;
  }

  function buildHostInputsForObject(objectId, objectTime, clockState, options = {}) {
    const inputs = {};

    // Viewer inputs
    if (getViewerPosition) {
      const viewerPos = getViewerPosition();
      if (viewerPos) {
        inputs['viewer.position'] = viewerPos;
      }
    }
    if (getViewerForward) {
      const viewerFwd = getViewerForward();
      if (viewerFwd) {
        inputs['viewer.forward'] = viewerFwd;
      }
    }

    // Viewer gaze inputs (local-only, not broadcast)
    if (getViewerPosition) {
      const gazeOrigin = getViewerPosition();
      if (gazeOrigin) {
        inputs['viewer.gaze.origin'] = gazeOrigin;
      }
    }
    if (getViewerForward) {
      const gazeDirection = getViewerForward();
      if (gazeDirection) {
        inputs['viewer.gaze.direction'] = gazeDirection;
      }
    }
    const gazeHit = getGazeHit?.();
    if (gazeHit) {
      if (gazeHit.position) {
        inputs['viewer.gaze.hitPosition'] = gazeHit.position;
      }
      inputs['viewer.gaze.hitDistance'] = gazeHit.distance;
      inputs['viewer.gaze.hitObjectId'] = gazeHit.objectId;
      inputs['viewer.gaze.source'] = gazeHit.source || 'camera';
    }

    // Object-scoped inputs
    const obj = resolveTarget(objectId);
    if (obj) {
      if (obj.position) {
        const pos = Array.isArray(obj.position) ? obj.position : [obj.position.x || 0, obj.position.y || 0, obj.position.z || 0];
        inputs['self.position'] = pos;
      }

      if (obj.quaternion || obj.rotation) {
        const quat = obj.quaternion || obj.rotation;
        const rot = Array.isArray(quat)
          ? quat
          : [quat.x || 0, quat.y || 0, quat.z || 0, quat.w !== undefined ? quat.w : 1];
        inputs['self.rotation'] = rot;
      }

      // Distance to viewer
      if (getViewerPosition) {
        const viewerPos = getViewerPosition();
        if (viewerPos && obj.position) {
          const objPos = Array.isArray(obj.position) ? obj.position : [obj.position.x || 0, obj.position.y || 0, obj.position.z || 0];
          const dx = objPos[0] - viewerPos[0];
          const dy = objPos[1] - viewerPos[1];
          const dz = objPos[2] - viewerPos[2];
          inputs['distanceToViewer'] = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
      }
    }

    // Interaction state inputs
    const hoverState = getObjectHoverState?.(objectId);
    inputs['isSelected'] = hoverState?.isSelected || false;
    inputs['isHovered'] = hoverState?.isHovered || false;
    inputs['isBeingEdited'] = isObjectBeingEdited?.(objectId) || false;

    // Input routing mode inputs (local-only, read-only)
    // Loomlet behavior can read the current mode but cannot change it
    const mode = options?.getInputRoutingMode?.();
    if (mode) {
      inputs['input.mode'] = mode;
      inputs['input.isEditMode'] = mode === 'edit';
      inputs['input.isInteractMode'] = mode === 'interact';
    }

    // Gaze state inputs (local-only, not broadcast)
    const gazeState = getObjectGazeState?.(objectId);
    const isGazed = gazeState?.isGazed || false;
    const gazeDwellTime = gazeState?.gazeDwellTime || 0;
    const gazeDistance = gazeState?.gazeDistance || 0;

    inputs['isGazed'] = isGazed;
    inputs['gazeDwellTime'] = gazeDwellTime;

    inputs['target.isGazed'] = isGazed;
    inputs['target.gazeDwellTime'] = gazeDwellTime;
    inputs['target.gazeDistance'] = gazeDistance;

    // Scene Clock time inputs (local-only, not broadcast)
    // time.t = object graph が実評価される runtime time
    // (selected object の場合は t=0, normal object の場合は Scene Clock time)
    if (clockState) {
      inputs['time.t'] = objectTime ?? 0;
      inputs['time.delta'] = clockState.delta ?? 0;
      inputs['time.sceneT'] = clockState.t;
      inputs['time.sceneDelta'] = clockState.delta ?? 0;
      inputs['time.isPaused'] = clockState.isPaused;
      inputs['time.mode'] = clockState.mode;
      inputs['time.rate'] = clockState.rate;
      inputs['time.serverNow'] = clockState.serverNow;
    }

    return inputs;
  }

  function restoreBehaviorBasesForScope(key) {
    for (const [baseKey, base] of Array.from(behaviorBases.entries())) {
      if (!baseKey.startsWith(`${key}:`)) continue;
      const object = resolveTarget(base.target);
      if (object?.position && base.position) {
        if (typeof object.position.copy === 'function') {
          object.position.copy(base.position);
        } else {
          setVector3(object.position, [base.position.x, base.position.y, base.position.z]);
        }
      }
      behaviorBases.delete(baseKey);
    }
  }

  function applySceneEffect(effect, key) {
    const objectId = effect?.objectId;
    if (!objectId || isObjectBeingEdited?.(objectId)) return;

    const object = resolveTarget(objectId);
    if (!object) return;

    if (effect.type === 'scene.setPosition' && Array.isArray(effect.position)) {
      setVector3(object.position, effect.position);
    } else if (effect.type === 'scene.offsetPosition' && Array.isArray(effect.offset)) {
      const baseKey = makeBaseKey(key, objectId);
      if (!behaviorBases.has(baseKey)) {
        const position = clonePosition(object.position);
        if (position) {
          behaviorBases.set(baseKey, { scopeKey: key, target: objectId, position });
        }
      }
      const base = behaviorBases.get(baseKey)?.position;
      if (base) {
        setVector3(object.position, [
          base.x + effect.offset[0],
          base.y + effect.offset[1],
          base.z + effect.offset[2],
        ]);
      }
    } else if (effect.type === 'scene.setRotation' && Array.isArray(effect.rotation)) {
      setQuaternion(object.quaternion || object.rotation, effect.rotation);
    } else if (effect.type === 'scene.setScale' && Array.isArray(effect.scale)) {
      setVector3(object.scale, effect.scale);
    } else if (effect.type === 'scene.setVisible') {
      object.visible = Boolean(effect.visible);
    } else if (effect.type === 'scene.setColor' && Array.isArray(effect.color)) {
      const material = Array.isArray(object.material) ? object.material[0] : object.material;
      material?.color?.setRGB?.(effect.color[0], effect.color[1], effect.color[2]);
    }
  }

  function setGraph(scope, graph) {
    const key = scopeKey(scope);
    restoreBehaviorBasesForScope(key);

    const scopeObjectId = objectIdForScope(scope);
    const runtime = createSceneSyncRuntime(graphForRuntime(graph, scopeObjectId), {
      applySceneEffect: (effect) => applySceneEffect(effect, key),
      resolveTarget,
    });

    runtimes.set(key, { runtime, scopeObjectId });
    definitions.set(key, cloneJson(graph));
  }

  function clearGraph(scope) {
    const key = scopeKey(scope);
    restoreBehaviorBasesForScope(key);
    runtimes.delete(key);
    definitions.delete(key);
  }

  function evaluateRuntime(key, entry, clockState, now = performance.now()) {
    // object graph の実評価時刻を決定
    // - selected/edited object: t=0
    // - normal object: Scene Clock global time
    const time = entry.scopeObjectId && getObjectRuntimeTime
      ? getObjectRuntimeTime(entry.scopeObjectId, now, clockState)
      : (clockState?.t ?? getServerTime());

    // Build host inputs for object-scoped evaluations
    const inputs = entry.scopeObjectId ? buildHostInputsForObject(entry.scopeObjectId, time, clockState, { getInputRoutingMode }) : {};

    // Gather host events for object-scoped evaluations
    let events = [];
    if (entry.scopeObjectId && getLoomletHostEvents) {
      const eventNames = getLoomletHostEvents(entry.scopeObjectId);
      if (eventNames && eventNames.size > 0) {
        events = Array.from(eventNames).map((channel) => ({
          channel,
          target: entry.scopeObjectId,
          timestamp: time,
        }));
      }
    }

    entry.runtime.evaluateAt({
      time,
      scope: entry.scopeObjectId
        ? { type: 'object', id: entry.scopeObjectId }
        : { type: 'scene' },
      inputs,
      events,
    }, now);

    // Clear events after evaluation
    if (entry.scopeObjectId && clearLoomletHostEvents) {
      clearLoomletHostEvents(entry.scopeObjectId);
    }
  }

  return {
    handleMessage(message) {
      if (!message || typeof message !== 'object') {
        throw new Error('Scene Sync graph message must be an object');
      }
      if (message.type === 'scene-graph-set') {
        setGraph(message.scope || 'scene', message.graph);
      } else if (message.type === 'scene-graph-clear') {
        clearGraph(message.scope || 'scene');
      } else if (message.type === 'scene-graph-patch' && message.graph) {
        setGraph(message.scope || 'scene', message.graph);
      } else if (message.type !== 'scene-graph-input') {
        throw new Error(`Unsupported Scene Sync graph message type: ${message.type}`);
      }
    },
    tick(clockState = null, now = performance.now()) {
      // clockState: Scene Clock state from host
      // If not provided, fall back to server time
      for (const [key, entry] of runtimes) {
        evaluateRuntime(key, entry, clockState, now);
      }
    },
    exportState() {
      const state = { scene: null, objects: {} };
      if (definitions.has('scene')) {
        state.scene = cloneJson(definitions.get('scene'));
      }
      for (const [key, graph] of definitions) {
        if (!key.startsWith('object:')) continue;
        state.objects[key.slice('object:'.length)] = cloneJson(graph);
      }
      if (behaviorBases.size > 0) {
        state.bases = {};
        for (const [key, base] of behaviorBases) {
          state.bases[key] = {
            scopeKey: base.scopeKey,
            target: base.target,
            position: {
              x: base.position.x,
              y: base.position.y,
              z: base.position.z,
            },
          };
        }
      }
      return state;
    },
    importState(state) {
      if (!state || typeof state !== 'object') return;

      runtimes.clear();
      definitions.clear();
      behaviorBases.clear();

      if (state.bases && typeof state.bases === 'object') {
        for (const [key, base] of Object.entries(state.bases)) {
          if (!base?.position || !base.target) continue;
          const object = resolveTarget(base.target);
          if (object?.position) {
            setVector3(object.position, [base.position.x, base.position.y, base.position.z]);
          }
          behaviorBases.set(key, {
            scopeKey: base.scopeKey,
            target: base.target,
            position: { ...base.position },
          });
        }
      }

      if (state.scene) {
        setGraph('scene', state.scene);
      }
      if (state.objects && typeof state.objects === 'object') {
        for (const [objectId, graph] of Object.entries(state.objects)) {
          if (graph) setGraph({ object: objectId }, graph);
        }
      }
    },
    clearObjectGraph(objectId) {
      if (objectId) clearGraph({ object: objectId });
    },
    resetBehaviorBasesForObject(objectId) {
      const prefix = `object:${objectId}:`;
      for (const key of Array.from(behaviorBases.keys())) {
        if (key.startsWith(prefix)) behaviorBases.delete(key);
      }
    },
    dispose() {
      runtimes.clear();
      definitions.clear();
      behaviorBases.clear();
    },
  };
}

export function createSceneSyncLoomIntegration({
  getObjectById,
  send,
  getServerTime,
  getObjectRuntimeTime,
  isObjectBeingEdited,
  showToast,
  getViewerPosition,
  getViewerForward,
  getObjectHoverState,
  getObjectGazeState,
  getGazeHit,
  getLoomletHostEvents,
  clearLoomletHostEvents,
  getSceneClockStateForLoomlet,
  getInputRoutingMode,
}) {
  const manager = createRuntimeManager({
    resolveTarget: (targetId) => targetId ? getObjectById(targetId) : null,
    getServerTime,
    getObjectRuntimeTime,
    isObjectBeingEdited,
    getViewerPosition,
    getViewerForward,
    getObjectHoverState,
    getObjectGazeState,
    getGazeHit,
    getLoomletHostEvents,
    clearLoomletHostEvents,
    getSceneClockStateForLoomlet,
    getInputRoutingMode,
  });

  function isSceneGraphMessage(payload) {
    return payload &&
      typeof payload === 'object' &&
      typeof payload.type === 'string' &&
      payload.type.startsWith('scene-graph-');
  }

  function handlePayload(payload) {
    if (!isSceneGraphMessage(payload)) return false;
    try {
      manager.handleMessage(payload);
      return true;
    } catch (error) {
      console.warn('[loomlet] failed to handle scene graph message:', error);
      showToast?.(`Loomlet graph error: ${error.code || error.message || 'unknown'}`);
      return true;
    }
  }

  return {
    handlePayload,
    exportState: () => manager.exportState(),
    importState: (state) => manager.importState(state),
    clearObjectGraph: (objectId) => manager.clearObjectGraph(objectId),
    tickObjectGraphs: (now) => manager.tick(now),
    onObjectSelected: () => {},
    onObjectDeselected: (objectId) => manager.resetBehaviorBasesForObject(objectId),
    dispose: () => manager.dispose(),
    adapter: manager,
    sendGraph: (scope, graph) => send?.({ type: 'scene-graph-set', scope, graph }),
    clearGraph: (scope) => send?.({ type: 'scene-graph-clear', scope }),
  };
}
