import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createScenePhysicsRuntime,
  normalizeObjectPhysics,
  normalizeScenePhysics,
} from './scene-physics.js';

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
  position = [0, 2, 0],
  scale = [1, 1, 1],
  physics = { enabled: true, shape: 'sphere', velocity: [0, 0, 0] },
} = {}) {
  return {
    userData: {
      objectId: 'ball',
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

test('scene physics runtime uses object age instead of raw active time when provided', () => {
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
    getObjectAge: () => 0,
  });

  runtime.update({ t: 1_780_000_000, mode: 'room-time', active: true });

  assert.equal(object.position.toArray()[1], 2);
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

  runtime.update({ t: 0.5, mode: 'local', transportActive: true });
  assert.ok(object.position.toArray()[1] < 2);

  runtime.update({ t: 0.5, mode: 'local', transportActive: false });
  assert.equal(object.position.toArray()[1], 2);

  object.position.fromArray([0, 5, 0]);
  runtime.markDirty();

  assert.equal(runtime.resetActiveToInitialPose(), false);
  assert.equal(object.position.toArray()[1], 5);
});
