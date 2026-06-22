import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPhysicsResetBaseline,
  buildPhysicsBodyDef,
  createPhysicsResetBaseline,
  createScenePhysicsRuntime,
  isScenePhysicsZeroTime,
  normalizeObjectPhysics,
  normalizeScenePhysics,
  SCENE_SYNC_PHYSICS_SNAPSHOT_VERSION,
  SCENE_SYNC_PHYSICS_TIMELINE_VERSION,
  SCENE_SYNC_RAPIER_PROFILE,
  shouldResetPhysicsForSceneClockPayload,
} from './scene-physics.js';
import {
  CANONICAL_PHYSICS_HASH_VERSION,
  initRapierPhysics,
  RAPIER_CORE_VERSION,
} from './physics/index.js';

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

test('queues scene physics input and applies it at the requested tick', () => {
  const object = makeObject({
    objectId: 'ball',
    position: [0, 2, 0],
    physics: {
      enabled: true,
      bodyType: 'dynamic',
      shape: 'sphere',
      radius: 0.5,
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const runtime = makeRuntime({
    scenePhysics: {
      enabled: true,
      worldOptions: {
        gravity: [0, 0, 0],
        ground: null,
        timestep: 1 / 60,
      },
    },
    entries: [makeEntry(object)],
  });

  runtime.update({ t: 0, transportActive: true });
  assert.equal(runtime.getTick(), 0);
  assert.equal(runtime.hasDynamicBody('ball'), true);
  const bodyState = runtime.getDynamicBodyState('ball');
  assert.equal(bodyState.id, 'ball');
  assert.equal(bodyState.static, false);
  assert.deepEqual(bodyState.velocity, [0, 0, 0]);
  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'drag-1',
    objectId: 'ball',
    applyTick: 1,
    position: [3, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [1, 0, 0],
    angularVelocity: [0, 0, 0],
  }), true);

  const result = runtime.update({ t: 3 / 60, transportActive: true });
  assert.equal(result.active, true);
  assert.ok(result.tick >= 2);
  assert.ok(object.position.toArray()[0] > 3);

  runtime.dispose();
});

test('rewinds and replays when a scene physics input arrives late', () => {
  const object = makeObject({
    objectId: 'ball',
    position: [0, 2, 0],
    physics: {
      enabled: true,
      bodyType: 'dynamic',
      shape: 'sphere',
      radius: 0.5,
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const runtime = makeRuntime({
    scenePhysics: {
      enabled: true,
      worldOptions: {
        gravity: [0, 0, 0],
        ground: null,
        timestep: 1 / 60,
      },
    },
    entries: [makeEntry(object)],
  });

  runtime.update({ t: 0, transportActive: true });
  runtime.update({ t: 0.2, transportActive: true });
  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'late-drag-1',
    objectId: 'ball',
    applyTick: 1,
    position: [3, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [1, 0, 0],
    angularVelocity: [0, 0, 0],
  }), true);

  const result = runtime.update({ t: 0.25, transportActive: true });
  assert.equal(result.active, true);
  assert.ok(object.position.toArray()[0] > 3.15);

  runtime.dispose();
});

test('keeps scene physics input pending until the body exists', () => {
  const entries = [];
  const object = makeObject({
    objectId: 'ball',
    position: [0, 2, 0],
    physics: {
      enabled: true,
      bodyType: 'dynamic',
      shape: 'sphere',
      radius: 0.5,
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const runtime = makeRuntime({
    scenePhysics: {
      enabled: true,
      worldOptions: {
        gravity: [0, 0, 0],
        ground: null,
        timestep: 1 / 60,
      },
    },
    entries,
  });

  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'pending-drag-1',
    objectId: 'ball',
    applyTick: 1,
    position: [3, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [1, 0, 0],
    angularVelocity: [0, 0, 0],
  }), true);

  runtime.update({ t: 0, transportActive: true });
  entries.push(makeEntry(object));
  runtime.update({ t: 0, transportActive: true });
  const result = runtime.update({ t: 3 / 60, transportActive: true });
  assert.equal(result.active, true);
  assert.ok(object.position.toArray()[0] > 3);

  runtime.dispose();
});

test('orders same-tick interaction inputs by event revision and sequence', () => {
  const object = makeObject({
    objectId: 'ball',
    position: [0, 2, 0],
    physics: {
      enabled: true,
      bodyType: 'dynamic',
      shape: 'sphere',
      radius: 0.5,
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const runtime = makeRuntime({
    scenePhysics: {
      enabled: true,
      worldOptions: {
        gravity: [0, 0, 0],
        ground: null,
        timestep: 1 / 60,
      },
    },
    entries: [makeEntry(object)],
  });

  runtime.update({ t: 0, transportActive: true });
  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'drag-1-move',
    interactionId: 'drag-1',
    sequence: 1,
    eventRevision: 1,
    phase: 'grab-move',
    objectId: 'ball',
    applyTick: 1,
    position: [3, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  }), true);
  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'drag-1-release',
    interactionId: 'drag-1',
    sequence: 2,
    eventRevision: 2,
    phase: 'grab-release',
    objectId: 'ball',
    applyTick: 1,
    position: [3, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [6, 0, 0],
    angularVelocity: [0, 0, 0],
  }), true);

  const result = runtime.update({ t: 3 / 60, transportActive: true });
  assert.equal(result.active, true);
  assert.ok(object.position.toArray()[0] > 3.05);

  runtime.dispose();
});

test('updates existing scene physics input metadata from canonical server echo', () => {
  const object = makeObject({
    objectId: 'ball',
    position: [0, 2, 0],
    physics: {
      enabled: true,
      bodyType: 'dynamic',
      shape: 'sphere',
      radius: 0.5,
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const runtime = makeRuntime({
    scenePhysics: {
      enabled: true,
      worldOptions: {
        gravity: [0, 0, 0],
        ground: null,
        timestep: 1 / 60,
      },
    },
    entries: [makeEntry(object)],
  });

  runtime.update({ t: 0, transportActive: true });
  const localInput = {
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'drag-echo:000001',
    timelineId: 'default',
    timelineRevision: 0,
    eventRevision: 1,
    interactionId: 'drag-echo',
    sequence: 1,
    phase: 'grab-release',
    objectId: 'ball',
    applyTick: 1,
    position: [3, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [1, 0, 0],
    angularVelocity: [0, 0, 0],
  };
  assert.equal(runtime.queueInput(localInput), true);
  assert.equal(runtime.queueInput({
    ...localInput,
    eventRevision: 7,
    timelineForkTick: 0,
  }), true);

  const result = runtime.update({ t: 3 / 60, transportActive: true });
  assert.equal(result.lastEventRevision, 7);
  assert.ok(object.position.toArray()[0] > 3);

  runtime.dispose();
});

test('scene physics input metadata echo does not rewind unchanged applied state', () => {
  const object = makeObject({
    objectId: 'ball',
    position: [0, 2, 0],
    physics: {
      enabled: true,
      bodyType: 'dynamic',
      shape: 'sphere',
      radius: 0.5,
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const runtime = makeRuntime({
    scenePhysics: {
      enabled: true,
      worldOptions: {
        gravity: [0, 0, 0],
        ground: null,
        timestep: 1 / 60,
      },
    },
    entries: [makeEntry(object)],
  });

  runtime.update({ t: 0, transportActive: true });
  const localInput = {
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'drag-echo-applied:000001',
    timelineId: 'default',
    timelineRevision: 0,
    eventRevision: 0,
    interactionId: 'drag-echo-applied',
    sequence: 1,
    phase: 'grab-drag',
    objectId: 'ball',
    applyTick: 1,
    position: [3, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [1, 0, 0],
    angularVelocity: [0, 0, 0],
  };

  assert.equal(runtime.queueInput(localInput), true);
  runtime.update({ t: 2 / 60, transportActive: true });
  const beforeEcho = runtime.createSnapshotReport({ t: 2 / 60, transportActive: true });
  assert.ok(beforeEcho.tick > 0);

  assert.equal(runtime.queueInput({
    ...localInput,
    eventRevision: 7,
    timelineForkTick: 0,
  }), true);
  const afterEcho = runtime.createSnapshotReport({ t: 2 / 60, transportActive: true });
  assert.equal(afterEcho.tick, beforeEcho.tick);
  assert.equal(afterEcho.hash, beforeEcho.hash);

  runtime.dispose();
});

test('starting a new physics timeline revision does not rewind when no applied input is dropped', () => {
  const object = makeObject({
    objectId: 'ball',
    position: [0, 2, 0],
    physics: {
      enabled: true,
      bodyType: 'dynamic',
      shape: 'sphere',
      radius: 0.5,
      velocity: [0.25, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const runtime = makeRuntime({
    scenePhysics: {
      enabled: true,
      worldOptions: {
        gravity: [0, 0, 0],
        ground: null,
        timestep: 1 / 60,
      },
    },
    entries: [makeEntry(object)],
  });

  runtime.update({ t: 0, transportActive: true });
  runtime.update({ t: 4 / 60, transportActive: true });
  const beforeInput = runtime.createSnapshotReport({ t: 4 / 60, transportActive: true });
  assert.ok(beforeInput.tick > 0);

  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'drag-new-branch:000001',
    timelineId: 'default',
    timelineRevision: 1,
    eventRevision: 0,
    interactionId: 'drag-new-branch',
    sequence: 1,
    phase: 'grab-start',
    objectId: 'ball',
    branchTick: beforeInput.tick,
    applyTick: beforeInput.tick + 2,
    position: [3, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [1, 0, 0],
    angularVelocity: [0, 0, 0],
  }), true);

  const afterInput = runtime.createSnapshotReport({ t: 4 / 60, transportActive: true });
  assert.equal(afterInput.tick, beforeInput.tick);
  assert.equal(afterInput.hash, beforeInput.hash);

  runtime.dispose();
});

test('scene physics drag hold keeps applying body state until release', () => {
  const object = makeObject({
    objectId: 'held-domino',
    position: [0, 2, 0],
    physics: {
      enabled: true,
      bodyType: 'dynamic',
      shape: 'box',
      halfExtents: [0.1, 0.6, 0.3],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const runtime = makeRuntime({
    scenePhysics: {
      enabled: true,
      worldOptions: {
        gravity: [0, -9.81, 0],
        ground: null,
        timestep: 1 / 60,
      },
    },
    entries: [makeEntry(object)],
  });

  runtime.update({ t: 0, transportActive: true });
  const holdInput = {
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'hold-domino:000001',
    timelineId: 'default',
    timelineRevision: 1,
    eventRevision: 1,
    interactionId: 'hold-domino',
    sequence: 1,
    phase: 'grab-move',
    objectId: 'held-domino',
    branchTick: 0,
    applyTick: 1,
    position: [0, 5, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  };
  assert.equal(runtime.queueInput(holdInput), true);

  runtime.update({ t: 30 / 60, transportActive: true });
  assertVectorClose(object.position.toArray(), [0, 5, 0]);

  assert.equal(runtime.queueInput({
    ...holdInput,
    inputId: 'hold-domino:000002',
    eventRevision: 2,
    sequence: 2,
    phase: 'grab-release',
    applyTick: 31,
  }), true);
  runtime.update({ t: 45 / 60, transportActive: true });
  assert.ok(object.position.toArray()[1] < 5);

  runtime.dispose();
});

test('scene physics drag cancel clears active body state hold', () => {
  const object = makeObject({
    objectId: 'cancelled-domino',
    position: [0, 2, 0],
    physics: {
      enabled: true,
      bodyType: 'dynamic',
      shape: 'box',
      halfExtents: [0.1, 0.6, 0.3],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const runtime = makeRuntime({
    scenePhysics: {
      enabled: true,
      worldOptions: {
        gravity: [0, -9.81, 0],
        ground: null,
        timestep: 1 / 60,
      },
    },
    entries: [makeEntry(object)],
  });

  runtime.update({ t: 0, transportActive: true });
  const holdInput = {
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'cancel-domino:000001',
    timelineId: 'default',
    timelineRevision: 1,
    eventRevision: 1,
    interactionId: 'cancel-domino',
    sequence: 1,
    phase: 'grab-move',
    objectId: 'cancelled-domino',
    branchTick: 0,
    applyTick: 1,
    position: [0, 5, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  };
  assert.equal(runtime.queueInput(holdInput), true);
  runtime.update({ t: 30 / 60, transportActive: true });
  assertVectorClose(object.position.toArray(), [0, 5, 0]);

  assert.equal(runtime.queueInput({
    ...holdInput,
    inputId: 'cancel-domino:000002',
    eventRevision: 2,
    sequence: 2,
    phase: 'grab-cancel',
    applyTick: 31,
  }), true);
  runtime.update({ t: 45 / 60, transportActive: true });
  assert.ok(object.position.toArray()[1] < 5);

  runtime.dispose();
});

test('branches the physics event timeline and drops old future inputs', () => {
  const object = makeObject({
    objectId: 'ball',
    position: [0, 2, 0],
    physics: {
      enabled: true,
      bodyType: 'dynamic',
      shape: 'sphere',
      radius: 0.5,
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const runtime = makeRuntime({
    scenePhysics: {
      enabled: true,
      worldOptions: {
        gravity: [0, 0, 0],
        ground: null,
        timestep: 1 / 60,
      },
    },
    entries: [makeEntry(object)],
  });

  runtime.update({ t: 0, transportActive: true });
  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'old-future',
    objectId: 'ball',
    applyTick: 20,
    position: [20, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  }), true);
  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'branch-event',
    timelineRevision: 1,
    branchTick: 10,
    eventRevision: 1,
    interactionId: 'branch-drag',
    sequence: 0,
    phase: 'grab-release',
    objectId: 'ball',
    applyTick: 10,
    position: [10, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  }), true);
  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'stale-future',
    timelineRevision: 0,
    objectId: 'ball',
    applyTick: 21,
    position: [21, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  }), false);

  const result = runtime.update({ t: 22 / 60, transportActive: true });
  assert.equal(result.timelineRevision, 1);
  assert.equal(result.timelineForkTick, 10);
  assert.equal(result.lastEventRevision, 1);
  assertVectorClose(object.position.toArray(), [10, 2, 0]);

  runtime.dispose();
});

test('clears scene physics input history and rejects stale inputs', () => {
  const object = makeObject({
    objectId: 'ball',
    position: [0, 2, 0],
    physics: {
      enabled: true,
      bodyType: 'dynamic',
      shape: 'sphere',
      radius: 0.5,
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const runtime = makeRuntime({
    scenePhysics: {
      enabled: true,
      worldOptions: {
        gravity: [0, 0, 0],
        ground: null,
        timestep: 1 / 60,
      },
    },
    entries: [makeEntry(object)],
  });

  runtime.update({ t: 0, transportActive: true });
  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'clear-before',
    objectId: 'ball',
    applyTick: 1,
    position: [6, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  }), true);
  runtime.update({ t: 3 / 60, transportActive: true });
  assertVectorClose(object.position.toArray(), [6, 2, 0]);

  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'clear-local-branch',
    timelineRevision: 3,
    timelineClearRevision: 0,
    branchTick: 1,
    objectId: 'ball',
    applyTick: 10,
    position: [4, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  }), true);
  assert.equal(runtime.getTimelineState().timelineRevision, 3);

  assert.equal(runtime.clearInputHistory({
    kind: 'scene-physics-input-log-clear',
    timelineId: 'default',
    timelineRevision: 1,
    timelineForkTick: 0,
    timelineClearRevision: 1,
  }), true);
  assert.equal(runtime.getTimelineState().timelineRevision, 1);
  assert.equal(runtime.getTimelineState().timelineClearRevision, 1);
  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'clear-stale',
    timelineRevision: 1,
    timelineClearRevision: 0,
    objectId: 'ball',
    applyTick: 2,
    position: [8, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  }), false);
  assert.equal(runtime.queueInput({
    kind: 'scene-physics-input',
    inputType: 'set-body-state',
    inputId: 'clear-after',
    timelineRevision: 1,
    timelineClearRevision: 1,
    eventRevision: 1,
    objectId: 'ball',
    applyTick: 1,
    position: [2, 2, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  }), true);
  assert.equal(runtime.clearInputHistory({
    kind: 'scene-physics-input-log-clear',
    timelineId: 'default',
    timelineRevision: 1,
    timelineForkTick: 0,
    timelineClearRevision: 1,
  }), false);

  const result = runtime.update({ t: 3 / 60, transportActive: true });
  assert.equal(result.timelineRevision, 1);
  assert.equal(result.timelineClearRevision, 1);
  assert.equal(result.lastEventRevision, 1);
  assertVectorClose(object.position.toArray(), [2, 2, 0]);

  runtime.dispose();
});

test('normalizes parity object physics fields used by Rapier hashing', () => {
  assert.deepEqual(normalizeObjectPhysics({
    enabled: true,
    bodyType: 'dynamic',
    density: 1,
    linearDamping: 0.02,
    angularDamping: 0.03,
    canSleep: false,
    ccd: true,
  }), {
    version: 1,
    enabled: true,
    bodyType: 'dynamic',
    shape: 'box',
    mass: 1,
    restitution: 0.2,
    friction: 0.5,
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    density: 1,
    linearDamping: 0.02,
    angularDamping: 0.03,
    canSleep: false,
    ccd: true,
  });

  assert.equal(normalizeObjectPhysics({
    enabled: true,
    bodyType: 'static',
  }).density, 0);

  const staticObject = makeObject({
    objectId: 'static-box',
    scale: [2, 2, 2],
    physics: {
      enabled: true,
      bodyType: 'static',
      shape: 'box',
    },
  });
  assert.equal(buildPhysicsBodyDef({
    objectId: 'static-box',
    object: staticObject,
    physics: staticObject.userData.physics,
  }).density, 0);
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

test('scene physics runtime reports canonical hash metadata for wire diagnostics', () => {
  const object = makeObject({
    objectId: 'hash-box',
    position: [0, 0.5, 0],
    physics: {
      enabled: true,
      shape: 'box',
      halfExtents: [0.5, 0.5, 0.5],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    worldOptions: {
      gravity: -9.81,
      ground: null,
      timestep: 1 / 60,
    },
  });
  const runtime = makeRuntime({ scenePhysics, entries: [makeEntry(object)] });

  const result = runtime.update({ t: 0, mode: 'shared-playback', active: true });

  assert.equal(result.active, true);
  assert.equal(result.tick, 0);
  assert.ok(Math.abs(result.timestep - 1 / 60) < 1e-8);
  assert.equal(result.worldEpochTime, 0);
  assert.equal(result.profile, SCENE_SYNC_RAPIER_PROFILE);
  assert.equal(result.hashVersion, CANONICAL_PHYSICS_HASH_VERSION);
  assert.equal(result.rapierCoreVersion, RAPIER_CORE_VERSION);
  assert.match(result.hash, /^[0-9a-f]{16}$/);
  assert.equal(result.stateHash, result.hash);
});

test('scene physics runtime produces a stable SceneSync Rapier sample hash', () => {
  const floor = makeObject({
    objectId: 'floor',
    position: [0, -0.5, 0],
    scale: [12, 1, 12],
    physics: {
      enabled: true,
      bodyType: 'static',
      shape: 'box',
      halfExtents: [6, 0.5, 6],
      density: 0,
      friction: 0.5,
      restitution: 0.2,
      initialTransform: {
        position: [0, -0.5, 0],
        rotation: [0, 0, 0, 1],
        scale: [12, 1, 12],
      },
    },
  });
  const box = makeObject({
    objectId: 'box-1',
    position: [-0.75, 5, 0],
    scale: [1, 1, 1],
    physics: {
      enabled: true,
      bodyType: 'dynamic',
      shape: 'box',
      halfExtents: [0.5, 0.5, 0.5],
      density: 1,
      friction: 0.5,
      restitution: 0.2,
      velocity: [0.75, 0, 0.15],
      angularVelocity: [0.35, 1.25, 0.55],
      linearDamping: 0.02,
      angularDamping: 0.02,
      canSleep: false,
      ccd: false,
      initialTransform: {
        position: [-0.75, 5, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    },
  });
  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    worldOptions: {
      gravity: [0, -9.81, 0],
      ground: null,
      timestep: 1 / 60,
    },
  });
  const runtime = createScenePhysicsRuntime({
    getScenePhysics: () => scenePhysics,
    getObjectEntries: () => [makeEntry(floor), makeEntry(box)],
    isClockActive: () => true,
  });

  const initial = runtime.update({ t: 0, mode: 'shared-playback', active: true, transportActive: true });
  assert.equal(initial.hash, '43af70bb0d584167');

  const atTick60 = runtime.update({ t: 1 + 1e-6, mode: 'shared-playback', active: true, transportActive: true });
  assert.equal(atTick60.tick, 60);
  assert.equal(atTick60.hash, 'e0c4380396163cee');
});

test('scene physics runtime creates canonical snapshot reports on demand', () => {
  const object = makeObject({
    objectId: 'snapshot-box',
    position: [0, 0.5, 0],
    physics: {
      enabled: true,
      shape: 'box',
      halfExtents: [0.5, 0.5, 0.5],
      velocity: [0.25, 0, 0],
      angularVelocity: [0, 0, 0],
    },
  });
  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    worldOptions: {
      gravity: -9.81,
      ground: null,
      timestep: 1 / 60,
    },
  });
  const runtime = makeRuntime({ scenePhysics, entries: [makeEntry(object)] });

  const result = runtime.update({ t: 0, mode: 'shared-playback', active: true });
  const snapshot = runtime.createSnapshotReport({ t: 0, mode: 'shared-playback', active: true });

  assert.equal(snapshot.kind, 'scene-physics-snapshot');
  assert.equal(snapshot.snapshotVersion, SCENE_SYNC_PHYSICS_SNAPSHOT_VERSION);
  assert.equal(snapshot.timelineVersion, SCENE_SYNC_PHYSICS_TIMELINE_VERSION);
  assert.equal(snapshot.timelineId, 'default');
  assert.equal(snapshot.timelineRevision, 0);
  assert.equal(snapshot.timelineForkTick, 0);
  assert.equal(snapshot.timelineClearRevision, 0);
  assert.equal(snapshot.lastEventRevision, 0);
  assert.equal(snapshot.profile, SCENE_SYNC_RAPIER_PROFILE);
  assert.equal(snapshot.hashVersion, CANONICAL_PHYSICS_HASH_VERSION);
  assert.equal(snapshot.rapierCoreVersion, RAPIER_CORE_VERSION);
  assert.equal(snapshot.tick, result.tick);
  assert.equal(snapshot.hash, result.hash);
  assert.equal(snapshot.bodyCount, 1);
  assert.deepEqual(snapshot.bodies[0], {
    id: 'snapshot-box',
    type: 'dynamic',
    position: [0, 0.5, 0],
    rotation: [0, 0, 0, 1],
    velocity: [0.25, 0, 0],
    angularVelocity: [0, 0, 0],
  });
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
  assert.equal(shouldResetPhysicsForSceneClockPayload({
    action: 'controller',
    physicsBaseline: createPhysicsResetBaseline({
      time: 0,
      worldEpochTime: 0,
      preserveMotion: false,
      reason: 'remote-player-controller-zero',
    }),
  }, 0), true);
  assert.equal(shouldResetPhysicsForSceneClockPayload({ action: 'controller' }, 0), false);
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

// ── Collision Event v0 tests ─────────────────────────────────────────────────

function makeCollisionScene() {
  // Static platform + dynamic ball that falls onto it.
  // No ground plane (ground: null) so only these two bodies interact.
  const platform = makeObject({
    objectId: 'platform',
    position: [0, 0, 0],
    scale: [4, 1, 4],
    physics: { enabled: true, bodyType: 'static', shape: 'box', halfExtents: [2, 0.5, 2] },
  });
  const ball = makeObject({
    objectId: 'ball',
    position: [0, 3, 0],
    scale: [1, 1, 1],
    physics: { enabled: true, shape: 'sphere', velocity: [0, 0, 0] },
  });

  const scenePhysics = normalizeScenePhysics({
    enabled: true,
    duration: 10,
    worldOptions: { gravity: -9.81, ground: null, timestep: 1 / 60 },
  });

  const runtime = createScenePhysicsRuntime({
    getScenePhysics: () => scenePhysics,
    getObjectEntries: () => [makeEntry(platform), makeEntry(ball)],
    isClockActive: () => true,
  });

  return { runtime, platform, ball };
}

function stepUntilCollision(runtime, maxTime = 2.0, timestep = 1 / 60) {
  let enterEvents = [];
  let lastResult;
  for (let t = timestep; t <= maxTime; t += timestep) {
    lastResult = runtime.update({ t });
    enterEvents.push(...(lastResult.events || []).filter((e) => e.type === 'physics.collision.enter'));
    if (enterEvents.length > 0) return { enterEvents, t, result: lastResult };
  }
  return { enterEvents, t: maxTime, result: lastResult };
}

test('scene physics runtime emits collision enter event for colliding bodies', () => {
  const { runtime } = makeCollisionScene();
  const { enterEvents } = stepUntilCollision(runtime);

  assert.ok(enterEvents.length > 0, 'should emit at least one physics.collision.enter');
  const ev = enterEvents[0];
  assert.equal(ev.type, 'physics.collision.enter');
  // source/phase/time/frameId are added by SceneSyncPhysicsPlugin, not by scene-physics.js
  assert.equal(ev.pairKey, 'ball|platform');
  assert.equal(ev.objectIdA, 'ball');
  assert.equal(ev.objectIdB, 'platform');
  runtime.dispose();
});

test('scene physics collision event carries the physics tick', () => {
  const { runtime } = makeCollisionScene();
  const { enterEvents } = stepUntilCollision(runtime);

  assert.ok(enterEvents.length > 0);
  const ev = enterEvents[0];
  assert.ok(Number.isFinite(ev.tick), 'tick should be a finite number');
  assert.ok(ev.tick > 0, 'tick should be positive at collision time');
  runtime.dispose();
});

test('scene physics runtime clears collision pairs after seek back (no stale exit)', () => {
  const { runtime } = makeCollisionScene();

  // Step until collision
  const { enterEvents } = stepUntilCollision(runtime);
  assert.ok(enterEvents.length > 0, 'precondition: collision should have occurred');

  // Seek back to t=0 (before any collision)
  const result = runtime.update({ t: 0 });

  // After seek back, no exit event for the pair should appear
  // (previousCollisionPairs was cleared, so the pair is unknown — not an "exit")
  const exitEvents = (result.events || []).filter((e) => e.type === 'physics.collision.exit');
  assert.deepEqual(exitEvents, [], 'seek back should not produce false exit events');
  runtime.dispose();
});

test('scene physics runtime re-emits collision enter after seek back', () => {
  const { runtime } = makeCollisionScene();

  // First pass: step until collision, record the enter event
  const { enterEvents: firstEnter, t: collisionTime } = stepUntilCollision(runtime);
  assert.ok(firstEnter.length > 0, 'precondition: first collision should fire');

  // Seek back to t=0
  runtime.update({ t: 0 });

  // Second pass: step to the same collision time again
  const result = runtime.update({ t: collisionTime });
  const secondEnter = (result.events || []).filter((e) => e.type === 'physics.collision.enter');

  assert.ok(secondEnter.length > 0, 'after seek back, collision.enter should fire again');
  assert.equal(secondEnter[0].pairKey, 'ball|platform');
  runtime.dispose();
});

test('scene physics runtime clears collision pairs after rebuild (no stale exit)', () => {
  const { runtime } = makeCollisionScene();

  // Step until collision
  const { enterEvents, t: collisionTime } = stepUntilCollision(runtime);
  assert.ok(enterEvents.length > 0, 'precondition: collision should have occurred');

  // Force rebuild (e.g. simulating a scene change)
  runtime.markDirty();

  // Re-run at the same time — rebuild creates a fresh world, previousCollisionPairs is cleared
  const result = runtime.update({ t: collisionTime });
  const exitEvents = (result.events || []).filter((e) => e.type === 'physics.collision.exit');
  assert.deepEqual(exitEvents, [], 'rebuild should not produce false exit events');
  runtime.dispose();
});
