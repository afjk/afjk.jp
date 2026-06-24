import {
  CANONICAL_PHYSICS_HASH_VERSION,
  createWorld,
  DEFAULT_TIMESTEP_SECONDS,
  getRapierPhysicsInitError,
  initRapierPhysics,
  isRapierPhysicsReady,
  normalizeRapierWorldOptions,
  RAPIER_CORE_VERSION,
} from './physics/index.js';
import { createCollisionPairKey } from './runtime/runtime-events.js';
import { createSceneEventTimeline } from './runtime/event-timeline.js';

export const DEFAULT_SCENE_PHYSICS_DURATION = 10;
export const SCENE_SYNC_RAPIER_PROFILE = 'SceneSyncRapierParity-0.30';
export const SCENE_SYNC_PHYSICS_SNAPSHOT_VERSION = 'SceneSyncPhysicsSnapshotV1';
export const SCENE_SYNC_PHYSICS_TIMELINE_VERSION = 'SceneSyncPhysicsTimelineV1';
export const SCENE_SYNC_EVENT_LOG_KIND = 'scene-event-log';
export const SCENE_SYNC_PHYSICS_BODY_STATE_EVENT_CHANNEL = 'physics.body.setState';
export const DEFAULT_SCENE_PHYSICS_TIMELINE_ID = 'default';
export const DEFAULT_SCENE_PHYSICS = Object.freeze({
  version: 1,
  enabled: false,
  duration: DEFAULT_SCENE_PHYSICS_DURATION,
  worldOptions: {
    gravity: -9.81,
    ground: {
      y: 0,
      restitution: 0.2,
      friction: 0.5,
    },
    timestep: DEFAULT_TIMESTEP_SECONDS,
  },
});

const BODY_TYPES = new Set(['dynamic', 'static']);
const SHAPES = new Set(['box', 'sphere']);
const ZERO_TIME_EPSILON = 1e-6;
const MAX_PENDING_BODY_STATE_INPUTS = 256;
const MAX_BODY_STATE_INPUT_HISTORY = 512;

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.max(min, Math.min(max, fallback));
  return Math.max(min, Math.min(max, number));
}

function readVec3(value, fallback = [0, 0, 0]) {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [
    finiteNumber(value[0], fallback[0] || 0),
    finiteNumber(value[1], fallback[1] || 0),
    finiteNumber(value[2], fallback[2] || 0),
  ];
}

function readPositiveVec3(value, fallback) {
  const next = readVec3(value, fallback);
  return next.map((component, index) => positiveNumber(component, fallback[index] || 0.5));
}

function readQuaternion(value, fallback = [0, 0, 0, 1]) {
  if (!Array.isArray(value) || value.length < 4) return [...fallback];
  return [
    finiteNumber(value[0], fallback[0] || 0),
    finiteNumber(value[1], fallback[1] || 0),
    finiteNumber(value[2], fallback[2] || 0),
    finiteNumber(value[3], fallback[3] ?? 1),
  ];
}

function normalizeInitialTransform(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    position: readVec3(input.position, [0, 0, 0]),
    rotation: readQuaternion(input.rotation, [0, 0, 0, 1]),
    scale: readPositiveVec3(input.scale, [1, 1, 1]),
  };
}

function normalizeGround(input) {
  if (input === null || input === false) return null;
  const source = input && typeof input === 'object'
    ? input
    : DEFAULT_SCENE_PHYSICS.worldOptions.ground;
  return {
    y: finiteNumber(source.y, DEFAULT_SCENE_PHYSICS.worldOptions.ground.y),
    restitution: clampNumber(
      source.restitution,
      0,
      1,
      DEFAULT_SCENE_PHYSICS.worldOptions.ground.restitution,
    ),
    friction: clampNumber(
      source.friction,
      0,
      1,
      DEFAULT_SCENE_PHYSICS.worldOptions.ground.friction,
    ),
  };
}

function normalizeWorldOptions(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const gravity = Array.isArray(source.gravity)
    ? readVec3(source.gravity, [0, -9.81, 0])
    : finiteNumber(source.gravity, DEFAULT_SCENE_PHYSICS.worldOptions.gravity);
  const timestep = positiveNumber(source.timestep, DEFAULT_SCENE_PHYSICS.worldOptions.timestep);

  return {
    gravity,
    ground: normalizeGround(source.ground),
    timestep,
  };
}

export function normalizeScenePhysics(input = null) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    version: 1,
    enabled: source.enabled === true,
    duration: positiveNumber(source.duration, DEFAULT_SCENE_PHYSICS_DURATION),
    worldOptions: normalizeWorldOptions(source.worldOptions || source),
  };
}

export function normalizeObjectPhysics(input = null) {
  if (!input || typeof input !== 'object' || input.enabled === false) return null;

  const bodyType = BODY_TYPES.has(input.bodyType)
    ? input.bodyType
    : (input.static === true ? 'static' : 'dynamic');
  const shape = SHAPES.has(input.shape) ? input.shape : 'box';

  const physics = {
    version: 1,
    enabled: true,
    bodyType,
    shape,
    mass: bodyType === 'static' ? 0 : positiveNumber(input.mass, 1),
    restitution: clampNumber(input.restitution, 0, 1, 0.2),
    friction: clampNumber(input.friction, 0, 1, 0.5),
  };

  if (Array.isArray(input.velocity)) {
    physics.velocity = readVec3(input.velocity);
  } else if (bodyType === 'dynamic') {
    physics.velocity = [0, 0, 0];
  }

  if (Array.isArray(input.angularVelocity)) {
    physics.angularVelocity = readVec3(input.angularVelocity);
  } else if (bodyType === 'dynamic') {
    physics.angularVelocity = [0, 0, 0];
  }

  if (bodyType === 'static') {
    physics.density = finiteNonNegativeNumber(input.density, 0);
  } else if (Number.isFinite(Number(input.density))) {
    physics.density = positiveNumber(input.density, 1);
  }
  if (Number.isFinite(Number(input.linearDamping))) {
    physics.linearDamping = finiteNonNegativeNumber(input.linearDamping, 0);
  }
  if (Number.isFinite(Number(input.angularDamping))) {
    physics.angularDamping = finiteNonNegativeNumber(input.angularDamping, 0);
  }
  if (typeof input.canSleep === 'boolean') {
    physics.canSleep = input.canSleep;
  }
  if (typeof input.ccd === 'boolean') {
    physics.ccd = input.ccd;
  } else if (typeof input.ccdEnabled === 'boolean') {
    physics.ccd = input.ccdEnabled;
  }

  if (shape === 'sphere' && Number.isFinite(Number(input.radius))) {
    physics.radius = positiveNumber(input.radius, 0.5);
  }
  if (shape === 'box' && Array.isArray(input.halfExtents)) {
    physics.halfExtents = readPositiveVec3(input.halfExtents, [0.5, 0.5, 0.5]);
  }
  const initialTransform = normalizeInitialTransform(input.initialTransform);
  if (initialTransform) {
    physics.initialTransform = initialTransform;
  }

  return physics;
}

export function serializeScenePhysics(input = null) {
  const physics = normalizeScenePhysics(input);
  if (!physics.enabled) return null;
  return cloneJson(physics);
}

export function serializeObjectPhysics(input = null) {
  const physics = normalizeObjectPhysics(input);
  return physics ? cloneJson(physics) : null;
}

function getPositionArray(object) {
  if (typeof object?.position?.toArray === 'function') return object.position.toArray();
  return readVec3(object?.position);
}

function getScaleArray(object) {
  if (typeof object?.scale?.toArray === 'function') return object.scale.toArray();
  return readVec3(object?.scale, [1, 1, 1]);
}

function getRotationArray(object) {
  if (typeof object?.quaternion?.toArray === 'function') return object.quaternion.toArray();
  const q = object?.quaternion;
  if (q && ['x', 'y', 'z', 'w'].every((key) => Number.isFinite(Number(q[key])))) {
    return [q.x, q.y, q.z, q.w];
  }
  return [0, 0, 0, 1];
}

function applyTransformArrays(object, transform) {
  if (!object || !transform) return;
  if (Array.isArray(transform.position)) {
    if (typeof object.position?.fromArray === 'function') {
      object.position.fromArray(transform.position);
    } else if (object.position) {
      object.position.x = transform.position[0];
      object.position.y = transform.position[1];
      object.position.z = transform.position[2];
    }
  }
  if (Array.isArray(transform.rotation)) {
    if (typeof object.quaternion?.fromArray === 'function') {
      object.quaternion.fromArray(transform.rotation);
    } else if (object.quaternion) {
      object.quaternion.x = transform.rotation[0];
      object.quaternion.y = transform.rotation[1];
      object.quaternion.z = transform.rotation[2];
      object.quaternion.w = transform.rotation[3];
    }
  }
  if (Array.isArray(transform.scale)) {
    if (typeof object.scale?.fromArray === 'function') {
      object.scale.fromArray(transform.scale);
    } else if (object.scale) {
      object.scale.x = transform.scale[0];
      object.scale.y = transform.scale[1];
      object.scale.z = transform.scale[2];
    }
  }
  object.updateMatrixWorld?.(true);
}

function inferShape(physics, object) {
  if (physics?.shape === 'sphere') return 'sphere';
  if (physics?.shape === 'box') return 'box';
  return object?.userData?.asset?.primitive === 'sphere' ? 'sphere' : 'box';
}

export function buildPhysicsBodyDef({ objectId, object, physics, useInitialTransform = false }) {
  const normalized = normalizeObjectPhysics(physics);
  if (!objectId || !object || !normalized) return null;

  const initialTransform = useInitialTransform ? normalized.initialTransform : null;
  const scale = (initialTransform?.scale || getScaleArray(object))
    .map((component) => Math.abs(component || 1));
  const shape = inferShape(normalized, object);
  const body = {
    id: objectId,
    shape,
    position: initialTransform?.position || getPositionArray(object),
    rotation: initialTransform?.rotation || getRotationArray(object),
    velocity: normalized.bodyType === 'static'
      ? [0, 0, 0]
      : readVec3(normalized.velocity, [0, 0, 0]),
    angularVelocity: normalized.bodyType === 'static'
      ? [0, 0, 0]
      : readVec3(normalized.angularVelocity, [0, 0, 0]),
    mass: normalized.bodyType === 'static' ? 0 : normalized.mass,
    static: normalized.bodyType === 'static',
    restitution: normalized.restitution,
    friction: normalized.friction,
    density: Number.isFinite(Number(normalized.density)) ? normalized.density : undefined,
    linearDamping: Number.isFinite(Number(normalized.linearDamping)) ? normalized.linearDamping : undefined,
    angularDamping: Number.isFinite(Number(normalized.angularDamping)) ? normalized.angularDamping : undefined,
    canSleep: typeof normalized.canSleep === 'boolean' ? normalized.canSleep : undefined,
    ccd: typeof normalized.ccd === 'boolean' ? normalized.ccd : undefined,
  };

  if (shape === 'sphere') {
    body.radius = positiveNumber(
      normalized.radius,
      Math.max(scale[0], scale[1], scale[2]) / 2 || 0.5,
    );
  } else {
    body.halfExtents = readPositiveVec3(
      normalized.halfExtents,
      [
        Math.max(0.01, scale[0] / 2 || 0.5),
        Math.max(0.01, scale[1] / 2 || 0.5),
        Math.max(0.01, scale[2] / 2 || 0.5),
      ],
    );
  }

  return body;
}

function applyBodyTransform(object, body) {
  if (!object || !body?.position) return;
  if (typeof object.position?.fromArray === 'function') {
    object.position.fromArray(body.position);
  } else if (object.position) {
    object.position.x = body.position[0];
    object.position.y = body.position[1];
    object.position.z = body.position[2];
  }
  if (body.rotation) {
    if (typeof object.quaternion?.fromArray === 'function') {
      object.quaternion.fromArray(body.rotation);
    } else if (object.quaternion) {
      object.quaternion.x = body.rotation[0];
      object.quaternion.y = body.rotation[1];
      object.quaternion.z = body.rotation[2];
      object.quaternion.w = body.rotation[3];
    }
  }
  object.updateMatrixWorld?.(true);
}

function collectRuntimeEntries(entries) {
  return Array.from(entries || [])
    .map((entry) => {
      const objectId = entry?.objectId || entry?.id || entry?.object?.userData?.objectId || null;
      const physics = normalizeObjectPhysics(entry?.physics || entry?.object?.userData?.physics);
      if (!objectId || !entry?.object || !physics) return null;
      return { objectId, object: entry.object, physics };
    })
    .filter(Boolean)
    .sort((left, right) => left.objectId.localeCompare(right.objectId));
}

function finiteNonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function normalizeTimelineId(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_SCENE_PHYSICS_TIMELINE_ID;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// Generic hold/release intent for a body-state input. The runtime core does not
// know about drag/grab phase names — it only reads this generic control mode.
// Returns 'hold', 'release', or '' (one-shot apply, leaves any existing hold).
function normalizeControlMode(payload) {
  const raw = normalizeOptionalString(payload?.controlMode).toLowerCase();
  if (raw === 'hold' || raw === 'release') return raw;
  if (typeof payload?.hold === 'boolean') return payload.hold ? 'hold' : 'release';
  return '';
}

function compareStrings(left = '', right = '') {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function isScenePhysicsZeroTime(value) {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= ZERO_TIME_EPSILON;
}

export function createPhysicsResetBaseline({
  time = 0,
  worldEpochTime = time,
  preserveMotion = false,
  reason = 'reset',
} = {}) {
  return {
    kind: 'reset',
    time: finiteNonNegativeNumber(time, 0),
    worldEpochTime: finiteNonNegativeNumber(worldEpochTime, 0),
    preserveMotion: preserveMotion === true,
    reason,
  };
}

export function shouldResetPhysicsForSceneClockPayload(payload, activeTime = null) {
  if (!payload || typeof payload !== 'object') return false;
  const baseline = payload.physicsBaseline;
  if (baseline?.kind === 'reset') {
    return isScenePhysicsZeroTime(baseline.time ?? payload.targetTime ?? payload.time ?? activeTime);
  }
  if (payload.action === 'reset') return true;
  if (payload.action !== 'seek') return false;
  return [
    payload.targetTime,
    payload.time,
    payload.pausedTime,
    activeTime,
  ].some(isScenePhysicsZeroTime);
}

export function applyPhysicsResetBaseline(runtime, clockState = null, baseline = null) {
  if (!runtime) return false;
  const worldEpochTime = finiteNonNegativeNumber(
    baseline?.worldEpochTime,
    finiteNonNegativeNumber(clockState?.t, 0),
  );
  const resetClockState = {
    ...(clockState || {}),
    t: worldEpochTime,
  };
  const reset = runtime.resetToInitialPose?.(resetClockState) === true;
  runtime.markDirty?.({
    preserveMotion: baseline?.preserveMotion === true,
    worldEpochTime,
  });
  return reset;
}

export function createScenePhysicsRuntime({
  getScenePhysics,
  getObjectEntries,
  isClockActive = (clockState) => clockState?.transportActive === true,
  isObjectPaused = null,
} = {}) {
  let dirty = true;
  let world = null;
  let initialSnapshot = null;
  let authoritativeSnapshotBaseline = null;
  let entryMap = new Map();
  let active = false;
  let timestepSeconds = DEFAULT_TIMESTEP_SECONDS;
  let worldEpochTime = 0;
  let pendingWorldEpochTime = null;
  let preserveMotionOnRebuild = true;
  let resetMotionObjectIds = new Set();
  let previousCollisionPairs = new Set();
  let pendingBodyStateInputs = [];
  let bodyStateInputHistory = [];
  let activeBodyStateHolds = new Map();
  const appliedBodyStateInputIds = new Set();
  let timelineId = DEFAULT_SCENE_PHYSICS_TIMELINE_ID;
  let timelineRevision = 0;
  let timelineForkTick = 0;
  let timelineClearRevision = 0;
  let lastEventRevision = 0;
  const bodyStateEventTimeline = createSceneEventTimeline({
    timelineId: DEFAULT_SCENE_PHYSICS_TIMELINE_ID,
    maxHistory: MAX_BODY_STATE_INPUT_HISTORY,
    maxPending: MAX_PENDING_BODY_STATE_INPUTS,
  });

  function syncBodyStateTimelineState() {
    const state = bodyStateEventTimeline.getTimelineState();
    timelineId = state.timelineId;
    timelineRevision = state.timelineRevision;
    timelineForkTick = state.timelineForkTick;
    timelineClearRevision = state.timelineClearRevision;
    lastEventRevision = state.lastEventRevision;
  }

  function bodyStateEventFromInput(input) {
    const payload = {
      inputType: 'set-body-state',
      objectId: input.objectId,
      position: input.position.slice(),
      rotation: input.rotation.slice(),
      velocity: input.velocity.slice(),
      angularVelocity: input.angularVelocity.slice(),
    };
    if (input.controlMode) payload.controlMode = input.controlMode;
    return {
      ...input,
      kind: 'scene-event',
      channel: SCENE_SYNC_PHYSICS_BODY_STATE_EVENT_CHANNEL,
      type: SCENE_SYNC_PHYSICS_BODY_STATE_EVENT_CHANNEL,
      eventId: input.inputId,
      target: input.objectId,
      source: 'physics',
      timestamp: input.applyTick * Math.max(0.000001, timestepSeconds),
      payload,
    };
  }

  function bodyStateInputFromEvent(event) {
    const payload = isRecord(event?.payload) ? event.payload : {};
    return {
      inputId: event.inputId || payload.inputId || event.eventId,
      objectId: event.objectId || payload.objectId || event.target || payload.target,
      applyTick: nonNegativeInteger(event.applyTick ?? payload.applyTick, 0),
      timelineId: normalizeTimelineId(event.timelineId ?? payload.timelineId),
      timelineRevision: nonNegativeInteger(event.timelineRevision ?? payload.timelineRevision, 0),
      timelineClearRevision: nonNegativeInteger(
        event.timelineClearRevision ?? payload.timelineClearRevision,
        0,
      ),
      eventRevision: nonNegativeInteger(event.eventRevision ?? payload.eventRevision, 0),
      interactionId: normalizeOptionalString(event.interactionId ?? payload.interactionId),
      sequence: nonNegativeInteger(event.sequence ?? payload.sequence, 0),
      phase: normalizeOptionalString(event.phase ?? payload.phase),
      controlMode: normalizeOptionalString(event.controlMode ?? payload.controlMode),
      branchTick: nonNegativeInteger(
        event.branchTick ?? payload.branchTick,
        event.applyTick ?? payload.applyTick,
      ),
      position: readVec3(event.position ?? payload.position, [0, 0, 0]),
      rotation: readQuaternion(event.rotation ?? payload.rotation, [0, 0, 0, 1]),
      velocity: readVec3(
        event.velocity ?? event.linearVelocity ?? payload.velocity ?? payload.linearVelocity,
        [0, 0, 0],
      ),
      angularVelocity: readVec3(
        event.angularVelocity ?? event.angvel ?? payload.angularVelocity ?? payload.angvel,
        [0, 0, 0],
      ),
    };
  }

  function syncBodyStateInputListsFromTimeline() {
    bodyStateInputHistory = bodyStateEventTimeline.getEventHistory().map(bodyStateInputFromEvent);
    pendingBodyStateInputs = bodyStateEventTimeline.getPendingEvents().map(bodyStateInputFromEvent);
    syncBodyStateTimelineState();
  }

  function isBodyStateSceneEvent(payload) {
    const channel = normalizeOptionalString(payload?.channel ?? payload?.type);
    return payload?.kind === 'scene-event' && channel === SCENE_SYNC_PHYSICS_BODY_STATE_EVENT_CHANNEL;
  }

  function hasBodyStateTransformPayload(payload) {
    const eventPayload = isRecord(payload?.payload) ? payload.payload : {};
    return Array.isArray(payload?.position ?? eventPayload.position) &&
      Array.isArray(payload?.rotation ?? eventPayload.rotation);
  }

  function clear({ preserveInputs = false } = {}) {
    world?.free?.();
    world = null;
    initialSnapshot = null;
    authoritativeSnapshotBaseline = null;
    entryMap = new Map();
    active = false;
    timestepSeconds = DEFAULT_TIMESTEP_SECONDS;
    worldEpochTime = 0;
    pendingWorldEpochTime = null;
    preserveMotionOnRebuild = true;
    resetMotionObjectIds = new Set();
    previousCollisionPairs = new Set();
    if (!preserveInputs) {
      pendingBodyStateInputs = [];
      bodyStateInputHistory = [];
      activeBodyStateHolds = new Map();
      appliedBodyStateInputIds.clear();
      timelineId = DEFAULT_SCENE_PHYSICS_TIMELINE_ID;
      timelineRevision = 0;
      timelineForkTick = 0;
      timelineClearRevision = 0;
      lastEventRevision = 0;
      bodyStateEventTimeline.reset({ timelineId });
    }
  }

  function markDirty({
    worldEpochTime: nextWorldEpochTime = null,
    preserveMotion = true,
    resetMotionObjectIds: resetIds = null,
  } = {}) {
    dirty = true;
    if (nextWorldEpochTime !== null && nextWorldEpochTime !== undefined) {
      const epoch = Number(nextWorldEpochTime);
      if (Number.isFinite(epoch)) pendingWorldEpochTime = Math.max(0, epoch);
    }
    if (preserveMotion === false) preserveMotionOnRebuild = false;
    const ids = Array.isArray(resetIds) ? resetIds : (resetIds ? [resetIds] : []);
    for (const id of ids) {
      if (typeof id === 'string' && id.length > 0) {
        resetMotionObjectIds.add(id);
      }
    }
  }

  function getClockTime(clockState = null) {
    const time = Number(clockState?.t);
    return Number.isFinite(time) ? Math.max(0, time) : 0;
  }

  function captureWorldStateForRebuild(clockState = null) {
    const motion = new Map();
    if (!world) return motion;

    for (const [objectId, entry] of entryMap) {
      const body = world.getBody(objectId);
      if (!body || body.static) continue;
      const shouldResetMotion = resetMotionObjectIds.has(objectId);
      const paused = isObjectPaused?.(objectId, clockState) === true;
      if (!paused && !shouldResetMotion) {
        applyBodyTransform(entry.object, body);
      }
      if (preserveMotionOnRebuild && !paused && !shouldResetMotion) {
        motion.set(objectId, {
          velocity: readVec3(body.velocity, [0, 0, 0]),
          angularVelocity: readVec3(body.angularVelocity, [0, 0, 0]),
        });
      }
    }

    return motion;
  }

  function rebuild(clockState = null) {
    const scenePhysics = normalizeScenePhysics(getScenePhysics?.());
    const entries = collectRuntimeEntries(getObjectEntries?.());
    if (!scenePhysics.enabled || entries.length === 0) {
      clear({ preserveInputs: scenePhysics.enabled });
      dirty = false;
      return { ok: false, reason: 'no-bodies' };
    }

    if (!isRapierPhysicsReady()) {
      initRapierPhysics().catch((error) => {
        console.warn('[scene-physics] Rapier initialization failed', error);
      });
      return {
        ok: false,
        reason: getRapierPhysicsInitError() ? 'rapier-error' : 'rapier-loading',
      };
    }

    const previousMotion = captureWorldStateForRebuild(clockState);
    world?.free?.();
    world = createWorld(scenePhysics.worldOptions);
    timestepSeconds = world.timestep || normalizeRapierWorldOptions(scenePhysics.worldOptions).timestep;
    entryMap = new Map();
    const useInitialTransform = preserveMotionOnRebuild === false;
    worldEpochTime = Number.isFinite(pendingWorldEpochTime)
      ? pendingWorldEpochTime
      : getClockTime(clockState);
    pendingWorldEpochTime = null;

    for (const entry of entries) {
      const body = buildPhysicsBodyDef({ ...entry, useInitialTransform });
      if (!body) continue;
      if (useInitialTransform && entry.physics?.initialTransform) {
        applyTransformArrays(entry.object, entry.physics.initialTransform);
      }
      const motion = previousMotion.get(entry.objectId);
      if (motion && !body.static) {
        body.velocity = motion.velocity;
        body.angularVelocity = motion.angularVelocity;
      }
      world.addBody(body);
      entryMap.set(entry.objectId, entry);
    }

    initialSnapshot = world.snapshot();
    authoritativeSnapshotBaseline = null;
    dirty = false;
    preserveMotionOnRebuild = true;
    resetMotionObjectIds = new Set();
    previousCollisionPairs = new Set();

    // Hard reset rebuild (Back to Start / zero baseline) starts a fresh world at
    // tick 0, so the tick-based rewind in update() (targetTick < world.tick) never
    // re-arms recorded inputs. Re-queue the input history here so it replays
    // deterministically from the reset, matching plain backward-seek behaviour.
    if (useInitialTransform && bodyStateInputHistory.length > 0) {
      rewindBodyStateInputsToInitialSnapshot();
    }

    return entryMap.size > 0
      ? { ok: true }
      : { ok: false, reason: 'no-bodies' };
  }

  function applyWorldToObjects(clockState = null) {
    if (!world) return;
    for (const [objectId, entry] of entryMap) {
      const body = world.getBody(objectId);
      if (!body || body.static) continue;
      if (isObjectPaused?.(objectId, clockState) === true) continue;
      applyBodyTransform(entry.object, body);
    }
  }

  function resetToInitialPose(clockState = null) {
    if (!world || !initialSnapshot) return false;
    world.restore(initialSnapshot);
    authoritativeSnapshotBaseline = null;
    previousCollisionPairs = new Set();
    worldEpochTime = getClockTime(clockState);
    applyWorldToObjects(clockState);
    return true;
  }

  function resetActiveToInitialPose(clockState = null) {
    if (!active) return false;
    const reset = resetToInitialPose(clockState);
    if (reset) active = false;
    return reset;
  }

  // Read each dynamic body's initial (authoring) pose WITHOUT disturbing the live
  // simulation or the scene objects. Persistence paths must serialize the initial
  // pose, but doing so must not visibly teleport the running bodies (that snap-back
  // is what made interactive drags appear to "rewind").
  function getInitialBodyPoses() {
    if (!world || !initialSnapshot) return null;
    const liveState = world.snapshot();
    if (world.restore(initialSnapshot) !== true) {
      return null;
    }
    const poses = new Map();
    for (const objectId of entryMap.keys()) {
      const body = world.getBody(objectId);
      if (!body || body.static) continue;
      poses.set(objectId, {
        position: readVec3(body.position),
        rotation: readQuaternion(body.rotation),
      });
    }
    // Restore the live state. Note: we deliberately do NOT call applyWorldToObjects,
    // so the scene meshes keep their current (simulated) transforms.
    world.restore(liveState);
    return poses;
  }

  function getWorldAge(clockState) {
    return Math.max(0, getClockTime(clockState) - worldEpochTime);
  }

  function queueInput(payload = {}) {
    const acceptsPhysicsInput = payload.kind === 'scene-physics-input' &&
      payload.inputType === 'set-body-state';
    const acceptsSceneEvent = isBodyStateSceneEvent(payload);
    if (!acceptsPhysicsInput && !acceptsSceneEvent) return false;
    if (acceptsSceneEvent && !hasBodyStateTransformPayload(payload)) return false;

    const source = acceptsSceneEvent ? bodyStateInputFromEvent(payload) : payload;
    const objectId = typeof source.objectId === 'string' ? source.objectId.trim() : '';
    if (!objectId) return false;

    const applyTickNumber = Number(source.applyTick);
    const applyTick = Number.isFinite(applyTickNumber)
      ? Math.max(0, Math.floor(applyTickNumber))
      : (world?.tick || 0);
    const payloadTimelineId = normalizeTimelineId(source.timelineId);
    const payloadTimelineRevision = nonNegativeInteger(source.timelineRevision, timelineRevision);
    const branchTick = nonNegativeInteger(source.branchTick, applyTick);
    const payloadTimelineClearRevision = nonNegativeInteger(source.timelineClearRevision, 0);

    const interactionId = normalizeOptionalString(source.interactionId);
    const sequence = nonNegativeInteger(source.sequence, 0);
    const phase = normalizeOptionalString(source.phase);
    const controlMode = normalizeControlMode(source);
    const eventRevision = nonNegativeInteger(source.eventRevision, 0);
    const inputId = typeof source.inputId === 'string' && source.inputId.trim()
      ? source.inputId.trim()
      : (interactionId ? `${interactionId}:${sequence}` : `${objectId}:${applyTick}`);

    if (!Array.isArray(source.position) || !Array.isArray(source.rotation)) {
      return false;
    }

    const input = {
      inputId,
      objectId,
      applyTick,
      timelineId: payloadTimelineId,
      timelineRevision: payloadTimelineRevision,
      timelineClearRevision: payloadTimelineClearRevision,
      eventRevision,
      interactionId,
      sequence,
      phase,
      controlMode,
      branchTick,
      position: readVec3(source.position, [0, 0, 0]),
      rotation: readQuaternion(source.rotation, [0, 0, 0, 1]),
      velocity: readVec3(source.velocity || source.linearVelocity, [0, 0, 0]),
      angularVelocity: readVec3(source.angularVelocity || source.angvel, [0, 0, 0]),
    };

    const previousTimelineRevision = timelineRevision;
    const result = bodyStateEventTimeline.queueEvent(bodyStateEventFromInput(input), {
      currentTick: world?.tick,
      isReplayRelevantChange: (previousEvent, nextEvent) => {
        const previousInput = previousEvent ? bodyStateInputFromEvent(previousEvent) : null;
        const nextInput = bodyStateInputFromEvent(nextEvent);
        const physicalStateChanged = !previousInput ||
          !bodyStateInputPhysicalStateEquals(previousInput, nextInput);
        const orderChangedWithPeer = Boolean(
          previousInput &&
          compareBodyStateInputs(previousInput, nextInput) !== 0 &&
          hasSameTickInputPeer(nextInput),
        );
        return physicalStateChanged || orderChangedWithPeer;
      },
    });
    if (!result.ok) return false;

    syncBodyStateInputListsFromTimeline();
    if (timelineRevision > previousTimelineRevision) {
      authoritativeSnapshotBaseline = null;
      activeBodyStateHolds = new Map();
      appliedBodyStateInputIds.clear();
    }

    if (result.replayRequired && world && rewindBodyStateInputsToInitialSnapshot()) {
      return true;
    }
    if (world && input.applyTick === world.tick && result.replayRelevantChange === true) {
      applyDueBodyStateInputs(world.tick);
    }
    return true;
  }

  function numberArrayEquals(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }

  function bodyStateInputPhysicalStateEquals(left, right) {
    if (!left || !right) return false;
    return left.objectId === right.objectId
      && left.applyTick === right.applyTick
      && numberArrayEquals(left.position, right.position)
      && numberArrayEquals(left.rotation, right.rotation)
      && numberArrayEquals(left.velocity, right.velocity)
      && numberArrayEquals(left.angularVelocity, right.angularVelocity);
  }

  function hasSameTickInputPeer(input) {
    if (!input) return false;
    return bodyStateInputHistory.some(item => item.inputId !== input.inputId && item.applyTick === input.applyTick)
      || pendingBodyStateInputs.some(item => item.inputId !== input.inputId && item.applyTick === input.applyTick);
  }

  function compareBodyStateInputs(left, right) {
    return left.applyTick - right.applyTick
      || left.timelineRevision - right.timelineRevision
      || left.eventRevision - right.eventRevision
      || compareStrings(left.interactionId, right.interactionId)
      || left.sequence - right.sequence
      || compareStrings(left.phase, right.phase)
      || compareStrings(left.inputId, right.inputId);
  }

  function advanceTimelineRevision(nextRevision, branchTick) {
    if (!Number.isInteger(nextRevision) || nextRevision <= timelineRevision) return false;
    const forkTick = Math.max(0, Math.floor(Number(branchTick) || 0));
    const dropsAppliedInput = bodyStateInputHistory.some(input => (
      input.timelineRevision !== nextRevision &&
      input.applyTick > forkTick &&
      appliedBodyStateInputIds.has(input.inputId)
    ));
    timelineRevision = nextRevision;
    timelineForkTick = forkTick;
    authoritativeSnapshotBaseline = null;

    const keepInput = (input) => (
      input.timelineRevision === timelineRevision ||
      input.applyTick <= timelineForkTick
    );
    bodyStateInputHistory = bodyStateInputHistory.filter(keepInput);
    pendingBodyStateInputs = pendingBodyStateInputs.filter(keepInput);
    appliedBodyStateInputIds.clear();
    activeBodyStateHolds = new Map();
    lastEventRevision = bodyStateInputHistory.reduce(
      (max, input) => Math.max(max, input.eventRevision || 0),
      0,
    );
    bodyStateEventTimeline.setTimelineState({
      timelineId,
      timelineRevision,
      timelineForkTick,
      timelineClearRevision,
      lastEventRevision,
    });
    bodyStateEventTimeline.removeEvents((event) => {
      const input = bodyStateInputFromEvent(event);
      return !(input.timelineRevision === timelineRevision || input.applyTick <= timelineForkTick);
    });
    syncBodyStateInputListsFromTimeline();

    if (dropsAppliedInput && world && world.tick > timelineForkTick) {
      rewindBodyStateInputsToInitialSnapshot();
    }
    return true;
  }

  function getLastEventRevisionAfterTimelineBranch(nextRevision, branchTick) {
    const normalizedRevision = Math.max(0, Math.floor(Number(nextRevision) || 0));
    const normalizedBranchTick = Math.max(0, Math.floor(Number(branchTick) || 0));
    let revision = 0;
    for (const input of bodyStateInputHistory) {
      if (input.timelineRevision === normalizedRevision || input.applyTick <= normalizedBranchTick) {
        revision = Math.max(revision, input.eventRevision || 0);
      }
    }
    for (const input of pendingBodyStateInputs) {
      if (input.timelineRevision === normalizedRevision || input.applyTick <= normalizedBranchTick) {
        revision = Math.max(revision, input.eventRevision || 0);
      }
    }
    return revision;
  }

  function inputCoveredBySnapshot(input, snapshotTick, snapshotLastEventRevision) {
    if (!input) return false;
    if (input.timelineClearRevision !== timelineClearRevision) return false;
    if (input.applyTick > snapshotTick) return false;
    if (nonNegativeInteger(input.eventRevision, 0) > snapshotLastEventRevision) return false;
    return input.timelineRevision === timelineRevision || input.applyTick <= timelineForkTick;
  }

  function markInputsCoveredBySnapshot(snapshotTick, snapshotLastEventRevision) {
    const removed = bodyStateEventTimeline.removeEvents((event) => {
      const input = bodyStateInputFromEvent(event);
      return inputCoveredBySnapshot(input, snapshotTick, snapshotLastEventRevision);
    }, { markApplied: true });
    for (const event of removed) {
      const input = bodyStateInputFromEvent(event);
      if (input.inputId) appliedBodyStateInputIds.add(input.inputId);
    }
    syncBodyStateInputListsFromTimeline();
      for (const [objectId, input] of activeBodyStateHolds.entries()) {
        if (inputCoveredBySnapshot(input, snapshotTick, snapshotLastEventRevision)) {
          activeBodyStateHolds.delete(objectId);
        }
      }
      lastEventRevision = Math.max(lastEventRevision, snapshotLastEventRevision);
      bodyStateEventTimeline.setTimelineState({
        timelineId,
        timelineRevision,
        timelineForkTick,
        timelineClearRevision,
        lastEventRevision,
      }, { resetApplied: false });
    }

  function setAuthoritativeSnapshotBaseline(snapshotTick, snapshotLastEventRevision) {
    if (!world?.snapshot) return;
    authoritativeSnapshotBaseline = {
      tick: snapshotTick,
      timelineId,
      timelineRevision,
      timelineForkTick,
      timelineClearRevision,
      lastEventRevision: snapshotLastEventRevision,
      worldEpochTime,
      snapshot: world.snapshot(),
    };
  }

  function restoreAuthoritativeSnapshotBaseline() {
    const baseline = authoritativeSnapshotBaseline;
    if (!baseline || !world || world.restore(baseline.snapshot) !== true) return false;
    timelineId = baseline.timelineId;
    timelineRevision = baseline.timelineRevision;
    timelineForkTick = baseline.timelineForkTick;
    timelineClearRevision = baseline.timelineClearRevision;
    lastEventRevision = Math.max(lastEventRevision, baseline.lastEventRevision);
    worldEpochTime = baseline.worldEpochTime;
    pendingWorldEpochTime = null;
    previousCollisionPairs = new Set();
    appliedBodyStateInputIds.clear();
    activeBodyStateHolds = new Map();
    bodyStateEventTimeline.setTimelineState({
      timelineId,
      timelineRevision,
      timelineForkTick,
      timelineClearRevision,
      lastEventRevision,
    }, { requeueHistory: true });
    syncBodyStateInputListsFromTimeline();
    return true;
  }

  function applySnapshotReport(payload = {}, clockState = null, options = {}) {
    const localTickBeforeApply = world?.tick ?? -1;
    const remoteHash = typeof payload.hash === 'string' ? payload.hash.trim() : '';
    const bodyCount = Array.isArray(payload.bodies) ? payload.bodies.length : 0;
    let dynamicBodyCount = 0;
    let appliedBodyCount = 0;
    let missingBodyCount = 0;
    let applied = false;

    const payloadTimelineId = normalizeTimelineId(payload.timelineId);
    const payloadTimelineRevision = nonNegativeInteger(payload.timelineRevision, 0);
    const payloadTimelineForkTick = nonNegativeInteger(payload.timelineForkTick, 0);
    const payloadTimelineClearRevision = nonNegativeInteger(payload.timelineClearRevision, 0);
    const payloadLastEventRevision = nonNegativeInteger(payload.lastEventRevision, 0);
    const payloadSceneClockRevision = Number.isFinite(Number(payload.sceneClockRevision))
      ? Math.floor(Number(payload.sceneClockRevision))
      : null;
    const latestSceneClockRevision = Number.isFinite(Number(options.latestSceneClockRevision))
      ? Math.floor(Number(options.latestSceneClockRevision))
      : null;
    const expectedLastEventRevision = payloadTimelineRevision > timelineRevision
      ? getLastEventRevisionAfterTimelineBranch(payloadTimelineRevision, payloadTimelineForkTick)
      : lastEventRevision;
    const payloadTick = nonNegativeInteger(payload.tick, -1);

    const canApply = payload?.kind === 'scene-physics-snapshot'
      && world
      && payload.snapshotVersion === SCENE_SYNC_PHYSICS_SNAPSHOT_VERSION
      && payload.hashVersion === CANONICAL_PHYSICS_HASH_VERSION
      && payload.profile === SCENE_SYNC_RAPIER_PROFILE
      && Array.isArray(payload.bodies)
      && payloadTick >= 0
      && payloadTimelineId === timelineId
      && payloadTimelineRevision >= timelineRevision
      && payloadTimelineClearRevision === timelineClearRevision
      && (payloadSceneClockRevision == null ||
        latestSceneClockRevision == null ||
        payloadSceneClockRevision >= latestSceneClockRevision)
      && payloadLastEventRevision >= expectedLastEventRevision
      && (options.allowSnapshotRewind === true || payloadTick >= localTickBeforeApply);

    if (canApply) {
      const bodyStates = [];
      for (const body of payload.bodies) {
        if (!body || body.type === 'static' || body.type === 'fixed' || body.static === true) continue;
        dynamicBodyCount += 1;
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id || !hasDynamicBody(id)) {
          missingBodyCount += 1;
          continue;
        }
        bodyStates.push({
          id,
          position: readVec3(body.position, [0, 0, 0]),
          rotation: readQuaternion(body.rotation, [0, 0, 0, 1]),
          velocity: readVec3(body.velocity || body.linearVelocity || body.linvel, [0, 0, 0]),
          angularVelocity: readVec3(body.angularVelocity || body.angvel, [0, 0, 0]),
          sleeping: typeof body.sleeping === 'boolean' ? body.sleeping : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        });
      }

      if (missingBodyCount === 0) {
        if (payloadTimelineRevision > timelineRevision) {
          advanceTimelineRevision(payloadTimelineRevision, payloadTimelineForkTick);
        }
        for (const state of bodyStates) {
          if (world.setBodyState?.(state.id, state) === true) {
            appliedBodyCount += 1;
          }
        }
        applied = appliedBodyCount === dynamicBodyCount;
        if (applied) {
          world.setTick?.(payloadTick);
          worldEpochTime = Number.isFinite(Number(payload.worldEpochTime))
            ? Math.max(0, Number(payload.worldEpochTime))
            : Math.max(0, getClockTime(clockState) - payloadTick * Math.max(0.000001, timestepSeconds));
          pendingWorldEpochTime = null;
          previousCollisionPairs = new Set();
          applyWorldToObjects(clockState);
        }
      }
    }

    const localHash = world?.canonicalStateHash?.() || '';
    const hashMatched = applied && remoteHash && localHash && remoteHash === localHash;
    if (hashMatched) {
      markInputsCoveredBySnapshot(payloadTick, payloadLastEventRevision);
      setAuthoritativeSnapshotBaseline(payloadTick, payloadLastEventRevision);
    }
    return {
      kind: 'scene-physics-snapshot',
      snapshotVersion: payload?.snapshotVersion,
      remoteHash,
      localHash,
      hashVersion: payload?.hashVersion,
      profile: payload?.profile,
      rapierCoreVersion: payload?.rapierCoreVersion,
      tick: payloadTick,
      localTick: localTickBeforeApply,
      sceneClockRevision: payloadSceneClockRevision,
      bodyCount,
      dynamicBodyCount,
      appliedBodyCount,
      missingBodyCount,
      applied,
      matched: hashMatched,
    };
  }

  function compareHashReport(payload = {}) {
    const remoteTick = nonNegativeInteger(payload.tick, -1);
    const remoteHash = typeof payload.hash === 'string' ? payload.hash.trim() : '';
    const localTick = world?.tick ?? -1;
    const localHash = world?.canonicalStateHash?.() || '';
    const hashVersionMatched = payload.hashVersion === CANONICAL_PHYSICS_HASH_VERSION;
    const profileMatched = payload.profile === SCENE_SYNC_RAPIER_PROFILE;
    const timelineMatched = normalizeTimelineId(payload.timelineId) === timelineId
      && nonNegativeInteger(payload.timelineRevision, timelineRevision) === timelineRevision
      && nonNegativeInteger(payload.timelineClearRevision, timelineClearRevision) === timelineClearRevision;
    const tickMatched = remoteTick >= 0 && remoteTick === localTick;
    const matched = Boolean(
      remoteHash &&
      localHash &&
      tickMatched &&
      hashVersionMatched &&
      profileMatched &&
      timelineMatched &&
      remoteHash === localHash,
    );
    return {
      kind: 'scene-physics-hash',
      remoteHash,
      localHash,
      hashVersion: payload.hashVersion,
      profile: payload.profile,
      rapierCoreVersion: payload.rapierCoreVersion,
      tick: remoteTick,
      localTick,
      tickMatched,
      hashVersionMatched,
      profileMatched,
      timelineMatched,
      matched,
      sceneClockRevision: Number.isFinite(Number(payload.sceneClockRevision))
        ? Math.floor(Number(payload.sceneClockRevision))
        : null,
    };
  }

  function clearInputHistory(payload = {}) {
    const cleared = bodyStateEventTimeline.clearEventHistory(payload, {
      allowRevisionRegression: true,
    });
    if (!cleared) return false;
    syncBodyStateInputListsFromTimeline();
    activeBodyStateHolds = new Map();
    appliedBodyStateInputIds.clear();
    previousCollisionPairs = new Set();

    if (world && initialSnapshot) {
      resetToInitialPose({ t: 0 });
    }
    markDirty({
      preserveMotion: false,
      worldEpochTime: 0,
    });
    return true;
  }

  function serializeBodyStateInput(input) {
    return {
      kind: 'scene-physics-input',
      inputType: 'set-body-state',
      inputId: input.inputId,
      timelineVersion: SCENE_SYNC_PHYSICS_TIMELINE_VERSION,
      timelineId: input.timelineId,
      timelineRevision: input.timelineRevision,
      timelineClearRevision: input.timelineClearRevision,
      eventRevision: input.eventRevision,
      interactionId: input.interactionId,
      sequence: input.sequence,
      phase: input.phase,
      controlMode: input.controlMode,
      branchTick: input.branchTick,
      objectId: input.objectId,
      applyTick: input.applyTick,
      position: input.position.slice(),
      rotation: input.rotation.slice(),
      velocity: input.velocity.slice(),
      angularVelocity: input.angularVelocity.slice(),
    };
  }

  function serializeBodyStateEvent(input) {
    return cloneJson(bodyStateEventFromInput(input));
  }

  function createInputLogReport(extra = {}) {
    const inputs = bodyStateInputHistory.map(serializeBodyStateInput);
    const events = bodyStateInputHistory.map(serializeBodyStateEvent);
    return {
      kind: 'scene-physics-input-log',
      source: 'physics',
      phase: 'postPhysics',
      eventLogKind: SCENE_SYNC_EVENT_LOG_KIND,
      timelineVersion: SCENE_SYNC_PHYSICS_TIMELINE_VERSION,
      timelineId,
      timelineRevision,
      timelineForkTick,
      timelineClearRevision,
      lastEventRevision,
      eventCount: events.length,
      events,
      inputCount: inputs.length,
      inputs,
      ...extra,
    };
  }

  function inputPayloadCoveredBySnapshot(input, snapshotTick, snapshotLastEventRevision) {
    if (!input) return false;
    const applyTick = nonNegativeInteger(input.applyTick, -1);
    if (applyTick < 0 || applyTick > snapshotTick) return false;
    if (nonNegativeInteger(input.eventRevision, 0) > snapshotLastEventRevision) return false;
    if (normalizeTimelineId(input.timelineId) !== timelineId) return false;
    if (nonNegativeInteger(input.timelineClearRevision, 0) !== timelineClearRevision) return false;
    const inputTimelineRevision = nonNegativeInteger(input.timelineRevision, timelineRevision);
    return inputTimelineRevision === timelineRevision || applyTick <= timelineForkTick;
  }

  function applyInputLogReport(payload = {}, options = {}) {
    const payloadTimelineId = normalizeTimelineId(payload.timelineId);
    const payloadTimelineClearRevision = nonNegativeInteger(payload.timelineClearRevision, timelineClearRevision);
    const inputs = Array.isArray(payload.inputs) ? payload.inputs : [];
    const events = Array.isArray(payload.events) ? payload.events : [];
    const bodyStateEvents = events.filter(isBodyStateSceneEvent);
    const acceptsInputLog = payload?.kind === 'scene-physics-input-log' ||
      payload?.kind === SCENE_SYNC_EVENT_LOG_KIND;
    if (
      !acceptsInputLog ||
      payloadTimelineId !== timelineId ||
      payloadTimelineClearRevision !== timelineClearRevision
    ) {
      return {
        kind: payload?.kind === SCENE_SYNC_EVENT_LOG_KIND
          ? SCENE_SYNC_EVENT_LOG_KIND
          : 'scene-physics-input-log',
        accepted: false,
        eventCount: events.length,
        handledEventCount: bodyStateEvents.length,
        ignoredEventCount: Math.max(0, events.length - bodyStateEvents.length),
        inputCount: inputs.length,
        queuedCount: 0,
      };
    }

    let queuedCount = 0;
    let skippedCoveredCount = 0;
    const snapshotTick = nonNegativeInteger(payload.snapshot?.tick, -1);
    const snapshotLastEventRevision = nonNegativeInteger(payload.snapshot?.lastEventRevision, 0);
    const skipCoveredInputs = options.skipInputsCoveredBySnapshot === true && snapshotTick >= 0;
    const eventRecords = bodyStateEvents.map(event => ({
      payload: event,
      input: bodyStateInputFromEvent(event),
    }));
    const eventInputIds = new Set(eventRecords
      .map(record => record.input?.inputId)
      .filter(Boolean));
    const inputRecords = [
      ...eventRecords,
      ...inputs
        .filter(input => !eventInputIds.has(input?.inputId))
        .map(input => ({ payload: input, input })),
    ];
      for (const { payload: inputPayload, input } of inputRecords) {
        if (skipCoveredInputs && inputPayloadCoveredBySnapshot(input, snapshotTick, snapshotLastEventRevision)) {
          skippedCoveredCount += 1;
          continue;
        }
        if (queueInput(inputPayload)) queuedCount += 1;
      }
    return {
      kind: payload.kind,
      accepted: payload.kind === 'scene-physics-input-log' || inputRecords.length > 0,
      eventCount: events.length,
      handledEventCount: bodyStateEvents.length,
      ignoredEventCount: Math.max(0, events.length - bodyStateEvents.length),
      inputCount: inputRecords.length,
      queuedCount,
      skippedCoveredCount,
      timelineId,
      timelineRevision,
      timelineForkTick,
      timelineClearRevision,
      lastEventRevision,
    };
  }

  function applyDueBodyStateInputs(currentTick = world?.tick || 0) {
    if (!world) return false;
    if (pendingBodyStateInputs.length === 0) {
      return applyActiveBodyStateHolds();
    }

    const processed = bodyStateEventTimeline.processDueEvents(currentTick, (event) => {
      const input = bodyStateInputFromEvent(event);
      if (input.applyTick < currentTick && hasDynamicBody(input.objectId) && rewindBodyStateInputsToInitialSnapshot()) {
        return { replayRequired: true };
      }
      return applyBodyStateInput(input);
    });
    syncBodyStateInputListsFromTimeline();
    let applied = processed.applied;
    if (applyActiveBodyStateHolds()) {
      applied = true;
    }
    return applied;
  }

  function hasDynamicBody(objectId) {
    const body = world?.getBody?.(objectId);
    return Boolean(body && body.static !== true);
  }

  function rewindBodyStateInputsToInitialSnapshot() {
    if (!world || !initialSnapshot || world.restore(initialSnapshot) !== true) {
      return false;
    }
    previousCollisionPairs = new Set();
    appliedBodyStateInputIds.clear();
    activeBodyStateHolds = new Map();
    bodyStateEventTimeline.resetAppliedFromHistory();
    syncBodyStateInputListsFromTimeline();
    return true;
  }

  function updateActiveBodyStateHold(input) {
    if (!input?.objectId) return;
    // The runtime core is phase-agnostic: it only honors the generic control
    // mode. 'hold' keeps re-applying the body state every tick until a matching
    // 'release' arrives. Inputs without a control mode are one-shot and leave
    // any existing hold untouched.
    if (input.controlMode === 'hold') {
      activeBodyStateHolds.set(input.objectId, input);
    } else if (input.controlMode === 'release') {
      activeBodyStateHolds.delete(input.objectId);
    }
  }

  function applyActiveBodyStateHolds() {
    if (!world || activeBodyStateHolds.size === 0) return false;
    let applied = false;
    for (const input of Array.from(activeBodyStateHolds.values())
      .sort((left, right) => compareStrings(left.objectId, right.objectId))) {
      applied = world.setBodyState?.(input.objectId, input) === true || applied;
    }
    return applied;
  }

  function applyBodyStateInput(input) {
    if (!input?.inputId || appliedBodyStateInputIds.has(input.inputId) || !world) {
      return false;
    }
    const applied = world.setBodyState?.(input.objectId, input) === true;
    if (applied) {
      appliedBodyStateInputIds.add(input.inputId);
      updateActiveBodyStateHold(input);
    }
    return applied;
  }

  function update(clockState = null) {
    const scenePhysics = normalizeScenePhysics(getScenePhysics?.());
    if (!scenePhysics.enabled) {
      clear();
      return { active: false, reason: 'disabled' };
    }

    if (!isClockActive(clockState)) {
      const reset = resetActiveToInitialPose(clockState);
      return { active: false, reason: 'clock-inactive', reset };
    }

    if (dirty || !world) {
      const rebuildResult = rebuild(clockState);
      if (!rebuildResult.ok) {
        return { active: false, reason: rebuildResult.reason };
      }
    }

    const clockTime = getClockTime(clockState);
    const worldAge = getWorldAge(clockState);
    const targetTick = Math.max(0, Math.floor(worldAge / timestepSeconds));
    if (targetTick < world.tick && initialSnapshot) {
      rewindBodyStateInputsToInitialSnapshot();
    }
    if (
      authoritativeSnapshotBaseline &&
      world.tick < authoritativeSnapshotBaseline.tick &&
      targetTick >= authoritativeSnapshotBaseline.tick
    ) {
      restoreAuthoritativeSnapshotBaseline();
    }
    const stepResult = world.stepTo(targetTick, { beforeStep: applyDueBodyStateInputs });
    if (stepResult?.limited === true) {
      active = false;
      previousCollisionPairs = new Set();
      return {
        active: false,
        reason: stepResult.reason || 'step-limit',
        tick: world.tick,
        limited: true,
        reached: false,
        events: [],
      };
    }
    applyActiveBodyStateHolds();
    applyWorldToObjects(clockState);
    active = true;

    // Collect collision events via EventQueue diff (enter / exit only, no stay)
    const collisionEvents = [];
    if (typeof world.drainCollisionEvents === 'function') {
      const currentPairs = new Set(previousCollisionPairs);
      world.drainCollisionEvents((objectIdA, objectIdB, started) => {
        const pairKey = createCollisionPairKey(objectIdA, objectIdB);
        if (!pairKey) return;
        if (started) {
          currentPairs.add(pairKey);
        } else {
          currentPairs.delete(pairKey);
        }
      });

      const currentTick = world.tick;
      for (const pairKey of currentPairs) {
        if (!previousCollisionPairs.has(pairKey)) {
          const [a, b] = pairKey.split('|');
          collisionEvents.push({
            type: 'physics.collision.enter',
            objectIdA: a,
            objectIdB: b,
            pairKey,
            tick: currentTick,
          });
        }
      }
      for (const pairKey of previousCollisionPairs) {
        if (!currentPairs.has(pairKey)) {
          const [a, b] = pairKey.split('|');
          collisionEvents.push({
            type: 'physics.collision.exit',
            objectIdA: a,
            objectIdB: b,
            pairKey,
            tick: currentTick,
          });
        }
      }
      previousCollisionPairs = currentPairs;
    }

    const stateHash = world.canonicalStateHash();
    return {
      active: true,
      tick: world.tick,
      timestep: world.timestep || timestepSeconds,
      activeTime: clockTime,
      worldAge,
      worldEpochTime,
      timelineVersion: SCENE_SYNC_PHYSICS_TIMELINE_VERSION,
      timelineId,
      timelineRevision,
      timelineForkTick,
      timelineClearRevision,
      lastEventRevision,
      profile: SCENE_SYNC_RAPIER_PROFILE,
      hashVersion: CANONICAL_PHYSICS_HASH_VERSION,
      rapierCoreVersion: RAPIER_CORE_VERSION,
      stateHash,
      hash: stateHash,
      limited: stepResult?.limited === true,
      reached: stepResult?.reached !== false,
      events: collisionEvents,
    };
  }

  function createSnapshotReport(clockState = null) {
    if (!world) return null;

    const dump = world.canonicalStateDump();
    const clockTime = getClockTime(clockState);
    const worldAge = getWorldAge(clockState);
    const stateHash = world.canonicalStateHash();
    const bodies = Array.isArray(dump.bodies)
      ? dump.bodies.map((body) => ({
          id: body.id,
          type: body.type,
          position: body.position,
          rotation: body.rotation,
          velocity: body.linvel,
          angularVelocity: body.angvel,
          sleeping: body.sleeping,
          enabled: body.enabled,
        }))
      : [];

    return {
      kind: 'scene-physics-snapshot',
      source: 'physics',
      phase: 'postPhysics',
      snapshotVersion: SCENE_SYNC_PHYSICS_SNAPSHOT_VERSION,
      timelineVersion: SCENE_SYNC_PHYSICS_TIMELINE_VERSION,
      timelineId,
      timelineRevision,
      timelineForkTick,
      timelineClearRevision,
      lastEventRevision,
      profile: SCENE_SYNC_RAPIER_PROFILE,
      hashVersion: CANONICAL_PHYSICS_HASH_VERSION,
      rapierCoreVersion: RAPIER_CORE_VERSION,
      tick: world.tick,
      hash: stateHash,
      timestep: world.timestep || timestepSeconds,
      activeTime: clockTime,
      worldAge,
      worldEpochTime,
      bodyCount: bodies.length,
      bodies,
    };
  }

  return {
    markDirty,
    queueInput,
    clearInputHistory,
    applySnapshotReport,
    compareHashReport,
    createInputLogReport,
    applyInputLogReport,
    rebuild,
    update,
    createSnapshotReport,
    resetToInitialPose,
    resetActiveToInitialPose,
    getInitialBodyPoses,
    getTimelineState() {
      return {
        timelineVersion: SCENE_SYNC_PHYSICS_TIMELINE_VERSION,
        timelineId,
        timelineRevision,
        timelineForkTick,
        timelineClearRevision,
        lastEventRevision,
      };
    },
    hasBodies() {
      if (dirty || !world) {
        return collectRuntimeEntries(getObjectEntries?.()).length > 0;
      }
      return entryMap.size > 0;
    },
    hasDynamicBody,
    getTick() {
      return world?.tick ?? 0;
    },
    getDynamicBodyState(objectId) {
      if (!hasDynamicBody(objectId)) return null;
      const body = world?.getBody?.(objectId);
      return body ? cloneJson(body) : null;
    },
    dispose() {
      clear();
    },
  };
}
