import * as THREE from 'three';

const XR_HAND_JOINT_NAMES = [
  'wrist',

  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',

  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',

  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',

  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',

  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
];

export function createXrHandJointSpheres({ scene, renderer } = {}) {
  let enabled = true;

  const root = new THREE.Group();
  root.name = 'XR Hand Joint Spheres';
  root.userData.role = 'xr-hand-joint-spheres';
  root.userData._temporary = true;
  root.userData.nonSerializable = true;
  root.userData.ignoreSceneExport = true;
  root.raycast = () => {};
  scene.add(root);

  const geometry = new THREE.SphereGeometry(0.012, 12, 8);
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
    depthTest: false,
  });

  const hands = new Map();

  function getHandState(handedness) {
    if (hands.has(handedness)) {
      return hands.get(handedness);
    }

    const group = new THREE.Group();
    group.name = `Hand (${handedness})`;
    group.userData._temporary = true;
    group.raycast = () => {};
    root.add(group);

    const jointMap = new Map();
    for (const jointName of XR_HAND_JOINT_NAMES) {
      const sphere = new THREE.Mesh(geometry, material);
      sphere.name = jointName;
      sphere.userData._temporary = true;
      sphere.userData.nonSerializable = true;
      sphere.raycast = () => {};
      sphere.renderOrder = 9999;
      sphere.visible = false;
      group.add(sphere);
      jointMap.set(jointName, sphere);
    }

    const handState = {
      group,
      joints: jointMap,
    };
    hands.set(handedness, handState);
    return handState;
  }

  function hideAll() {
    root.visible = false;
    for (const handState of hands.values()) {
      handState.group.visible = false;
      for (const sphere of handState.joints.values()) {
        sphere.visible = false;
      }
    }
  }

  function update(frame) {
    if (!enabled || !frame) {
      hideAll();
      return;
    }

    const session = renderer.xr.getSession?.();
    const referenceSpace = renderer.xr.getReferenceSpace?.();

    if (!session || !referenceSpace) {
      hideAll();
      return;
    }

    root.visible = true;

    const visibleHands = new Set();

    for (const inputSource of session.inputSources) {
      if (!inputSource.hand) continue;

      const handedness = inputSource.handedness || 'unknown';
      const handState = getHandState(handedness);
      visibleHands.add(handedness);
      handState.group.visible = true;

      for (const jointName of XR_HAND_JOINT_NAMES) {
        const jointSpace = inputSource.hand.get(jointName);
        const sphere = handState.joints.get(jointName);

        if (!sphere) continue;
        if (!jointSpace) {
          sphere.visible = false;
          continue;
        }

        const pose = frame.getJointPose?.(jointSpace, referenceSpace);
        if (!pose) {
          sphere.visible = false;
          continue;
        }

        const p = pose.transform.position;
        sphere.position.set(p.x, p.y, p.z);

        const radius = Number.isFinite(pose.radius) ? pose.radius : 0.012;
        sphere.scale.setScalar(Math.max(0.5, radius / 0.012));
        sphere.visible = true;
      }
    }

    for (const [handedness, handState] of hands.entries()) {
      if (!visibleHands.has(handedness)) {
        handState.group.visible = false;
      }
    }
  }

  function setEnabled(nextEnabled) {
    enabled = Boolean(nextEnabled);
    if (!enabled) hideAll();
  }

  function dispose() {
    scene.remove(root);
    geometry.dispose();
    material.dispose();
  }

  return { root, update, setEnabled, dispose };
}
