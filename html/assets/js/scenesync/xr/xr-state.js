import * as THREE from 'three';

export function createXrState() {
  return {
    active: false,
    mode: null,
    grabbers: [
      {
        active: false,
        object: null,
        grabOffsetLocal: new THREE.Vector3(),
        initialObjectQuat: new THREE.Quaternion(),
        initialControllerYaw: 0,
      },
      {
        active: false,
        object: null,
        grabOffsetLocal: new THREE.Vector3(),
        initialObjectQuat: new THREE.Quaternion(),
        initialControllerYaw: 0,
      },
    ],
    twoHand: {
      active: false,
      object: null,
      initialDistance: 1,
      initialDirYaw: 0,
      initialObjectScale: new THREE.Vector3(1, 1, 1),
      initialObjectQuat: new THREE.Quaternion(),
      initialOffsetFromMidpoint: new THREE.Vector3(),
    },
    twoHandedFreeRotation: false,
    lastSent: 0,
    lockOwnedByMe: new Set(),
    floor: {
      referenceSpace: null,
      offsetSpace: null,
      estimatedFloorY: null,
      hitTestSource: null,
      viewerSpace: null,
      reticle: null,
      lastHitPose: null,
      lastHitY: null,
      stableHitCount: 0,
      floorConfirmed: false,
      calibrating: false,
    },
    controllers: [],
  };
}
