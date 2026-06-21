import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import {
  RAPIER_BUILD_FLAVOR,
  createWorld,
  computeRapierWorldStateHash,
  initRapierPhysics,
  normalizeRapierWorldOptions,
  stableIdHashHex,
} from './rapier-world.js';

before(async () => {
  await initRapierPhysics();
});

function makeWorld() {
  const world = createWorld({
    gravity: -9.81,
    ground: { y: 0, restitution: 0.2, friction: 0.5 },
    timestep: 1 / 60,
  });
  world.addBody({
    id: 'box',
    shape: 'box',
    halfExtents: [0.5, 0.5, 0.5],
    position: [0, 4, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0.25, 0, 0],
    angularVelocity: [0, 0, 0],
    mass: 1,
    restitution: 0.2,
    friction: 0.5,
  });
  world.addBody({
    id: 'ball',
    shape: 'sphere',
    radius: 0.35,
    position: [0, 6, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    mass: 1,
    restitution: 0.4,
    friction: 0.5,
  });
  return world;
}

test('normalizes Rapier world options with seconds-based timestep', () => {
  assert.deepEqual(normalizeRapierWorldOptions({
    gravity: -9.81,
    ground: { y: 0 },
    timestep: 1 / 120,
  }), {
    engine: 'rapier',
    gravity: [0, -9.81, 0],
    ground: { y: 0, restitution: 0.2, friction: 0.5 },
    timestep: 1 / 120,
    maxStepsPerUpdate: 900,
    checkpointIntervalTicks: 120,
  });
});

test('uses the deterministic Rapier build flavor', () => {
  assert.equal(RAPIER_BUILD_FLAVOR, 'deterministic-compat');
});

test('same Rapier inputs produce the same state hash, canonical hash, and networkStateHash', () => {
  const a = makeWorld();
  const b = makeWorld();

  a.stepTo(180);
  b.stepTo(180);

  assert.equal(a.stateHash(), b.stateHash());
  assert.equal(a.canonicalStateHash(), b.canonicalStateHash());
  assert.equal(a.networkStateHash(), b.networkStateHash());
  assert.equal(typeof a.networkStateHash(), 'string');
  assert.equal(a.networkStateHash().length, 8);
  assert.deepEqual(a.getBodies(), b.getBodies());

  a.free();
  b.free();
});

test('Rapier snapshot restore reproduces the same future', () => {
  const a = makeWorld();
  a.stepTo(90);
  const snapshot = a.snapshot();
  const expected = a.getBody('box');

  const b = makeWorld();
  assert.equal(b.restore(snapshot), true);
  assert.deepEqual(b.getBody('box'), expected);

  a.stepTo(180);
  b.stepTo(180);
  assert.equal(a.stateHash(), b.stateHash());
  assert.equal(a.canonicalStateHash(), b.canonicalStateHash());

  a.free();
  b.free();
});

test('snapshot restore replaces stale body metadata with snapshot stable ids', () => {
  const a = createWorld({ gravity: -9.81, ground: null, timestep: 1 / 60 });
  const b = createWorld({ gravity: -9.81, ground: null, timestep: 1 / 60 });
  const box = {
    id: 'box',
    shape: 'box',
    halfExtents: [0.5, 0.5, 0.5],
    position: [0, 4, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0.25, 0, 0],
    angularVelocity: [0, 0, 0],
    mass: 1,
  };
  const ball = {
    id: 'ball',
    shape: 'sphere',
    radius: 0.35,
    position: [0, 6, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    mass: 1,
  };

  a.addBody(box);
  a.addBody(ball);
  b.addBody(ball);
  b.addBody(box);
  a.stepTo(30);

  assert.equal(b.restore(a.snapshot()), true);
  assert.deepEqual(b.getBody('box'), a.getBody('box'));
  assert.deepEqual(b.getBody('ball'), a.getBody('ball'));
  assert.equal(b.canonicalStateHash(), a.canonicalStateHash());

  a.free();
  b.free();
});

test('canonical hash is sorted by stable body id instead of creation order', () => {
  const a = createWorld({ gravity: -9.81, ground: null, timestep: 1 / 60 });
  const b = createWorld({ gravity: -9.81, ground: null, timestep: 1 / 60 });
  const box = {
    id: 'box',
    shape: 'box',
    halfExtents: [0.5, 0.5, 0.5],
    position: [0, 4, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    mass: 1,
  };
  const ball = {
    id: 'ball',
    shape: 'sphere',
    radius: 0.5,
    position: [0, 8, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    mass: 1,
  };

  a.addBody(box);
  a.addBody(ball);
  b.addBody(ball);
  b.addBody(box);

  assert.equal(a.canonicalStateHash(), b.canonicalStateHash());
  assert.match(stableIdHashHex('box'), /^[0-9a-f]{16}$/);

  a.free();
  b.free();
});

test('canonical hash includes body step settings and collider material fields', () => {
  const base = {
    id: 'box',
    shape: 'box',
    halfExtents: [0.5, 0.5, 0.5],
    position: [0, 4, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    mass: 1,
  };
  const a = createWorld({ gravity: -9.81, ground: null, timestep: 1 / 60 });
  const b = createWorld({ gravity: -9.81, ground: null, timestep: 1 / 60 });
  const c = createWorld({ gravity: -9.81, ground: null, timestep: 1 / 60 });

  a.addBody({ ...base, friction: 0.5, restitution: 0.2 });
  b.addBody({ ...base, friction: 0.8, restitution: 0.2 });
  c.addBody({
    ...base,
    friction: 0.5,
    restitution: 0.2,
    gravityScale: 0.5,
    linearDamping: 0.25,
    angularDamping: 0.5,
    canSleep: false,
    ccd: true,
    softCcdPrediction: 0.1,
  });

  assert.notEqual(a.canonicalStateHash(), b.canonicalStateHash());
  assert.notEqual(a.canonicalStateHash(), c.canonicalStateHash());

  a.free();
  b.free();
  c.free();
});

test('canonical hash matches Unity Rapier native hash for a bridge-compatible box', () => {
  const world = createWorld({ gravity: [0, -9.81, 0], ground: null, timestep: 0.016666667 });
  world.addBody({
    id: 'hash-body-a',
    shape: 'box',
    mass: 1,
    density: 1,
    halfExtents: [0.5, 0.5, 0.5],
    position: [0, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    friction: 0.5,
    restitution: 0.2,
    linearDamping: 0,
    angularDamping: 0,
    canSleep: false,
    ccd: false,
    frictionCombineRule: 0,
    restitutionCombineRule: 0,
  });

  assert.equal(world.canonicalStateHash(), '417f10e857ac4668');
  assert.equal(world.canonicalStateDump().bodies[0].gravityScale, 1);
  assert.equal(world.canonicalStateDump().bodies[0].softCcdPrediction, 0);

  world.free();
});

test('stateHash remains tick and snapshot sensitive', () => {
  const world = createWorld({ gravity: -9.81, ground: null, timestep: 1 / 60 });
  const before = world.stateHash();

  world.step();

  assert.notEqual(world.stateHash(), before);
  world.free();
});

test('computeRapierWorldStateHash returns same hex string for two identically-stepped RAPIER worlds (deterministic build)', async () => {
  // Import the module-level RAPIER singleton, already initialized by before().
  const mod = await import('@dimforge/rapier3d-deterministic-compat');
  const RAPIER = mod.default ?? mod;

  function makeRawWorld() {
    const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(0.5, 5, -0.5);
    const body = w.createRigidBody(bodyDesc);
    const collider = RAPIER.ColliderDesc.ball(0.35).setRestitution(0.5).setFriction(0.5).setMass(1);
    w.createCollider(collider, body);
    for (let i = 0; i < 180; i++) w.step();
    return w;
  }

  const wA = makeRawWorld();
  const wB = makeRawWorld();

  const hashA = computeRapierWorldStateHash(wA);
  const hashB = computeRapierWorldStateHash(wB);

  assert.equal(typeof hashA, 'string');
  assert.equal(hashA.length, 8, 'hash should be 8-char hex');
  assert.equal(hashA, hashB, 'deterministic build: same inputs must produce identical state hash');

  wA.free();
  wB.free();
});

test('stepTo caps very long fast-forward work', () => {
  const world = createWorld({
    gravity: -9.81,
    ground: null,
    timestep: 1 / 60,
    maxStepsPerUpdate: 10,
  });
  world.addBody({
    id: 'ball',
    shape: 'sphere',
    radius: 0.5,
    position: [0, 2, 0],
    mass: 1,
  });

  const result = world.stepTo(100);
  assert.equal(result.limited, true);
  assert.equal(world.tick, 0);

  world.free();
});
