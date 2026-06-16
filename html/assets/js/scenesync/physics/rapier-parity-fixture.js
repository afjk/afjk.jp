import {
  CANONICAL_PHYSICS_HASH_VERSION,
  RAPIER_BUILD_FLAVOR,
  RAPIER_CORE_VERSION,
  createWorld,
} from './rapier-world.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readVec3(value, fallback = [0, 0, 0]) {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [
    finiteNumber(value[0], fallback[0]),
    finiteNumber(value[1], fallback[1]),
    finiteNumber(value[2], fallback[2]),
  ];
}

function readQuat(value, fallback = [0, 0, 0, 1]) {
  if (!Array.isArray(value) || value.length < 4) return [...fallback];
  return [
    finiteNumber(value[0], fallback[0]),
    finiteNumber(value[1], fallback[1]),
    finiteNumber(value[2], fallback[2]),
    finiteNumber(value[3], fallback[3]),
  ];
}

function readSampleTicks(value) {
  if (!Array.isArray(value)) return [0];
  return Array.from(new Set(value
    .map((tick) => Number(tick))
    .filter((tick) => Number.isInteger(tick) && tick >= 0)))
    .sort((left, right) => left - right);
}

function fixtureBodies(fixture) {
  return [...(Array.isArray(fixture?.bodies) ? fixture.bodies : [])]
    .filter((body) => typeof body?.id === 'string' && body.id.length > 0);
}

function bodyDefFromFixture(body) {
  const isFixed = body.type === 'fixed' || body.static === true || body.density === 0;
  return {
    id: body.id,
    shape: body.shape === 'sphere' ? 'sphere' : 'box',
    static: isFixed,
    mass: isFixed ? 0 : finiteNumber(body.mass, finiteNumber(body.density, 1)),
    density: finiteNumber(body.density, isFixed ? 0 : 1),
    radius: finiteNumber(body.radius, 0.5),
    halfExtents: readVec3(body.halfExtents, [0.5, 0.5, 0.5]),
    position: readVec3(body.position, [0, 0, 0]),
    rotation: readQuat(body.rotation, [0, 0, 0, 1]),
    velocity: readVec3(body.linearVelocity || body.velocity, [0, 0, 0]),
    angularVelocity: readVec3(body.angularVelocity, [0, 0, 0]),
    linearDamping: finiteNumber(body.linearDamping, 0),
    angularDamping: finiteNumber(body.angularDamping, 0),
    canSleep: body.canSleep !== false,
    ccd: body.ccd === true,
    friction: finiteNumber(body.friction, 0.5),
    restitution: finiteNumber(body.restitution, 0.2),
    frictionCombineRule: Number.isInteger(body.frictionCombineRule) ? body.frictionCombineRule : 0,
    restitutionCombineRule: Number.isInteger(body.restitutionCombineRule) ? body.restitutionCombineRule : 0,
  };
}

export function createRapierParityWorldFromFixture(fixture) {
  if (!isObject(fixture)) {
    throw new TypeError('Rapier parity fixture must be an object.');
  }
  if (fixture.rapierCoreVersion !== RAPIER_CORE_VERSION) {
    throw new Error(`Fixture Rapier core ${fixture.rapierCoreVersion} does not match browser core ${RAPIER_CORE_VERSION}.`);
  }

  const world = createWorld({
    gravity: readVec3(fixture.gravity, [0, -9.81, 0]),
    timestep: finiteNumber(fixture.timestep, 1 / 60),
    ground: null,
  });

  for (const body of fixtureBodies(fixture)) {
    world.addBody(bodyDefFromFixture(body));
  }

  return world;
}

export function createRapierParityResult(fixture, options = {}) {
  const host = options.host || 'browser';
  const includeDumps = options.includeDumps !== false;
  const fixturePath = options.fixturePath || 'fixtures/rapier/parity-basic-001.json';
  const sampleTicks = readSampleTicks(fixture?.sampleTicks);
  const hashes = {};
  const dumps = {};
  const world = createRapierParityWorldFromFixture(fixture);

  try {
    for (const tick of sampleTicks) {
      const result = world.stepTo(tick);
      if (result.reached === false) {
        throw new Error(`Could not step parity fixture to tick ${tick}: ${result.reason || 'unknown'}.`);
      }
      hashes[String(tick)] = world.canonicalStateHash();
      if (includeDumps) dumps[String(tick)] = world.canonicalStateDump();
    }

    return {
      host,
      profile: fixture.profile,
      rapierCoreVersion: RAPIER_CORE_VERSION,
      buildFlavor: RAPIER_BUILD_FLAVOR,
      hashVersion: CANONICAL_PHYSICS_HASH_VERSION,
      fixture: fixturePath,
      sampleTicks,
      hashes,
      ...(includeDumps ? { dumps } : {}),
    };
  } finally {
    world.free();
  }
}
