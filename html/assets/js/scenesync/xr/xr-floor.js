import * as THREE from 'three';

function createReticleLabel() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fillRect(0, 0, 512, 128);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('床を見てトリガーを引く', 256, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.6, 0.15, 1);
  sprite.position.set(0, 0.3, 0);
  sprite.renderOrder = 9999;
  sprite.raycast = () => {};
  return sprite;
}

function createReticle() {
  const geo = new THREE.RingGeometry(0.10, 0.15, 32);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x88ccff,
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide,
  });
  const reticle = new THREE.Mesh(geo, mat);
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  reticle.raycast = () => {};
  reticle.userData._isReticle = true;

  // 説明ラベルを子として追加
  const label = createReticleLabel();
  reticle.add(label);

  return reticle;
}

export function createXrFloorManager(ctx) {
  const {
    scene,
    renderer,
    xrState,
    dom,
    showToast,
    initialHeadHeight,
  } = ctx;

  xrState.floor.reticle = createReticle();
  scene.add(xrState.floor.reticle);

  function applyFloorOffset(floorY) {
    const baseSpace = xrState.floor.referenceSpace;
    if (!baseSpace) return;

    const offsetTransform = new XRRigidTransform(
      { x: 0, y: -floorY, z: 0, w: 1 },
      { x: 0, y: 0, z: 0, w: 1 }
    );
    const offsetSpace = baseSpace.getOffsetReferenceSpace(offsetTransform);
    renderer.xr.setReferenceSpace(offsetSpace);
    xrState.floor.offsetSpace = offsetSpace;
    xrState.floor.estimatedFloorY = floorY;
  }

  function updateCalibrationButton() {
    const btn = dom.xrCalibrateBtn;
    if (!btn) return;

    if (xrState.active && xrState.mode === 'immersive-ar' && !xrState.floor.calibrating) {
      btn.style.display = 'inline-flex';
      btn.onclick = startFloorCalibration;
    } else {
      btn.style.display = 'none';
    }
  }

  function confirmFloorCalibration() {
    if (!xrState.floor.calibrating) return false;
    if (xrState.floor.lastHitY === null) {
      showToast('床を見てください');
      return false;
    }

    const hitY = xrState.floor.lastHitY;
    const currentOffset = xrState.floor.estimatedFloorY || 0;
    const newOffset = currentOffset - hitY;
    applyFloorOffset(newOffset);

    console.log('[XR] floor calibration:', { currentOffset, hitY, newOffset });

    xrState.floor.calibrating = false;
    xrState.floor.floorConfirmed = true;
    xrState.floor.reticle.visible = false;
    showToast('床位置を設定しました');

    updateCalibrationButton();
    return true;
  }

  function startFloorCalibration() {
    if (xrState.mode !== 'immersive-ar') {
      showToast('床合わせはARモードでのみ使用できます');
      return;
    }
    xrState.floor.calibrating = true;
    xrState.floor.floorConfirmed = false;
    showToast('床を見てトリガーを引いてください');
    updateCalibrationButton();
  }

  async function handleSessionStart(session, mode) {
    xrState.floor.estimatedFloorY = null;
    xrState.floor.stableHitCount = 0;
    xrState.floor.floorConfirmed = false;
    xrState.floor.lastHitPose = null;
    xrState.floor.hitTestSource = null;
    xrState.floor.viewerSpace = null;

    xrState.floor.referenceSpace = renderer.xr.getReferenceSpace();
    applyFloorOffset(initialHeadHeight);

    if (mode === 'immersive-ar') {
      xrState.floor.calibrating = true;
      xrState.floor.floorConfirmed = false;
      showToast('床を見てトリガーを引いてください');
    } else {
      xrState.floor.calibrating = false;
    }

    if (mode === 'immersive-ar') {
      try {
        xrState.floor.viewerSpace = await session.requestReferenceSpace('viewer');
        xrState.floor.hitTestSource = await session.requestHitTestSource({
          space: xrState.floor.viewerSpace,
        });
      } catch (e) {
        console.warn('[XR] viewer hit-test not available:', e);
      }
    }

    updateCalibrationButton();
  }

  function handleSessionEnd() {
    const btn = dom.xrCalibrateBtn;
    if (btn) btn.style.display = 'none';

    xrState.floor.reticle.visible = false;
    if (xrState.floor.hitTestSource) {
      try { xrState.floor.hitTestSource.cancel(); } catch {}
      xrState.floor.hitTestSource = null;
    }
    xrState.floor.calibrating = false;
    xrState.floor.viewerSpace = null;
    xrState.floor.referenceSpace = null;
    xrState.floor.offsetSpace = null;
    xrState.floor.estimatedFloorY = null;
    xrState.floor.lastHitPose = null;
    xrState.floor.stableHitCount = 0;
    xrState.floor.floorConfirmed = false;
  }

  function dispose() {
    handleSessionEnd();

    const reticle = xrState.floor.reticle;
    if (reticle) {
      scene.remove(reticle);
      if (reticle.geometry) reticle.geometry.dispose();
      if (reticle.material) reticle.material.dispose();
      xrState.floor.reticle = null;
    }
  }

  return {
    applyFloorOffset,
    confirmFloorCalibration,
    startFloorCalibration,
    updateCalibrationButton,
    handleSessionStart,
    handleSessionEnd,
    dispose,
  };
}
