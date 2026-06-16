import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import {
  CANONICAL_PHYSICS_HASH_VERSION,
  RAPIER_CORE_VERSION,
  initRapierPhysics,
} from './rapier-world.js';
import {
  createRapierParityResult,
  createRapierParityWorldFromFixture,
} from './rapier-parity-fixture.js';

const FIXTURE_DIR_URL = new URL('../../../../../fixtures/rapier/', import.meta.url);
const EXPECTED_HASHES = {
  'parity-basic-001.json': {
    0: '02bbfcc85e21a236',
    1: 'cb8f1992d35076c7',
    2: 'b2b7e98db862dabb',
    10: '1a77e988f4c3b903',
    60: '0f91006661518595',
    120: '78f4dbb6435f7ccb',
    300: '9a6399672d2eddd1',
    600: '9a6399672d2eddd1',
  },
  'parity-contact-basic-001.json': {
    0: '9ecb260d2bf78356',
    1: '2bef43f5fdcc5db2',
    2: '862ceba743bd1a15',
    10: 'c7b5725488784681',
    30: 'aa4e2cf669d0a13e',
    55: 'dc8dae299b6badc3',
    56: 'e47e0580936645d3',
    57: 'eb65430cfd43231c',
    58: 'de65709d75fa9f39',
    60: '0d78a29829f3e8d4',
    120: '3c5b2e079372d657',
    300: 'ecfb6297a05463a8',
    600: '48af1add55c90f76',
  },
  'parity-freefall-001.json': {
    0: 'bfab2fb4f911bac6',
    1: 'e83ec7c2f6ed2b8b',
    2: '5c60df3ce3409ffb',
    10: 'c9f66903fbb86fdb',
    60: '50551696bd305d52',
    120: '016928d21c8bfcbc',
    300: '2335b3ab4bfe8943',
    600: '3e8eec1943f444e5',
  },
};

const fixtures = new Map();

before(async () => {
  await initRapierPhysics();
  const names = (await readdir(FIXTURE_DIR_URL))
    .filter((name) => name.endsWith('.json'))
    .sort();
  for (const name of names) {
    fixtures.set(name, JSON.parse(await readFile(new URL(name, FIXTURE_DIR_URL), 'utf8')));
  }
});

function assertHashesEqualWithDumps(name, result, expected) {
  try {
    assert.deepEqual(result.hashes, expected);
  } catch (error) {
    error.message = `${error.message}\n\nCanonical dumps for ${name}:\n${JSON.stringify(result.dumps, null, 2)}`;
    throw error;
  }
}

test('loads all shared Rapier parity fixtures', () => {
  assert.deepEqual([...fixtures.keys()], Object.keys(EXPECTED_HASHES).sort());
});

test('loads the basic Rapier parity fixture into a browser Rapier world', () => {
  const fixture = fixtures.get('parity-basic-001.json');
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

for (const [fixtureName, expectedHashes] of Object.entries(EXPECTED_HASHES)) {
  test(`browser parity fixture records canonical hashes and dumps for ${fixtureName}`, () => {
    const fixture = fixtures.get(fixtureName);
    const fixturePath = `fixtures/rapier/${fixtureName}`;
    const result = createRapierParityResult(fixture, { fixturePath });
    const sampleTickKeys = fixture.sampleTicks.map((tick) => String(tick));

    assert.equal(result.host, 'browser');
    assert.equal(result.profile, 'SceneSyncRapierParity-0.30');
    assert.equal(result.rapierCoreVersion, RAPIER_CORE_VERSION);
    assert.equal(result.hashVersion, CANONICAL_PHYSICS_HASH_VERSION);
    assert.equal(result.fixture, fixturePath);
    assert.deepEqual(Object.keys(result.hashes), sampleTickKeys);
    assert.deepEqual(Object.keys(result.dumps), sampleTickKeys);
    assertHashesEqualWithDumps(fixtureName, result, expectedHashes);

    for (const hash of Object.values(result.hashes)) {
      assert.match(hash, /^[0-9a-f]{16}$/);
    }

    const fixtureIds = fixture.bodies.map((body) => body.id);
    const initialDump = result.dumps['0'];
    assert.equal(initialDump.tick, 0);
    assert.equal(initialDump.hashVersion, CANONICAL_PHYSICS_HASH_VERSION);
    assert.deepEqual(new Set(initialDump.bodies.map((body) => body.id)), new Set(fixtureIds));
    assert.deepEqual(new Set(initialDump.colliders.map((collider) => collider.id)), new Set(fixtureIds));

    const boxFixture = fixture.bodies.find((body) => body.id === 'box-1');
    const boxBody = initialDump.bodies.find((body) => body.id === 'box-1');
    const boxCollider = initialDump.colliders.find((collider) => collider.id === 'box-1');
    assert.deepEqual(boxBody.position, boxFixture.position);
    assert.deepEqual(boxBody.linvel.map(Math.fround), boxFixture.linearVelocity.map(Math.fround));
    assert.equal(boxCollider.shape, 'box');
    assert.deepEqual(boxCollider.halfExtents, boxFixture.halfExtents);
    assert.equal(boxCollider.density, boxFixture.density);
    assert.equal(Math.fround(boxCollider.friction), Math.fround(boxFixture.friction));
    assert.equal(Math.fround(boxCollider.restitution), Math.fround(boxFixture.restitution));
  });
}

test('browser parity fixture result reports the supplied fixture path', () => {
  const fixture = fixtures.get('parity-basic-001.json');
  const result = createRapierParityResult(fixture, {
    fixturePath: 'fixtures/rapier/custom.json',
    includeDumps: false,
  });

  assert.equal(result.fixture, 'fixtures/rapier/custom.json');
  assert.equal(result.dumps, undefined);
});
