import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CANONICAL_PHYSICS_HASH_VERSION,
  RAPIER_CORE_VERSION,
  initRapierPhysics,
} from './rapier-world.js';
import {
  createRapierParityResult,
  createRapierParityWorldFromFixture,
} from './rapier-parity-fixture.js';

const FIXTURE_URL = new URL('../../../../../fixtures/rapier/parity-basic-001.json', import.meta.url);

let fixture;

before(async () => {
  await initRapierPhysics();
  fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8'));
});

test('loads the shared Rapier parity fixture into a browser Rapier world', () => {
  const world = createRapierParityWorldFromFixture(fixture);
  try {
    assert.equal(world.options.ground, null);
    assert.deepEqual(world.options.gravity, [0, -9.81, 0]);
    assert.equal(Math.fround(world.timestep), Math.fround(fixture.timestep));
    assert.deepEqual(world.getBodies().map((body) => body.id), ['box-1', 'floor']);
  } finally {
    world.free();
  }
});

test('browser parity fixture records canonical hashes and dumps at sample ticks', () => {
  const result = createRapierParityResult(fixture);
  const sampleTickKeys = fixture.sampleTicks.map((tick) => String(tick));

  assert.equal(result.host, 'browser');
  assert.equal(result.profile, 'SceneSyncRapierParity-0.30');
  assert.equal(result.rapierCoreVersion, RAPIER_CORE_VERSION);
  assert.equal(result.hashVersion, CANONICAL_PHYSICS_HASH_VERSION);
  assert.equal(result.fixture, 'fixtures/rapier/parity-basic-001.json');
  assert.deepEqual(Object.keys(result.hashes), sampleTickKeys);
  assert.deepEqual(Object.keys(result.dumps), sampleTickKeys);
  assert.deepEqual(result.hashes, {
    0: '02bbfcc85e21a236',
    1: 'cb8f1992d35076c7',
    2: 'b2b7e98db862dabb',
    10: '1a77e988f4c3b903',
    60: '0f91006661518595',
    120: '78f4dbb6435f7ccb',
    300: '9a6399672d2eddd1',
    600: '9a6399672d2eddd1',
  });

  for (const hash of Object.values(result.hashes)) {
    assert.match(hash, /^[0-9a-f]{16}$/);
  }

  const initialDump = result.dumps['0'];
  assert.equal(initialDump.tick, 0);
  assert.equal(initialDump.hashVersion, CANONICAL_PHYSICS_HASH_VERSION);
  assert.deepEqual(new Set(initialDump.bodies.map((body) => body.id)), new Set(['box-1', 'floor']));
  assert.deepEqual(new Set(initialDump.colliders.map((collider) => collider.id)), new Set(['box-1', 'floor']));

  const boxBody = initialDump.bodies.find((body) => body.id === 'box-1');
  const boxCollider = initialDump.colliders.find((collider) => collider.id === 'box-1');
  assert.deepEqual(boxBody.position, [-0.75, 5, 0]);
  assert.deepEqual(boxBody.linvel.map(Math.fround), [0.75, 0, 0.15].map(Math.fround));
  assert.equal(boxCollider.shape, 'box');
  assert.deepEqual(boxCollider.halfExtents, [0.5, 0.5, 0.5]);
  assert.equal(boxCollider.density, 1);
  assert.equal(boxCollider.friction, 0.5);
  assert.equal(Math.fround(boxCollider.restitution), Math.fround(0.2));
});

test('browser parity fixture result reports the supplied fixture path', () => {
  const result = createRapierParityResult(fixture, {
    fixturePath: 'fixtures/rapier/custom.json',
    includeDumps: false,
  });

  assert.equal(result.fixture, 'fixtures/rapier/custom.json');
  assert.equal(result.dumps, undefined);
});
