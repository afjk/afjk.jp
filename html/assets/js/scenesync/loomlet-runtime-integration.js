import {
  createSceneSyncRuntime,
  LoomletSceneSyncRuntimeVersion,
} from '../../vendor/loomlet/0.3.0/loomlet-scenesync-runtime.browser.js';

export const LOOMLET_RUNTIME_METADATA = Object.freeze({
  version: LoomletSceneSyncRuntimeVersion,
  graphVersion: 'scene-sync-graph-json-v1',
  adapter: 'scenesync',
});

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function compareStrings(left, right) {
  return String(left || '').localeCompare(String(right || ''));
}

export function compareLoomletRuntimeScopeKeys(left, right) {
  if (left === right) return 0;
  if (left === 'scene') return -1;
  if (right === 'scene') return 1;
  return compareStrings(left, right);
}

export function compareLoomletRuntimeEvents(left, right) {
  return finiteNumber(left?.tick, 0) - finiteNumber(right?.tick, 0)
    || finiteNumber(left?.applyTick, 0) - finiteNumber(right?.applyTick, 0)
    || finiteNumber(left?.eventRevision, 0) - finiteNumber(right?.eventRevision, 0)
    || finiteNumber(left?.sequence, 0) - finiteNumber(right?.sequence, 0)
    || compareStrings(left?.channel ?? left?.type, right?.channel ?? right?.type)
    || compareStrings(left?.eventId, right?.eventId);
}

export function resolveLoomletRuntimeDeltaTime(clockState = null, fallback = 0) {
  if (Number.isFinite(Number(clockState?.deltaTime))) {
    return Math.max(0, Number(clockState.deltaTime));
  }
  if (Number.isFinite(Number(clockState?.delta))) {
    return Math.max(0, Number(clockState.delta));
  }
  return Math.max(0, finiteNumber(fallback, 0));
}

export function resolveLoomletRuntimeTick(clockState = null) {
  const tick = Number(clockState?.tick);
  return Number.isFinite(tick) ? Math.max(0, Math.floor(tick)) : undefined;
}

export function normalizeLoomletHostEventsForRuntime(hostEvents, {
  target = null,
  timestamp = 0,
} = {}) {
  if (!hostEvents) return [];

  const source = Array.isArray(hostEvents)
    ? hostEvents
    : (typeof hostEvents[Symbol.iterator] === 'function' ? Array.from(hostEvents) : []);
  return source.map((event) => {
    if (typeof event === 'string') {
      return {
        channel: event,
        type: event,
        target,
        timestamp,
        time: timestamp,
        ...(target ? { objectId: target } : {}),
      };
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;

    const channel = typeof event.channel === 'string' && event.channel.trim()
      ? event.channel.trim()
      : (typeof event.type === 'string' && event.type.trim() ? event.type.trim() : '');
    if (!channel) return null;

    const eventTimestamp = Number.isFinite(Number(event.timestamp))
      ? Number(event.timestamp)
      : (Number.isFinite(Number(event.time)) ? Number(event.time) : timestamp);
    const normalized = {
      ...cloneJson(event),
      channel,
      type: typeof event.type === 'string' && event.type.trim() ? event.type.trim() : channel,
      target: event.target || target,
      timestamp: Number.isFinite(eventTimestamp) ? eventTimestamp : 0,
    };
    if (normalized.time === undefined) normalized.time = normalized.timestamp;
    if (target && normalized.objectId === undefined) normalized.objectId = target;
    return normalized;
  }).filter(Boolean).sort(compareLoomletRuntimeEvents);
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

// Loomlet が emit する AudioSource 操作 effect。
// 実際の再生は host 側の AudioSource API（audioSource）へ委譲する。
const AUDIO_SOURCE_EFFECT_TYPES = new Set([
  'audioSource.play',
  'audioSource.pause',
  'audioSource.stop',
  'audioSource.seek',
  'audioSource.playOneShot',
  'audioSource.setVolume',
  'audioSource.setClip',
  'audioSource.syncToAnimation',
  'audioSource.unsync',
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
  getHostTime,
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
  audioSource,
}) {
  const runtimes = new Map();
  const definitions = new Map();
  const behaviorBases = new Map();

  function routeAudioSourceEffect(effect) {
    if (!audioSource) return;
    const objectId = effect.objectId || effect.target;
    if (!objectId) return;
    const name = effect.name || 'default';
    switch (effect.type) {
      case 'audioSource.play': audioSource.play?.(objectId, name); break;
      case 'audioSource.pause': audioSource.pause?.(objectId, name); break;
      case 'audioSource.stop': audioSource.stop?.(objectId, name); break;
      case 'audioSource.seek': audioSource.seek?.(objectId, name, effect.time ?? 0); break;
      case 'audioSource.playOneShot': audioSource.playOneShot?.(objectId, name, effect.options || {}); break;
      case 'audioSource.setVolume': audioSource.setVolume?.(objectId, name, effect.volume ?? 1); break;
      case 'audioSource.setClip': audioSource.setClip?.(objectId, name, effect.url); break;
      case 'audioSource.syncToAnimation': audioSource.syncToAnimation?.(objectId, name, effect.sync || effect.options || {}); break;
      case 'audioSource.unsync': audioSource.unsync?.(objectId, name); break;
      default: break;
    }
  }

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
      inputs['time.hostNow'] = clockState.hostNow;
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

    if (effect?.type && AUDIO_SOURCE_EFFECT_TYPES.has(effect.type)) {
      routeAudioSourceEffect(effect);
      return;
    }

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
      : (clockState?.t ?? getHostTime());

    // Build host inputs for object-scoped evaluations
    const inputs = entry.scopeObjectId ? buildHostInputsForObject(entry.scopeObjectId, time, clockState, { getInputRoutingMode }) : {};
    const deltaTime = resolveLoomletRuntimeDeltaTime(clockState);
    const tick = resolveLoomletRuntimeTick(clockState);

    // Gather host events for object-scoped evaluations
    let events = [];
    if (entry.scopeObjectId && getLoomletHostEvents) {
      events = normalizeLoomletHostEventsForRuntime(getLoomletHostEvents(entry.scopeObjectId), {
        target: entry.scopeObjectId,
        timestamp: time,
      });
    }

    const env = {
      time,
      deltaTime,
      scope: entry.scopeObjectId
        ? { type: 'object', id: entry.scopeObjectId }
        : { type: 'scene' },
      inputs,
      events,
    };
    if (tick !== undefined) env.tick = tick;

    entry.runtime.evaluateAt(env, Number.isFinite(time) ? time * 1000 : now);

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
      // If not provided, fall back to host-provided time
      for (const [key, entry] of Array.from(runtimes.entries()).sort(([left], [right]) => compareLoomletRuntimeScopeKeys(left, right))) {
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
  getHostTime = () => performance.now() / 1000,
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
  audioSource,
}) {
  const manager = createRuntimeManager({
    resolveTarget: (targetId) => targetId ? getObjectById(targetId) : null,
    getHostTime,
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
    audioSource,
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
    tickObjectGraphs: (clockState = null, now) => {
      if (typeof clockState === 'number' && now === undefined) {
        manager.tick(null, clockState);
        return;
      }
      manager.tick(clockState, now);
    },
    onObjectSelected: () => {},
    onObjectDeselected: (objectId) => manager.resetBehaviorBasesForObject(objectId),
    dispose: () => manager.dispose(),
    adapter: manager,
    sendGraph: (scope, graph) => send?.({ type: 'scene-graph-set', scope, graph }),
    clearGraph: (scope) => send?.({ type: 'scene-graph-clear', scope }),
  };
}
