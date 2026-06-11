// Lockstep command synchronization for the deterministic physics world.
//
// Clients never exchange physics state during normal play — only commands
// pinned to a tick. Because the world is deterministic, applying the same
// sorted command log produces identical states everywhere. Commands that
// arrive after their tick has already been simulated are handled by rolling
// back to a periodic snapshot and replaying.
//
// Command ordering is (tick, peerId, seq) so all clients apply concurrent
// commands in the same order regardless of arrival order.

import { FP_ONE } from './fixed.js';
import { createWorld, DEFAULT_TIMESTEP_FP } from './world.js';

export function compareCommands(a, b) {
  if (a.tick !== b.tick) return a.tick - b.tick;
  const peerA = String(a.peerId ?? '');
  const peerB = String(b.peerId ?? '');
  if (peerA < peerB) return -1;
  if (peerA > peerB) return 1;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

// Wall-clock pacing only: each client maps a shared start time to a target
// tick, but simulation results depend solely on tick counts, never on clocks.
export function tickForElapsedMs(elapsedMs, timestepFp = DEFAULT_TIMESTEP_FP) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.floor((elapsedMs * FP_ONE) / (timestepFp * 1000));
}

export function createLockstepSession({
  peerId = 'local',
  worldOptions = {},
  commandDelayTicks = 6,
  snapshotIntervalTicks = 30,
  maxSnapshots = 8,
} = {}) {
  const world = createWorld(worldOptions);
  const commandLog = [];
  const snapshots = [];
  let seqCounter = 0;

  function pruneCommandLog() {
    const oldestTick = snapshots.length > 0 ? snapshots[0].tick : 0;
    while (commandLog.length > 0 && commandLog[0].tick < oldestTick) {
      commandLog.shift();
    }
  }

  function recordSnapshotIfDue() {
    if (world.tick % snapshotIntervalTicks !== 0) return;
    const last = snapshots[snapshots.length - 1];
    if (last && last.tick === world.tick) return;
    snapshots.push({ tick: world.tick, snapshot: world.snapshot() });
    while (snapshots.length > maxSnapshots) snapshots.shift();
    pruneCommandLog();
  }

  function applyCommand(command) {
    try {
      switch (command.type) {
        case 'add-body':
          if (command.body) world.addBody(command.body);
          break;
        case 'remove-body':
          world.removeBody(command.bodyId);
          break;
        case 'impulse':
          if (Array.isArray(command.impulse)) world.applyImpulse(command.bodyId, command.impulse);
          break;
        case 'set-velocity':
          if (Array.isArray(command.velocity)) world.setVelocity(command.bodyId, command.velocity);
          break;
        case 'teleport':
          if (Array.isArray(command.position)) world.teleport(command.bodyId, command.position);
          break;
        default:
          // 未知のコマンドは全クライアントで同一に無視する
          break;
      }
    } catch {
      // 不正な payload も全クライアントで同一に無視する
    }
  }

  function applyCommandsAt(tick) {
    for (const command of commandLog) {
      if (command.tick > tick) break;
      if (command.tick === tick) applyCommand(command);
    }
  }

  function advanceTo(targetTick) {
    if (!Number.isInteger(targetTick)) return;
    while (world.tick < targetTick) {
      recordSnapshotIfDue();
      applyCommandsAt(world.tick);
      world.step();
    }
  }

  function isValidCommand(command) {
    return command
      && Number.isInteger(command.tick) && command.tick >= 0
      && Number.isInteger(command.seq)
      && typeof command.peerId === 'string'
      && typeof command.type === 'string';
  }

  function findDuplicate(command) {
    return commandLog.some((existing) => existing.tick === command.tick
      && existing.peerId === command.peerId
      && existing.seq === command.seq);
  }

  function insertCommand(command) {
    let index = commandLog.length;
    while (index > 0 && compareCommands(commandLog[index - 1], command) > 0) {
      index -= 1;
    }
    commandLog.splice(index, 0, command);
  }

  function issueCommand(type, payload = {}) {
    const command = {
      ...payload,
      tick: world.tick + commandDelayTicks,
      seq: seqCounter,
      peerId,
      type,
    };
    seqCounter += 1;
    insertCommand(command);
    return command;
  }

  function receiveCommand(command) {
    if (!isValidCommand(command)) {
      return { applied: false, reason: 'invalid' };
    }
    if (findDuplicate(command)) {
      return { applied: false, reason: 'duplicate' };
    }
    if (command.tick >= world.tick) {
      insertCommand(command);
      return { applied: true, rolledBack: false };
    }
    // Late command: roll back to the newest snapshot at or before its tick
    // (snapshots hold the state before that tick's commands are applied),
    // then replay with the command inserted.
    let snapshotIndex = -1;
    for (let i = snapshots.length - 1; i >= 0; i -= 1) {
      if (snapshots[i].tick <= command.tick) {
        snapshotIndex = i;
        break;
      }
    }
    if (snapshotIndex < 0) {
      return { applied: false, reason: 'too-old' };
    }
    const resumeTick = world.tick;
    world.restore(snapshots[snapshotIndex].snapshot);
    snapshots.length = snapshotIndex + 1;
    insertCommand(command);
    advanceTo(resumeTick);
    return { applied: true, rolledBack: true };
  }

  // 途中参加・ハッシュ不一致時の再同期用フルステート
  function createResyncState() {
    return {
      tick: world.tick,
      hash: world.stateHash(),
      snapshot: world.snapshot(),
      commands: commandLog.filter((command) => command.tick >= world.tick),
    };
  }

  function applyResyncState(state) {
    if (!state || typeof state !== 'object' || !state.snapshot) return false;
    world.restore(state.snapshot);
    snapshots.length = 0;
    commandLog.length = 0;
    for (const command of state.commands ?? []) {
      if (isValidCommand(command) && !findDuplicate(command)) insertCommand(command);
    }
    return true;
  }

  return {
    peerId,
    world,
    get tick() { return world.tick; },
    commandDelayTicks,
    issueCommand,
    receiveCommand,
    advanceTo,
    createResyncState,
    applyResyncState,
    stateHash: () => world.stateHash(),
    getBodies: () => world.getBodies(),
  };
}
