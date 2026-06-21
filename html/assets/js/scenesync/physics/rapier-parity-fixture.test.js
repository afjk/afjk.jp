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
    0: '43af70bb0d584167',
    1: '65fef4a4d29b40ba',
    2: '52649f6bbd3540c2',
    10: 'f2bf5f533b788f16',
    60: '0a16d338571a280c',
    120: '7531c543fd7cf7fa',
    300: 'ba91b9785cf9168c',
    600: 'ba91b9785cf9168c',
  },
  'parity-contact-basic-001.json': {
    0: '717960f5748ebc9b',
    1: '97be88421da8e037',
    2: '9a569c50cfad59f8',
    10: '7739acdd722fa024',
    30: 'a4e8bcc70f15dfc3',
    55: '38956d3b881e76e2',
    56: 'dd9c85319711aa62',
    57: '1e60f60ea96e5965',
    58: 'f53842bcbbdae1e8',
    60: '66ee8d6b45f00a51',
    120: 'c49b9e20d1703bfe',
    300: '8e235a1c14a6d011',
    600: '1d1d479bf100e287',
  },
  'parity-freefall-001.json': {
    0: '1a8cf55faa0e4e4e',
    1: '8f9f11fbf1f52663',
    2: 'a882f0aedd1ea2e3',
    10: 'b05d71580dd8b483',
    60: '14f6c93758a3967a',
    120: '165dfa5582a4ba24',
    300: '62275fdf452d3e1b',
    600: '7e02eccebb676aad',
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
