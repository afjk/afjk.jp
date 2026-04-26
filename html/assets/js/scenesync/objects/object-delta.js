import * as THREE from 'three';

const _wp = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _ws = new THREE.Vector3();

export function broadcastObjectDelta(obj, broadcast) {
  if (!obj?.userData?.objectId) return;

  obj.getWorldPosition(_wp);
  obj.getWorldQuaternion(_wq);
  obj.getWorldScale(_ws);

  const position = _wp.toArray();

  if (
    !Number.isFinite(position[0]) ||
    !Number.isFinite(position[1]) ||
    !Number.isFinite(position[2])
  ) {
    return;
  }

  broadcast?.({
    kind: 'scene-delta',
    objectId: obj.userData.objectId,
    position,
    rotation: [_wq.x, _wq.y, _wq.z, _wq.w],
    scale: _ws.toArray(),
  });
}
