import { randomUUID } from 'node:crypto';

// Deliberately transient: removing the last connection forgets this room.
export function createRoomLifecycle({ emit, onClear, delayMs = 5000, now = Date.now }) {
  const states = new Map();
  function ensure(roomId) {
    if (!states.has(roomId)) states.set(roomId, {
      epoch: randomUUID(), cleared: false, pending: null, timer: null, requests: new Set(),
    });
    return states.get(roomId);
  }
  function snapshot(roomId) {
    const state = ensure(roomId);
    return { epoch: state.epoch, cleared: state.cleared, pending: state.pending, serverTime: now() };
  }
  function publish(roomId, event, extra = {}) {
    emit(roomId, { type: 'scene-room', event, ...snapshot(roomId), ...extra });
  }
  function request(roomId, actor, requestId, epoch) {
    const state = ensure(roomId);
    if (epoch !== state.epoch || typeof requestId !== 'string' || !/^[\w-]{1,128}$/.test(requestId)) return false;
    if (state.pending || state.requests.has(requestId)) {
      publish(roomId, 'status');
      return true;
    }
    state.requests.add(requestId);
    if (state.requests.size > 256) state.requests.delete(state.requests.values().next().value);
    state.pending = { requestId, actorId: actor.id, actorName: actor.nickname || '参加者', deadline: now() + delayMs };
    state.timer = setTimeout(() => {
      if (states.get(roomId) !== state || state.pending?.requestId !== requestId) return;
      const actorName = state.pending.actorName;
      state.pending = null;
      state.timer = null;
      state.epoch = randomUUID();
      state.cleared = true;
      onClear(roomId);
      publish(roomId, 'cleared', { actorName, requestId });
    }, delayMs);
    publish(roomId, 'pending');
    return true;
  }
  function cancel(roomId, requestId) {
    const state = states.get(roomId);
    if (!state?.pending || state.pending.requestId !== requestId) return false;
    clearTimeout(state.timer);
    state.timer = null;
    state.pending = null;
    publish(roomId, 'cancelled', { requestId });
    return true;
  }
  function remove(roomId) {
    clearTimeout(states.get(roomId)?.timer);
    states.delete(roomId);
  }
  return { ensure, snapshot, request, cancel, remove,
    clear() { for (const id of states.keys()) remove(id); },
    accepts(roomId, payload, client = null) {
      const state = states.get(roomId);
      if (!state) return true;
      const kind = payload?.kind || payload?.type || '';
      if (['scene-avatar', 'scene-request', 'scene-asset-request', 'file', 'ai-result', 'ai-link-established', 'ai-link-revoked'].includes(kind)) return true;
      if (payload?.sceneEpoch !== undefined && payload.sceneEpoch !== state.epoch) return false;
      if (state.cleared && payload?.sceneEpoch !== state.epoch) return false;
      if (client?.sceneProtocol === 1 && client.sceneReadyEpoch !== state.epoch) return false;
      return true;
    },
  };
}
