import test from 'node:test';
import assert from 'node:assert/strict';

import { createLockstepSession, compareCommands, tickForElapsedMs } from './lockstep.js';

const WORLD_OPTIONS = { ground: { y: 0, restitution: 0.4, friction: 0.5 } };

function exchange(from, to, command) {
  // Simulate the broadcast round trip through JSON
  return to.receiveCommand(JSON.parse(JSON.stringify(command)));
}

test('compareCommands orders by tick, then peerId, then seq', () => {
  assert.ok(compareCommands({ tick: 1, peerId: 'b', seq: 0 }, { tick: 2, peerId: 'a', seq: 0 }) < 0);
  assert.ok(compareCommands({ tick: 1, peerId: 'a', seq: 5 }, { tick: 1, peerId: 'b', seq: 0 }) < 0);
  assert.ok(compareCommands({ tick: 1, peerId: 'a', seq: 1 }, { tick: 1, peerId: 'a', seq: 0 }) > 0);
});

test('tickForElapsedMs maps wall time to ticks', () => {
  assert.equal(tickForElapsedMs(0), 0);
  assert.equal(tickForElapsedMs(-100), 0);
  assert.equal(tickForElapsedMs(1000), 60);
  assert.equal(tickForElapsedMs(10000), 600);
});

test('two sessions exchanging commands stay bit-identical', () => {
  const a = createLockstepSession({ peerId: 'peer-a', worldOptions: WORLD_OPTIONS });
  const b = createLockstepSession({ peerId: 'peer-b', worldOptions: WORLD_OPTIONS });

  const cmd1 = a.issueCommand('add-body', {
    body: { id: 'ball', shape: 'sphere', radius: 0.5, position: [0, 3, 0], restitution: 0.6 },
  });
  exchange(a, b, cmd1);
  const cmd2 = b.issueCommand('add-body', {
    body: { id: 'crate', shape: 'box', position: [0.4, 6, 0], mass: 5 },
  });
  exchange(b, a, cmd2);

  a.advanceTo(120);
  b.advanceTo(120);

  const cmd3 = a.issueCommand('impulse', { bodyId: 'ball', impulse: [2, 3, 0] });
  exchange(a, b, cmd3);

  a.advanceTo(300);
  b.advanceTo(300);

  assert.equal(a.stateHash(), b.stateHash());
  assert.deepEqual(a.getBodies(), b.getBodies());
});

test('a late command triggers rollback and the sessions re-converge', () => {
  const a = createLockstepSession({ peerId: 'peer-a', worldOptions: WORLD_OPTIONS, snapshotIntervalTicks: 10 });
  const b = createLockstepSession({ peerId: 'peer-b', worldOptions: WORLD_OPTIONS, snapshotIntervalTicks: 10 });

  const spawn = a.issueCommand('add-body', {
    body: { id: 'ball', shape: 'sphere', radius: 0.5, position: [0, 2, 0] },
  });
  exchange(a, b, spawn);
  a.advanceTo(30);
  b.advanceTo(30);

  const late = a.issueCommand('impulse', { bodyId: 'ball', impulse: [5, 8, 0] });
  a.advanceTo(60);
  b.advanceTo(80); // b has already simulated past the command's tick

  const result = exchange(a, b, late);
  assert.equal(result.applied, true);
  assert.equal(result.rolledBack, true);

  a.advanceTo(150);
  b.advanceTo(150);
  assert.equal(a.stateHash(), b.stateHash());
});

test('commands older than the oldest snapshot are rejected', () => {
  const session = createLockstepSession({
    peerId: 'peer-a',
    worldOptions: WORLD_OPTIONS,
    snapshotIntervalTicks: 10,
    maxSnapshots: 2,
  });
  session.advanceTo(100);
  const result = session.receiveCommand({
    tick: 5, seq: 0, peerId: 'peer-b', type: 'impulse', bodyId: 'x', impulse: [1, 0, 0],
  });
  assert.deepEqual(result, { applied: false, reason: 'too-old' });
});

test('duplicate and invalid commands are ignored', () => {
  const a = createLockstepSession({ peerId: 'peer-a', worldOptions: WORLD_OPTIONS });
  const b = createLockstepSession({ peerId: 'peer-b', worldOptions: WORLD_OPTIONS });
  const cmd = a.issueCommand('add-body', { body: { id: 'ball', shape: 'sphere', position: [0, 1, 0] } });

  assert.equal(exchange(a, b, cmd).applied, true);
  assert.deepEqual(exchange(a, b, cmd), { applied: false, reason: 'duplicate' });
  assert.deepEqual(b.receiveCommand({ type: 'impulse' }), { applied: false, reason: 'invalid' });
  assert.deepEqual(b.receiveCommand(null), { applied: false, reason: 'invalid' });
});

test('unknown command types are ignored identically on all peers', () => {
  const a = createLockstepSession({ peerId: 'peer-a', worldOptions: WORLD_OPTIONS });
  const b = createLockstepSession({ peerId: 'peer-b', worldOptions: WORLD_OPTIONS });
  const spawn = a.issueCommand('add-body', { body: { id: 'ball', shape: 'sphere', position: [0, 2, 0] } });
  exchange(a, b, spawn);
  const unknown = a.issueCommand('explode', { bodyId: 'ball', power: 100 });
  exchange(a, b, unknown);
  a.advanceTo(120);
  b.advanceTo(120);
  assert.equal(a.stateHash(), b.stateHash());
});

test('a late joiner resyncs from a state snapshot and stays in sync', () => {
  const a = createLockstepSession({ peerId: 'peer-a', worldOptions: WORLD_OPTIONS });
  const spawn = a.issueCommand('add-body', {
    body: { id: 'ball', shape: 'sphere', radius: 0.5, position: [0, 4, 0], restitution: 0.5 },
  });
  a.advanceTo(90);
  const pending = a.issueCommand('impulse', { bodyId: 'ball', impulse: [1, 6, 0] });

  const c = createLockstepSession({ peerId: 'peer-c', worldOptions: WORLD_OPTIONS });
  const state = JSON.parse(JSON.stringify(a.createResyncState()));
  assert.equal(c.applyResyncState(state), true);
  assert.equal(c.tick, a.tick);
  assert.equal(c.stateHash(), state.hash);

  a.advanceTo(240);
  c.advanceTo(240);
  assert.equal(a.stateHash(), c.stateHash());

  // unused but documents intent: spawn / pending travelled inside the resync state
  void spawn;
  void pending;
});

test('issued commands are scheduled commandDelayTicks ahead', () => {
  const session = createLockstepSession({ peerId: 'peer-a', worldOptions: WORLD_OPTIONS, commandDelayTicks: 6 });
  session.advanceTo(10);
  const cmd = session.issueCommand('add-body', { body: { id: 'ball', shape: 'sphere', position: [0, 1, 0] } });
  assert.equal(cmd.tick, 16);
  assert.equal(cmd.peerId, 'peer-a');
  // the body does not exist until its tick has been simulated
  session.advanceTo(16);
  assert.equal(session.world.hasBody('ball'), false);
  session.advanceTo(17);
  assert.equal(session.world.hasBody('ball'), true);
});
