// Connection-scoped selection hints. They are never restored from scene files.
export function createRoomSelectionLocks({ maxEntries = 1000 } = {}) {
  const rooms = new Map();
  return {
    observe(roomId, payload, ownerId) {
      if (!payload || typeof payload !== 'object') return;
      if (payload.kind === 'scene-batch') {
        for (const key of ['ops', 'actions']) {
          for (const action of Array.isArray(payload[key]) ? payload[key] : []) {
            this.observe(roomId, action, ownerId);
          }
        }
        return;
      }
      const objectId = payload.objectId;
      if (typeof objectId !== 'string' || !objectId || objectId.length > 128) return;
      const locks = rooms.get(roomId) || new Map();
      if (payload.kind === 'scene-lock' && ownerId) {
        if (locks.has(objectId) || locks.size < maxEntries) {
          locks.set(objectId, ownerId);
          rooms.set(roomId, locks);
        }
      } else if (payload.kind === 'scene-remove'
        || (payload.kind === 'scene-unlock' && ownerId && locks.get(objectId) === ownerId)) {
        locks.delete(objectId);
      }
    },
    snapshot(roomId, objects, isConnected) {
      return Object.fromEntries([...(rooms.get(roomId) || [])]
        .filter(([objectId, ownerId]) => Object.hasOwn(objects || {}, objectId) && isConnected(ownerId)));
    },
    leave(roomId, ownerId) {
      const locks = rooms.get(roomId);
      for (const [objectId, owner] of locks || []) {
        if (owner === ownerId) locks.delete(objectId);
      }
    },
    clearRoom: roomId => rooms.delete(roomId),
    clear: () => rooms.clear(),
  };
}
