// Only live peers and successfully restored objects may carry a selection lock.
export function restoreSelectionLocks(snapshot, objectIds, peers) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [];
  const objects = new Set(objectIds);
  const owners = new Map(peers.map(peer => [peer.id, peer]));
  return Object.entries(snapshot)
    .filter(([objectId, ownerId]) => objects.has(objectId) && typeof ownerId === 'string' && owners.has(ownerId))
    .map(([objectId, ownerId]) => [objectId, owners.get(ownerId)]);
}
