import * as THREE from 'three';

const AVATAR_PALETTE = [
  0xff6b6b,
  0xfeca57,
  0x48dbfb,
  0x1dd1a1,
  0x5f27cd,
  0xff9ff3,
  0x54a0ff,
  0xee5253,
];

export function createRemoteAvatarManager(ctx) {
  const {
    scene,
    localPeerId,
    avatarTimeoutMs,
  } = ctx;

  const remoteAvatars = new Map();

  function colorFromPeerId(peerId) {
    let h = 0;
    for (let i = 0; i < peerId.length; i++) {
      h = (h * 31 + peerId.charCodeAt(i)) >>> 0;
    }
    return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
  }

  function makeNicknameSprite(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx2d = canvas.getContext('2d');
    ctx2d.font = 'bold 32px sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'middle';
    ctx2d.fillStyle = 'rgba(0,0,0,0.6)';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = '#fff';
    ctx2d.fillText(text || '', canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.4, 0.1, 1);
    sprite.renderOrder = 999;
    return sprite;
  }

  function disposeMaterial(material) {
    if (!material) return;
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial);
      return;
    }
    if (material.map) material.map.dispose();
    material.dispose();
  }

  function disposeRemoteAvatar(peerId) {
    const av = remoteAvatars.get(peerId);
    if (!av) return;

    scene.remove(av.group);
    av.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      disposeMaterial(o.material);
    });

    remoteAvatars.delete(peerId);
  }

  function disposeAllRemoteAvatars() {
    for (const peerId of Array.from(remoteAvatars.keys())) {
      disposeRemoteAvatar(peerId);
    }
  }

  function ensureRemoteAvatar(peerId, nickname) {
    const selfId = localPeerId?.();
    if (selfId && peerId === selfId) return null;

    let av = remoteAvatars.get(peerId);
    if (av) {
      if (nickname && av.nickname !== nickname) {
        av.nickname = nickname;
        av.head.remove(av.label);
        av.label.material.map?.dispose?.();
        av.label.material?.dispose?.();
        av.label = makeNicknameSprite(nickname);
        av.label.position.set(0, 0.22, 0);
        av.head.add(av.label);
      }
      return av;
    }

    const color = colorFromPeerId(peerId);
    const headMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const handMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 14), headMat);
    const left = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), handMat);
    const right = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), handMat);
    left.visible = false;
    right.visible = false;

    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const eyeGeom = new THREE.SphereGeometry(0.018, 10, 8);
    const eyeL = new THREE.Mesh(eyeGeom, eyeMat);
    const eyeR = new THREE.Mesh(eyeGeom, eyeMat);
    eyeL.position.set(-0.035, 0.02, -0.105);
    eyeR.position.set(0.035, 0.02, -0.105);
    head.add(eyeL, eyeR);

    const label = makeNicknameSprite(nickname || peerId.slice(0, 6));
    label.position.set(0, 0.22, 0);
    head.add(label);

    const group = new THREE.Group();
    group.name = `avatar:${peerId}`;
    group.add(head, left, right);
    scene.add(group);

    av = {
      group,
      head,
      left,
      right,
      label,
      targetHead: { p: new THREE.Vector3(), q: new THREE.Quaternion(), set: false },
      targetLeft: { p: new THREE.Vector3(), q: new THREE.Quaternion(), set: false },
      targetRight: { p: new THREE.Vector3(), q: new THREE.Quaternion(), set: false },
      leftActive: false,
      rightActive: false,
      lastSeen: performance.now(),
      mode: 'vr',
      nickname: nickname || peerId.slice(0, 6),
    };
    remoteAvatars.set(peerId, av);
    return av;
  }

  function setTargetPose(target, pose) {
    if (!pose || !Array.isArray(pose.p) || !Array.isArray(pose.q)) return false;
    const p = pose.p;
    const q = pose.q;
    if (
      !Number.isFinite(p[0]) ||
      !Number.isFinite(p[1]) ||
      !Number.isFinite(p[2]) ||
      !Number.isFinite(q[0]) ||
      !Number.isFinite(q[1]) ||
      !Number.isFinite(q[2]) ||
      !Number.isFinite(q[3])
    ) {
      return false;
    }
    target.p.set(p[0], p[1], p[2]);
    target.q.set(q[0], q[1], q[2], q[3]);
    target.set = true;
    return true;
  }

  function setHandTargetPose(target, pose) {
    if (!pose || !pose.active) return false;
    return setTargetPose(target, pose);
  }

  function handleAvatarMessage(payload) {
    if (!payload || !payload.peerId) return;

    const selfId = localPeerId?.();
    if (selfId && payload.peerId === selfId) return;

    if (!payload.head || !Array.isArray(payload.head.p) || !Array.isArray(payload.head.q)) return;

    const av = ensureRemoteAvatar(payload.peerId, payload.nickname);
    if (!av) return;

    av.lastSeen = performance.now();
    av.mode = payload.mode || av.mode;

    setTargetPose(av.targetHead, payload.head);
    av.leftActive = setHandTargetPose(av.targetLeft, payload.left);
    av.rightActive = setHandTargetPose(av.targetRight, payload.right);

    if (av.mode === 'desktop') {
      av.leftActive = false;
      av.rightActive = false;
    }
  }

  function updateRemoteAvatars(nowMs) {
    const selfId = localPeerId?.();
    const lerpAlpha = 0.25;

    for (const [peerId, av] of remoteAvatars) {
      if (selfId && peerId === selfId) {
        disposeRemoteAvatar(peerId);
        continue;
      }

      if (nowMs - av.lastSeen > avatarTimeoutMs) {
        disposeRemoteAvatar(peerId);
        continue;
      }

      if (av.targetHead.set) {
        av.head.position.lerp(av.targetHead.p, lerpAlpha);
        av.head.quaternion.slerp(av.targetHead.q, lerpAlpha);
      }

      av.left.visible = av.leftActive;
      if (av.leftActive && av.targetLeft.set) {
        av.left.position.lerp(av.targetLeft.p, lerpAlpha);
        av.left.quaternion.slerp(av.targetLeft.q, lerpAlpha);
      }

      av.right.visible = av.rightActive;
      if (av.rightActive && av.targetRight.set) {
        av.right.position.lerp(av.targetRight.p, lerpAlpha);
        av.right.quaternion.slerp(av.targetRight.q, lerpAlpha);
      }
    }
  }

  return {
    remoteAvatars,
    ensureRemoteAvatar,
    disposeRemoteAvatar,
    disposeAllRemoteAvatars,
    handleAvatarMessage,
    updateRemoteAvatars,
  };
}
