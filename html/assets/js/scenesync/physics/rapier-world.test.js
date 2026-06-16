import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld,
  computeRapierWorldStateHash,
  initRapierPhysics,
  normalizeRapierWorldOptions,
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

test('same Rapier inputs produce the same state hash', () => {
  const a = makeWorld();
  const b = makeWorld();

  a.stepTo(180);
  b.stepTo(180);

  assert.equal(a.stateHash(), b.stateHash());
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

  a.free();
  b.free();
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
