import { createWorld, DEFAULT_TIMESTEP_FP } from './physics/index.js';

export const DEFAULT_SCENE_PHYSICS_DURATION = 10;
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
    timestepFp: DEFAULT_TIMESTEP_FP,
  },
});

const BODY_TYPES = new Set(['dynamic', 'static']);
const SHAPES = new Set(['box', 'sphere']);

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
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

  return {
    gravity,
    ground: normalizeGround(source.ground),
    timestepFp: Number.isInteger(source.timestepFp) && source.timestepFp > 0
      ? source.timestepFp
      : DEFAULT_TIMESTEP_FP,
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

  if (shape === 'sphere' && Number.isFinite(Number(input.radius))) {
    physics.radius = positiveNumber(input.radius, 0.5);
  }
  if (shape === 'box' && Array.isArray(input.halfExtents)) {
    physics.halfExtents = readPositiveVec3(input.halfExtents, [0.5, 0.5, 0.5]);
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

function inferShape(physics, object) {
  if (physics?.shape === 'sphere') return 'sphere';
  if (physics?.shape === 'box') return 'box';
  return object?.userData?.asset?.primitive === 'sphere' ? 'sphere' : 'box';
}

export function buildPhysicsBodyDef({ objectId, object, physics }) {
  const normalized = normalizeObjectPhysics(physics);
  if (!objectId || !object || !normalized) return null;

  const scale = getScaleArray(object).map((component) => Math.abs(component || 1));
  const shape = inferShape(normalized, object);
  const body = {
    id: objectId,
    shape,
    position: getPositionArray(object),
    velocity: normalized.bodyType === 'static'
      ? [0, 0, 0]
      : readVec3(normalized.velocity, [0, 0, 0]),
    mass: normalized.bodyType === 'static' ? 0 : normalized.mass,
    static: normalized.bodyType === 'static',
    restitution: normalized.restitution,
    friction: normalized.friction,
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

function applyBodyPosition(object, body) {
  if (!object || !body?.position) return;
  if (typeof object.position?.fromArray === 'function') {
    object.position.fromArray(body.position);
  } else if (object.position) {
    object.position.x = body.position[0];
    object.position.y = body.position[1];
    object.position.z = body.position[2];
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

export function createScenePhysicsRuntime({
  getScenePhysics,
  getObjectEntries,
  isClockActive = (clockState) => clockState?.transportActive === true,
} = {}) {
  let dirty = true;
  let world = null;
  let initialSnapshot = null;
  let entryMap = new Map();
  let active = false;
  let timestepSeconds = DEFAULT_TIMESTEP_FP / 65536;

  function clear() {
    world = null;
    initialSnapshot = null;
    entryMap = new Map();
    active = false;
    timestepSeconds = DEFAULT_TIMESTEP_FP / 65536;
  }

  function markDirty() {
    dirty = true;
  }

  function rebuild() {
    const scenePhysics = normalizeScenePhysics(getScenePhysics?.());
    const entries = collectRuntimeEntries(getObjectEntries?.());
    if (!scenePhysics.enabled || entries.length === 0) {
      clear();
      dirty = false;
      return false;
    }

    world = createWorld(scenePhysics.worldOptions);
    timestepSeconds = world.timestepFp / 65536;
    entryMap = new Map();

    for (const entry of entries) {
      const body = buildPhysicsBodyDef(entry);
      if (!body) continue;
      world.addBody(body);
      entryMap.set(entry.objectId, entry);
    }

    initialSnapshot = world.snapshot();
    dirty = false;
    return entryMap.size > 0;
  }

  function applyWorldToObjects() {
    if (!world) return;
    for (const [objectId, entry] of entryMap) {
      const body = world.getBody(objectId);
      if (!body || body.static) continue;
      applyBodyPosition(entry.object, body);
    }
  }

  function resetToInitialPose() {
    if (!world || !initialSnapshot) return false;
    world.restore(initialSnapshot);
    applyWorldToObjects();
    return true;
  }

  function resetActiveToInitialPose() {
    if (!active) return false;
    const reset = resetToInitialPose();
    if (reset) active = false;
    return reset;
  }

  function update(clockState = null) {
    const scenePhysics = normalizeScenePhysics(getScenePhysics?.());
    if (!scenePhysics.enabled) {
      clear();
      return { active: false, reason: 'disabled' };
    }

    if (!isClockActive(clockState)) {
      const reset = resetActiveToInitialPose();
      return { active: false, reason: 'clock-inactive', reset };
    }

    if (dirty || !world) {
      if (!rebuild()) {
        return { active: false, reason: 'no-bodies' };
      }
    }

    const targetTime = Math.max(0, Number(clockState?.t) || 0);
    const targetTick = Math.max(0, Math.floor(targetTime / timestepSeconds));
    if (targetTick < world.tick && initialSnapshot) {
      world.restore(initialSnapshot);
    }
    world.stepTo(targetTick);
    applyWorldToObjects();
    active = true;
    return { active: true, tick: world.tick };
  }

  return {
    markDirty,
    rebuild,
    update,
    resetToInitialPose,
    resetActiveToInitialPose,
    hasBodies() {
      if (dirty || !world) {
        return collectRuntimeEntries(getObjectEntries?.()).length > 0;
      }
      return entryMap.size > 0;
    },
    dispose() {
      clear();
    },
  };
}
