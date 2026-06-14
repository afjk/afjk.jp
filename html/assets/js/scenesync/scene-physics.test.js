import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPhysicsResetBaseline,
  createPhysicsResetBaseline,
  createScenePhysicsRuntime,
  isScenePhysicsZeroTime,
  normalizeObjectPhysics,
  normalizeScenePhysics,
  shouldResetPhysicsForSceneClockPayload,
} from './scene-physics.js';
import { initRapierPhysics } from './physics/index.js';

before(async () => {
  await initRapierPhysics();
});

function vector(values) {
  return {
    values: [...values],
    toArray() {
      return [...this.values];
    },
    fromArray(next) {
      this.values = [...next];
    },
  };
}

function makeObject({
  objectId = 'ball',
  position = [0, 2, 0],
  scale = [1, 1, 1],
  physics = { enabled: true, shape: 'sphere', velocity: [0, 0, 0] },
} = {}) {
  return {
    userData: {
      objectId,
      physics,
      asset: { type: 'primitive', primitive: 'sphere' },
    },
    position: vector(position),
    scale: vector(scale),
    updateMatrixWorldCalled: 0,
    updateMatrixWorld() {
      this.updateMatrixWorldCalled += 1;
    },
  };
}

function makeEntry(object) {
  return {
    objectId: object.userData.objectId,
    object,
    physics: object.userData.physics,
  };
}

function makeRuntime({ scenePhysics, entries }) {
  return createScenePhysicsRuntime({
    getScenePhysics: () => scenePhysics,
    getObjectEntries: () => entries,
    isClockActive: () => true,
  });
}

function assertVectorClose(actual, expected, epsilon = 1e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]) <= epsilon,
      `expected component ${index} ${value} to be within ${epsilon} of ${expected[index]}`,
    );
  });
}

function assertVectorNotClose(actual, expected, epsilon = 1e-3) {
  assert.equal(actual.length, expected.length);
  assert.ok(
    actual.some((value, index) => Math.abs(value - expected[index]) > epsilon),
    `expected ${JSON.stringify(actual)} to differ from ${JSON.stringify(expected)}`,
  );
}

function physicsWithInitialTransform({
  shape = 'sphere',
  position = [0, 2, 0],
  rotation = [0, 0, 0, 1],
  scale = [1, 1, 1],
  velocity = [0, 0, 0],
} = {}) {
  return {
    enabled: true,
    shape,
    velocity,
    initialTransform: { position, rotation, scale },
  };
}

test('normalizes object physics with practical defaults', () => {
  assert.deepEqual(normalizeObjectPhysics({ enabled: true }), {
    version: 1,
    enabled: true,
    bodyType: 'dynamic',
    shape: 'box',
    mass: 1,
    restitution: 0.2,
    friction: 0.5,
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  });
});

test('scene physics runtime is a function of supplied clock time', () => {
  const object = makeObject();
  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    duration: 4,
    worldOptions: {
      gravity: -9.81,
      ground: null,
    },
  });
  const runtime = createScenePhysicsRuntime({
    getScenePhysics: () => scenePhysics,
    getObjectEntries: () => [{
      objectId: 'ball',
      object,
      physics: object.userData.physics,
    }],
    isClockActive: () => true,
  });

  runtime.update({ t: 0, mode: 'local', transportActive: true });
  assert.equal(object.position.toArray()[1], 2);

  runtime.update({ t: 0.5, mode: 'local', transportActive: true });
  const yAtHalfSecond = object.position.toArray()[1];
  assert.ok(yAtHalfSecond < 2);

  runtime.update({ t: 0.1, mode: 'local', transportActive: true });
  const yAfterSeekBack = object.position.toArray()[1];
  assert.ok(yAfterSeekBack > yAtHalfSecond);
  assert.ok(yAfterSeekBack < 2);
  assert.ok(object.updateMatrixWorldCalled > 0);
});

test('scene physics runtime treats rebuild time as the physics world epoch', () => {
  const object = makeObject();
  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    duration: 4,
    worldOptions: {
      gravity: -9.81,
      ground: null,
    },
  });
  const runtime = createScenePhysicsRuntime({
    getScenePhysics: () => scenePhysics,
    getObjectEntries: () => [makeEntry(object)],
    isClockActive: () => true,
  });

  const roomTime = 1_780_000_000;
  runtime.update({ t: roomTime, mode: 'room-time', active: true });

  assert.equal(object.position.toArray()[1], 2);

  runtime.update({ t: roomTime + 0.5, mode: 'room-time', active: true });
  assert.ok(object.position.toArray()[1] < 2);
});

test('scene physics runtime keeps existing body motion when a new body rebases the world', () => {
  const objectA = makeObject({ objectId: 'a', position: [0, 20, 0] });
  const objectB = makeObject({ objectId: 'b', position: [0, 20, 0] });
  let entries = [makeEntry(objectA)];
  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    duration: 4,
    worldOptions: {
      gravity: -9.81,
      ground: null,
    },
  });
  const runtime = createScenePhysicsRuntime({
    getScenePhysics: () => scenePhysics,
    getObjectEntries: () => entries,
    isClockActive: () => true,
    getObjectAge: (objectId, clockState) => {
      if (objectId === 'b') return Math.max(0, Number(clockState?.t) - 3);
      return Number(clockState?.t) || 0;
    },
  });

  runtime.update({ t: 0, mode: 'local', transportActive: true });
  runtime.update({ t: 3, mode: 'local', transportActive: true });
  const yBeforeRebuild = objectA.position.toArray()[1];
  assert.ok(yBeforeRebuild < 20);

  entries = [makeEntry(objectA), makeEntry(objectB)];
  runtime.markDirty();
  runtime.update({ t: 3, mode: 'local', transportActive: true });
  const yAfterRebuild = objectA.position.toArray()[1];
  assert.equal(yAfterRebuild, yBeforeRebuild);

  runtime.update({ t: 3.05, mode: 'local', transportActive: true });
  const yNextFrame = objectA.position.toArray()[1];
  assert.ok(yNextFrame < yAfterRebuild);
  assert.ok(
    yAfterRebuild - yNextFrame > 0.1,
    'existing body should keep falling with its pre-rebuild velocity',
  );
});

test('scene physics runtime resynchronizes from a shared playback zero baseline', () => {
  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    duration: 4,
    worldOptions: {
      gravity: -9.81,
      ground: null,
    },
  });
  const objectA = makeObject({
    objectId: 'shared-ball',
    position: [0, 8, 0],
    physics: { enabled: true, shape: 'sphere', velocity: [0.75, 0, 0] },
  });
  const objectB = makeObject({
    objectId: 'shared-ball',
    position: [0, 8, 0],
    physics: { enabled: true, shape: 'sphere', velocity: [0.75, 0, 0] },
  });
  const runtimeA = makeRuntime({ scenePhysics, entries: [makeEntry(objectA)] });
  const runtimeB = makeRuntime({ scenePhysics, entries: [makeEntry(objectB)] });

  runtimeA.update({ t: 0, mode: 'shared-playback', active: true });
  runtimeB.update({ t: 0, mode: 'shared-playback', active: true });
  runtimeA.update({ t: 1.4, mode: 'shared-playback', active: true });
  runtimeB.update({ t: 0.65, mode: 'shared-playback', active: true });
  assertVectorNotClose(objectA.position.toArray(), objectB.position.toArray());

  const baseline = createPhysicsResetBaseline({
    time: 0,
    worldEpochTime: 0,
    preserveMotion: false,
    reason: 'test-shared-reset',
  });
  applyPhysicsResetBaseline(runtimeA, { t: 0, mode: 'shared-playback', active: true }, baseline);
  applyPhysicsResetBaseline(runtimeB, { t: 0, mode: 'shared-playback', active: true }, baseline);
  runtimeA.update({ t: 0, mode: 'shared-playback', active: true });
  runtimeB.update({ t: 0, mode: 'shared-playback', active: true });

  assertVectorClose(objectA.position.toArray(), [0, 8, 0]);
  assertVectorClose(objectB.position.toArray(), [0, 8, 0]);

  runtimeA.update({ t: 1.1, mode: 'shared-playback', active: true });
  runtimeB.update({ t: 1.1, mode: 'shared-playback', active: true });
  assertVectorClose(objectA.position.toArray(), objectB.position.toArray());
});

test('scene physics shared zero baseline rebuilds from initial transforms after local drift', () => {
  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    duration: 4,
    worldOptions: {
      gravity: -9.81,
      ground: null,
    },
  });
  const objectA = makeObject({
    objectId: 'drift-a',
    position: [0, 8, 0],
    physics: physicsWithInitialTransform({
      position: [0, 8, 0],
      velocity: [0.5, 0, 0],
    }),
  });
  const objectB = makeObject({
    objectId: 'drift-b',
    position: [2, 6, 0],
    physics: physicsWithInitialTransform({
      position: [2, 6, 0],
      velocity: [-0.25, 0, 0],
    }),
  });
  let entries = [makeEntry(objectA)];
  const runtime = makeRuntime({ scenePhysics, entries });

  runtime.update({ t: 0, mode: 'local-preview', active: true });
  runtime.update({ t: 1, mode: 'local-preview', active: true });
  entries = [makeEntry(objectA), makeEntry(objectB)];
  runtime.markDirty();
  runtime.update({ t: 1, mode: 'local-preview', active: true });
  runtime.update({ t: 1.4, mode: 'local-preview', active: true });
  assertVectorNotClose(objectA.position.toArray(), [0, 8, 0]);

  const baseline = createPhysicsResetBaseline({
    time: 0,
    worldEpochTime: 0,
    preserveMotion: false,
    reason: 'test-shared-zero-after-drift',
  });
  applyPhysicsResetBaseline(runtime, { t: 0, mode: 'shared-playback', active: true }, baseline);
  runtime.update({ t: 0, mode: 'shared-playback', active: true });

  assertVectorClose(objectA.position.toArray(), [0, 8, 0]);
  assertVectorClose(objectB.position.toArray(), [2, 6, 0]);
});

test('scene physics runtime applies remote reset payload as a zero baseline', () => {
  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    duration: 4,
    worldOptions: {
      gravity: -9.81,
      ground: null,
    },
  });
  const controllerObject = makeObject({
    objectId: 'remote-ball',
    position: [0, 6, 0],
    physics: { enabled: true, shape: 'sphere', velocity: [0.5, 0, 0] },
  });
  const followerObject = makeObject({
    objectId: 'remote-ball',
    position: [0, 6, 0],
    physics: { enabled: true, shape: 'sphere', velocity: [0.5, 0, 0] },
  });
  const controllerRuntime = makeRuntime({ scenePhysics, entries: [makeEntry(controllerObject)] });
  const followerRuntime = makeRuntime({ scenePhysics, entries: [makeEntry(followerObject)] });

  controllerRuntime.update({ t: 0, mode: 'shared-playback', active: true });
  followerRuntime.update({ t: 0, mode: 'shared-playback', active: true });
  controllerRuntime.update({ t: 1.2, mode: 'shared-playback', active: true });
  followerRuntime.update({ t: 0.35, mode: 'shared-playback', active: true });
  assertVectorNotClose(controllerObject.position.toArray(), followerObject.position.toArray());

  const payload = {
    action: 'reset',
    mode: 'shared-playback',
    physicsBaseline: createPhysicsResetBaseline({
      time: 0,
      worldEpochTime: 0,
      preserveMotion: false,
      reason: 'remote-player-reset',
    }),
  };
  assert.equal(shouldResetPhysicsForSceneClockPayload(payload, 0), true);
  assert.equal(shouldResetPhysicsForSceneClockPayload({ action: 'seek', targetTime: 0 }, 0), true);
  assert.equal(shouldResetPhysicsForSceneClockPayload({ action: 'seek', targetTime: 0.0000001 }, 0.0000001), true);
  assert.equal(shouldResetPhysicsForSceneClockPayload({ action: 'seek', targetTime: 2 }, 2), false);
  assert.equal(isScenePhysicsZeroTime(0.0000001), true);
  assert.equal(isScenePhysicsZeroTime(0.00001), false);

  applyPhysicsResetBaseline(controllerRuntime, { t: 0, mode: 'shared-playback', active: true }, payload.physicsBaseline);
  applyPhysicsResetBaseline(followerRuntime, { t: 0, mode: 'shared-playback', active: true }, payload.physicsBaseline);
  controllerRuntime.update({ t: 0, mode: 'shared-playback', active: true });
  followerRuntime.update({ t: 0, mode: 'shared-playback', active: true });
  assertVectorClose(controllerObject.position.toArray(), followerObject.position.toArray());

  controllerRuntime.update({ t: 0.9, mode: 'shared-playback', active: true });
  followerRuntime.update({ t: 0.9, mode: 'shared-playback', active: true });
  assertVectorClose(controllerObject.position.toArray(), followerObject.position.toArray());
});

test('scene physics runtime resets to initial pose when the clock becomes inactive', () => {
  const object = makeObject();
  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    worldOptions: {
      gravity: -9.81,
      ground: null,
    },
  });
  let clockActive = true;
  const runtime = createScenePhysicsRuntime({
    getScenePhysics: () => scenePhysics,
    getObjectEntries: () => [{
      objectId: 'ball',
      object,
      physics: object.userData.physics,
    }],
    isClockActive: () => clockActive,
  });

  runtime.update({ t: 0, mode: 'local', transportActive: true });
  runtime.update({ t: 0.5, mode: 'local', transportActive: true });
  assert.ok(object.position.toArray()[1] < 2);

  clockActive = false;
  const result = runtime.update({ t: 0.5, mode: 'local', transportActive: false });
  assert.equal(result.reset, true);
  assert.equal(object.position.toArray()[1], 2);
});

test('scene physics runtime drops removed bodies after it is marked dirty', () => {
  const object = makeObject();
  let entries = [{
    objectId: 'ball',
    object,
    physics: object.userData.physics,
  }];
  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    worldOptions: {
      gravity: -9.81,
      ground: null,
    },
  });
  const runtime = createScenePhysicsRuntime({
    getScenePhysics: () => scenePhysics,
    getObjectEntries: () => entries,
    isClockActive: () => true,
  });

  runtime.update({ t: 0, mode: 'local', transportActive: true });
  assert.equal(runtime.hasBodies(), true);

  entries = [];
  runtime.markDirty();

  assert.equal(runtime.hasBodies(), false);
  const result = runtime.update({ t: 0.5, mode: 'local', transportActive: true });
  assert.equal(result.active, false);
  assert.equal(result.reason, 'no-bodies');
});

test('scene physics runtime does not reset inactive dirty authoring transforms', () => {
  const object = makeObject();
  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    worldOptions: {
      gravity: -9.81,
      ground: null,
    },
  });
  const runtime = createScenePhysicsRuntime({
    getScenePhysics: () => scenePhysics,
    getObjectEntries: () => [{
      objectId: 'ball',
      object,
      physics: object.userData.physics,
    }],
    isClockActive: (clockState) => clockState?.transportActive === true,
  });

  runtime.update({ t: 0, mode: 'local', transportActive: true });
  runtime.update({ t: 0.5, mode: 'local', transportActive: true });
  assert.ok(object.position.toArray()[1] < 2);

  runtime.update({ t: 0.5, mode: 'local', transportActive: false });
  assert.equal(object.position.toArray()[1], 2);

  object.position.fromArray([0, 5, 0]);
  runtime.markDirty();

  assert.equal(runtime.resetActiveToInitialPose(), false);
  assert.equal(object.position.toArray()[1], 5);
});
