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

import { FP_ONE, toFp, toSafeInt, sanitizeFpVec } from './fixed.js';
import {
  createWorld,
  DEFAULT_TIMESTEP_FP,
  normalizeBodyDef,
  sanitizeBodyRecord,
  MAX_POSITION_FP,
  MAX_VELOCITY_FP,
  MAX_IMPULSE_FP,
} from './world.js';

function toFpVecLoose(value) {
  const v = Array.isArray(value) && value.length >= 3 ? value : [0, 0, 0];
  return [toFp(Number(v[0])), toFp(Number(v[1])), toFp(Number(v[2]))];
}

function deepFreeze(object) {
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(object);
}

// Builds the canonical, JSON-safe, frozen command that goes into the log.
// Payloads are raw fixed-point ints; every peer runs the same coercion, so a
// command observed anywhere is byte-identical everywhere, and callers cannot
// mutate logged commands through retained references.
export function canonicalizeCommand(command) {
  const canonical = {
    tick: toSafeInt(command.tick, -1),
    seq: toSafeInt(command.seq, -1),
    peerId: String(command.peerId ?? ''),
    type: String(command.type ?? ''),
  };
  switch (canonical.type) {
    case 'add-body': {
      const body = sanitizeBodyRecord(command.body);
      if (body) {
        body.sleepCounter = 0;
        body.sleeping = false;
        canonical.body = body;
      }
      break;
    }
    case 'remove-body':
      canonical.bodyId = String(command.bodyId ?? '');
      break;
    case 'impulse':
      canonical.bodyId = String(command.bodyId ?? '');
      canonical.impulseFp = sanitizeFpVec(command.impulseFp, MAX_IMPULSE_FP);
      break;
    case 'set-velocity':
      canonical.bodyId = String(command.bodyId ?? '');
      canonical.velocityFp = sanitizeFpVec(command.velocityFp, MAX_VELOCITY_FP);
      break;
    case 'teleport':
      canonical.bodyId = String(command.bodyId ?? '');
      canonical.positionFp = sanitizeFpVec(command.positionFp, MAX_POSITION_FP);
      break;
    default:
      // 未知 type は payload を持たない inert なコマンドとして残す
      break;
  }
  return deepFreeze(canonical);
}

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
    switch (command.type) {
      case 'add-body':
        if (command.body) world.addBodyRecord(command.body);
        break;
      case 'remove-body':
        world.removeBody(command.bodyId);
        break;
      case 'impulse':
        world.applyImpulseFp(command.bodyId, command.impulseFp);
        break;
      case 'set-velocity':
        world.setVelocityFp(command.bodyId, command.velocityFp);
        break;
      case 'teleport':
        world.teleportFp(command.bodyId, command.positionFp);
        break;
      default:
        // 未知のコマンドは全クライアントで同一に無視する
        break;
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

  // Accepts ergonomic float payloads ({ body }, { impulse }, { velocity },
  // { position }) or pre-converted raw payloads ({ impulseFp }, ...). Floats
  // are converted to fixed point here, once, on the issuing client — the
  // canonical raw-int command is what gets logged and broadcast.
  function issueCommand(type, payload = {}) {
    const draft = {
      tick: world.tick + commandDelayTicks,
      seq: seqCounter,
      peerId,
      type,
    };
    switch (type) {
      case 'add-body':
        draft.body = payload.body && !Array.isArray(payload.body)
          ? (payload.body.positionFp ? payload.body : normalizeBodyDef(payload.body))
          : null;
        break;
      case 'remove-body':
        draft.bodyId = payload.bodyId;
        break;
      case 'impulse':
        draft.bodyId = payload.bodyId;
        draft.impulseFp = payload.impulseFp ?? toFpVecLoose(payload.impulse);
        break;
      case 'set-velocity':
        draft.bodyId = payload.bodyId;
        draft.velocityFp = payload.velocityFp ?? toFpVecLoose(payload.velocity);
        break;
      case 'teleport':
        draft.bodyId = payload.bodyId;
        draft.positionFp = payload.positionFp ?? toFpVecLoose(payload.position);
        break;
      default:
        break;
    }
    const command = canonicalizeCommand(draft);
    seqCounter += 1;
    insertCommand(command);
    return command;
  }

  function receiveCommand(message) {
    if (!isValidCommand(message)) {
      return { applied: false, reason: 'invalid' };
    }
    const command = canonicalizeCommand(message);
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
    // Seed the restored state as a rollback anchor so slightly-late commands
    // arriving before the next snapshot interval can still be replayed
    // instead of being rejected as too-old.
    snapshots.push({ tick: world.tick, snapshot: world.snapshot() });
    commandLog.length = 0;
    for (const message of state.commands ?? []) {
      if (!isValidCommand(message)) continue;
      const command = canonicalizeCommand(message);
      if (!findDuplicate(command)) insertCommand(command);
    }
    // Never reuse a (peerId, seq) pair that may already exist in the room:
    // resume our sequence after the highest seq attributed to us.
    for (const command of commandLog) {
      if (command.peerId === peerId && command.seq >= seqCounter) {
        seqCounter = command.seq + 1;
      }
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
