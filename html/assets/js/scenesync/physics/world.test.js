import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld } from './world.js';

function buildWorld() {
  const world = createWorld({ ground: { y: 0, restitution: 0.4, friction: 0.5 } });
  world.addBody({ id: 'ball-1', shape: 'sphere', radius: 0.5, position: [0, 3, 0], mass: 1, restitution: 0.6 });
  world.addBody({ id: 'ball-2', shape: 'sphere', radius: 0.5, position: [0.4, 5, 0.2], mass: 2 });
  world.addBody({ id: 'crate', shape: 'box', halfExtents: [0.5, 0.5, 0.5], position: [2, 4, 0], mass: 5 });
  world.addBody({ id: 'plinth', shape: 'box', halfExtents: [3, 0.5, 3], position: [0, 0.5, 0], static: true });
  return world;
}

test('gravity pulls a free body down', () => {
  const world = createWorld({ ground: null });
  world.addBody({ id: 'ball', shape: 'sphere', position: [0, 10, 0] });
  for (let i = 0; i < 60; i += 1) world.step();
  const body = world.getBody('ball');
  assert.ok(body.position[1] < 10);
  assert.ok(body.velocity[1] < -5);
});

test('a sphere settles on the ground plane and falls asleep', () => {
  const world = createWorld({ ground: { y: 0 } });
  world.addBody({ id: 'ball', shape: 'sphere', radius: 0.5, position: [0, 2, 0] });
  for (let i = 0; i < 600; i += 1) world.step();
  const body = world.getBody('ball');
  assert.ok(Math.abs(body.position[1] - 0.5) < 0.05, `rest height was ${body.position[1]}`);
  assert.equal(body.sleeping, true);

  // Sleeping bodies stay frozen exactly
  const before = world.snapshot();
  for (let i = 0; i < 100; i += 1) world.step();
  const ball = world.snapshot().bodies.find((b) => b.id === 'ball');
  const ballBefore = before.bodies.find((b) => b.id === 'ball');
  assert.deepEqual(ball.positionFp, ballBefore.positionFp);
});

test('restitution makes a sphere bounce back up', () => {
  const world = createWorld({ ground: { y: 0, restitution: 0.9 } });
  world.addBody({ id: 'ball', shape: 'sphere', radius: 0.5, position: [0, 3, 0], restitution: 0.9 });
  let bounced = false;
  for (let i = 0; i < 120; i += 1) {
    world.step();
    if (world.getBody('ball').velocity[1] > 1) {
      bounced = true;
      break;
    }
  }
  assert.equal(bounced, true);
});

test('a moving sphere transfers momentum to a resting sphere', () => {
  const world = createWorld({ ground: { y: 0, friction: 0 } });
  world.addBody({ id: 'cue', shape: 'sphere', radius: 0.5, position: [-2, 0.5, 0], velocity: [4, 0, 0], friction: 0 });
  world.addBody({ id: 'target', shape: 'sphere', radius: 0.5, position: [0, 0.5, 0], friction: 0 });
  for (let i = 0; i < 120; i += 1) world.step();
  const target = world.getBody('target');
  assert.ok(target.velocity[0] > 0.5 || target.position[0] > 0.2,
    `target did not move: v=${target.velocity[0]} x=${target.position[0]}`);
});

test('a dynamic box rests on top of a static box', () => {
  const world = createWorld({ ground: { y: 0 } });
  world.addBody({ id: 'base', shape: 'box', halfExtents: [2, 0.5, 2], position: [0, 0.5, 0], static: true });
  world.addBody({ id: 'crate', shape: 'box', halfExtents: [0.5, 0.5, 0.5], position: [0, 3, 0] });
  for (let i = 0; i < 600; i += 1) world.step();
  const crate = world.getBody('crate');
  assert.ok(Math.abs(crate.position[1] - 1.5) < 0.05, `rest height was ${crate.position[1]}`);
  assert.equal(crate.sleeping, true);
});

test('a sphere starting inside a box is pushed out and settles on top', () => {
  const world = createWorld({ ground: { y: 0 } });
  world.addBody({ id: 'block', shape: 'box', halfExtents: [1, 1, 1], position: [0, 1, 0], static: true });
  world.addBody({ id: 'ball', shape: 'sphere', radius: 0.5, position: [0, 1.9, 0] });
  for (let i = 0; i < 600; i += 1) world.step();
  const ball = world.getBody('ball');
  assert.ok(Number.isFinite(ball.position[1]));
  assert.ok(Math.abs(ball.position[1] - 2.5) < 0.1, `rest height was ${ball.position[1]}`);
});

test('applyImpulse changes velocity by impulse / mass and wakes the body', () => {
  const world = createWorld({ ground: { y: 0 } });
  world.addBody({ id: 'ball', shape: 'sphere', radius: 0.5, position: [0, 0.5, 0], mass: 2 });
  for (let i = 0; i < 600; i += 1) world.step();
  assert.equal(world.getBody('ball').sleeping, true);

  assert.equal(world.applyImpulse('ball', [4, 0, 0]), true);
  const body = world.getBody('ball');
  assert.equal(body.sleeping, false);
  assert.equal(body.velocity[0], 2);

  assert.equal(world.applyImpulse('missing', [1, 0, 0]), false);
});

test('velocities and positions are clamped to safe bounds', () => {
  const world = createWorld({ ground: null });
  world.addBody({ id: 'fast', shape: 'sphere', position: [0, 9999999, 0], velocity: [99999, 0, 0] });
  const body = world.getBody('fast');
  assert.equal(body.velocity[0], 256);
  assert.equal(body.position[1], 4096);
});

test('identical operations on two worlds stay bit-identical', () => {
  const a = buildWorld();
  const b = buildWorld();
  for (let i = 0; i < 600; i += 1) {
    if (i === 120) {
      a.applyImpulse('ball-1', [3, 4, 0]);
      b.applyImpulse('ball-1', [3, 4, 0]);
    }
    if (i === 200) {
      a.removeBody('crate');
      b.removeBody('crate');
    }
    a.step();
    b.step();
  }
  assert.equal(a.stateHash(), b.stateHash());
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test('snapshot / restore reproduces the exact same future', () => {
  const a = buildWorld();
  for (let i = 0; i < 100; i += 1) a.step();
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  for (let i = 0; i < 100; i += 1) a.step();
  const expectedHash = a.stateHash();

  const b = createWorld({ ground: { y: 0, restitution: 0.4, friction: 0.5 } });
  b.restore(snap);
  assert.equal(b.tick, 100);
  for (let i = 0; i < 100; i += 1) b.step();
  assert.equal(b.stateHash(), expectedHash);
});

test('adding a body with an existing id replaces it', () => {
  const world = createWorld({});
  world.addBody({ id: 'thing', shape: 'sphere', position: [0, 1, 0] });
  world.addBody({ id: 'thing', shape: 'box', position: [5, 1, 0] });
  assert.equal(world.getBodies().length, 1);
  const body = world.getBody('thing');
  assert.equal(body.shape, 'box');
  assert.equal(body.position[0], 5);
});

test('teleport and setVelocity update state and report missing bodies', () => {
  const world = createWorld({ ground: null });
  world.addBody({ id: 'ball', shape: 'sphere', position: [0, 1, 0] });
  assert.equal(world.teleport('ball', [1, 2, 3]), true);
  assert.deepEqual(world.getBody('ball').position, [1, 2, 3]);
  assert.equal(world.setVelocity('ball', [0, 5, 0]), true);
  assert.deepEqual(world.getBody('ball').velocity, [0, 5, 0]);
  assert.equal(world.teleport('missing', [0, 0, 0]), false);
  assert.equal(world.setVelocity('missing', [0, 0, 0]), false);
});

test('stateHash changes when the simulation state changes', () => {
  const world = buildWorld();
  const h0 = world.stateHash();
  world.step();
  assert.notEqual(world.stateHash(), h0);
});

test('stateHash covers material parameters, not just position and velocity', () => {
  const make = (overrides) => {
    const world = createWorld({ ground: null });
    world.addBody({ id: 'ball', shape: 'sphere', position: [0, 1, 0], ...overrides });
    return world.stateHash();
  };
  const base = make({});
  assert.notEqual(make({ restitution: 0.9 }), base);
  assert.notEqual(make({ friction: 0.1 }), base);
  assert.notEqual(make({ mass: 5 }), base);
  assert.notEqual(make({ radius: 0.7 }), base);
  assert.notEqual(make({ shape: 'box' }), base);
});

test('stateHash covers world configuration', () => {
  const hashFor = (options) => {
    const world = createWorld(options);
    world.addBody({ id: 'ball', shape: 'sphere', position: [0, 1, 0] });
    return world.stateHash();
  };
  const base = hashFor({ ground: { y: 0 } });
  assert.notEqual(hashFor({ ground: null }), base);
  assert.notEqual(hashFor({ ground: { y: 1 } }), base);
  assert.notEqual(hashFor({ ground: { y: 0 }, gravity: -5 }), base);
  assert.notEqual(hashFor({ ground: { y: 0 }, timestepFp: 2184 }), base);
});

test('stateHash covers sleepCounter progress', () => {
  const a = createWorld({ ground: { y: 0 } });
  a.addBody({ id: 'ball', shape: 'sphere', radius: 0.5, position: [0, 0.5, 0] });
  const b = createWorld({ ground: { y: 0 } });
  b.addBody({ id: 'ball', shape: 'sphere', radius: 0.5, position: [0, 0.5, 0] });
  for (let i = 0; i < 10; i += 1) { a.step(); b.step(); }
  assert.equal(a.stateHash(), b.stateHash());
  const snapA = a.snapshot();
  const snapB = b.snapshot();
  assert.equal(snapA.bodies[0].sleepCounter, snapB.bodies[0].sleepCounter);
  // Worlds whose only difference is sleep progress must not hash-collide
  snapB.bodies[0].sleepCounter += 1;
  b.restore(snapB);
  assert.notEqual(a.stateHash(), b.stateHash());
});

test('addBodyRecord and raw mutators sanitize network input deterministically', () => {
  const world = createWorld({ ground: null });
  assert.equal(world.addBodyRecord(null), null);
  assert.equal(world.addBodyRecord({ id: '' }), null);
  const added = world.addBodyRecord({
    id: 'ball',
    shape: 'sphere',
    radiusFp: 32768,
    positionFp: [0, 65536, 0],
    velocityFp: ['bogus', 1.5, 2 ** 60],
    invMassFp: 65536,
    restitutionFp: 99999999,
    frictionFp: -5,
  });
  assert.deepEqual(added.velocity, [0, 0, 0]);
  assert.equal(world.applyImpulseFp('ball', [65536, 0, 0]), true);
  assert.equal(world.getBody('ball').velocity[0], 1);
  assert.equal(world.setVelocityFp('ball', [0, 131072, 0]), true);
  assert.equal(world.getBody('ball').velocity[1], 2);
  assert.equal(world.teleportFp('ball', [196608, 0, 0]), true);
  assert.equal(world.getBody('ball').position[0], 3);
});
