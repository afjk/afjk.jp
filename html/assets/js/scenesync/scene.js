// ── scene.js ─────────────────────────────────────────────
// Three.js ビューア + presence-server 接続
// ─────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { createThreeApp } from './core/three-app.js';
import { createEnvironmentManager } from './core/environment.js';
import { DragDropManager } from './components/drag-drop-manager.js';
import { GLBFileLoader } from './loaders/glb-file-loader.js';
import { getSceneSyncDom } from './ui/dom.js';
import { showToast } from './ui/toast.js';
import { extractYaw } from './utils/math.js';
import { broadcastObjectDelta } from './objects/object-delta.js';
import { createXrState } from './xr/xr-state.js';
import { setupXrButtons } from './xr/xr-buttons.js';
import { createXrFloorManager } from './xr/xr-floor.js';
import { createRemoteAvatarManager } from './avatars/remote-avatars.js';
import { createHistoryManager, HistoryManager } from './history/history-manager.js';
import { createUserManager } from './user/user-manager.js';
import { createLinkManager } from './link/link-manager.js';
import { createSceneSyncLoomIntegration } from './loom/loom-integration.js';

// ── Three.js 基本セットアップ ────────────────────────────

const threeApp = createThreeApp();
const {
  scene,
  camera,
  renderer,
  pmremGenerator,
} = threeApp;
const dom = getSceneSyncDom();
const glbLoader = new GLBFileLoader({
  dracoPath: '/draco/',
  maxDimension: 10,
});

const onBeforeBroadcast = (operation, meta) => {
  if (operation.kind === 'scene-env' && meta.beforeEnvId) {
    presenceState.historyManager.push(
      HistoryManager.createEnvEntry(meta.beforeEnvId, operation.envId)
    );
  }
};

const environmentManager = createEnvironmentManager({
  scene,
  pmremGenerator,
  broadcast,
  onBeforeBroadcast,
  dom,
  showToast,
});
dom.envSelect?.addEventListener('change', () => {
  notifySceneStateChanged('environment-select-change');
});

setupXrButtons({
  renderer,
  dom,
});
const BLOB_BASE = location.hostname === 'localhost'
  ? 'http://localhost:8787/blob'
  : `${location.origin}/presence/blob`;
const SCENE_SYNC_OPERATOR_URL = 'https://chatgpt.com/g/g-69eac2f9af04819193334b81da1b7993-scene-sync-operator';

// ── XR コントローラー ──────────────────────────────────────
// XR セッションへ入るためのモード状態
let xrCurrentMode = null;       // 'immersive-vr' | 'immersive-ar' | null
let xrPendingMode = null;       // 切り替え予約

const xrState = createXrState();

const SCALE_MIN_RATIO = 0.05;
const SCALE_MAX_RATIO = 50;
const XR_INITIAL_HEAD_HEIGHT = 1.3;

const xrFloor = createXrFloorManager({
  scene,
  renderer,
  xrState,
  dom,
  showToast,
  initialHeadHeight: XR_INITIAL_HEAD_HEIGHT,
});

// ── アバター位置同期定数 ──
const AVATAR_SEND_INTERVAL_MS = 100;
const AVATAR_TIMEOUT_MS = 3000;
const AVATAR_POS_EPSILON = 0.0005;
const AVATAR_ROT_EPSILON = 0.5 * Math.PI / 180;

const avatarState = {
  lastSentAt: 0,
  lastSentHead: null,
};

// コントローラーのワールド位置を取得
function getControllerWorldPos(ctrl, out) {
  out.setFromMatrixPosition(ctrl.matrixWorld);
  return out;
}

// オブジェクトに lock を送信（重複防止）
function ensureLock(objectId) {
  if (xrState.lockOwnedByMe.has(objectId)) return;
  xrState.lockOwnedByMe.add(objectId);
  broadcast({ kind: 'scene-lock', objectId });
}

function ensureUnlock(objectId) {
  if (!xrState.lockOwnedByMe.has(objectId)) return;
  xrState.lockOwnedByMe.delete(objectId);
  broadcast({ kind: 'scene-unlock', objectId });
}

// 自分以外がそのオブジェクトをロックしているか
function isLockedByOthers(objectId) {
  if (!locks.has(objectId)) return false;
  const lockInfo = locks.get(objectId);
  const ownerId = lockInfo?.id || lockInfo;
  return ownerId && ownerId !== presenceState.id;
}

// ── XR モード切り替え（VR ⇄ MR） ─────────────────────────
async function switchXrMode(targetMode) {
  if (!('xr' in navigator)) return;

  const supported = await navigator.xr.isSessionSupported(targetMode).catch(() => false);
  if (!supported) {
    showToast(targetMode === 'immersive-ar' ? 'MRはこの端末で対応していません' : 'VRはこの端末で対応していません');
    return;
  }

  const currentSession = renderer.xr.getSession();
  if (currentSession) {
    // 現セッションを終了 → sessionend ハンドラ後に新セッション開始
    xrPendingMode = targetMode;
    try {
      await currentSession.end();
    } catch (e) {
      console.warn('[XR] failed to end current session:', e);
      xrPendingMode = null;
      showToast('セッション終了に失敗しました');
    }
  } else {
    // セッション中でない場合は直接開始
    try {
      await requestXrSession(targetMode);
    } catch (e) {
      handleXrRestartFailure(targetMode, e);
    }
  }
}

async function requestXrSession(mode) {
  const sessionInit = mode === 'immersive-ar'
    ? {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['local-floor', 'dom-overlay'],
        domOverlay: { root: document.body },
      }
    : { optionalFeatures: ['local-floor', 'bounded-floor'] };

  const session = await navigator.xr.requestSession(mode, sessionInit);
  await renderer.xr.setSession(session);
  xrCurrentMode = mode;
}

// XR セッション再開に失敗した場合の通知
function handleXrRestartFailure(intendedMode, error) {
  const errName = error?.name || 'Unknown';
  const modeLabel = intendedMode === 'immersive-ar' ? 'MR' : 'VR';

  console.warn('[XR] restart failed:', errName, error);

  if (errName === 'NotAllowedError' || errName === 'SecurityError') {
    // ユーザージェスチャ要件違反の可能性が高い
    showToast(`${modeLabel}に入るには画面の「${modeLabel}で入る」ボタンを押してください`);
  } else if (errName === 'InvalidStateError') {
    showToast(`${modeLabel}セッションが開始できません。ページを再読み込みしてください`);
  } else {
    showToast(`${modeLabel}切替失敗: ${errName}`);
  }
}

const controllerModelFactory = new XRControllerModelFactory();

for (let i = 0; i < 2; i++) {
  const ctrl = renderer.xr.getController(i);
  ctrl.userData.xrIndex = i;
  ctrl.addEventListener('selectstart', () => onXrSelectStart(ctrl));
  ctrl.addEventListener('selectend',   () => onXrSelectEnd(ctrl));
  ctrl.addEventListener('squeezestart', () => onXrSqueezeStart(ctrl));
  scene.add(ctrl);

  // レイ表示
  const rayGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -5),
  ]);
  const rayMat = new THREE.LineBasicMaterial({
    color: 0x88ccff,
    transparent: true,
    opacity: 0.7,
  });
  const ray = new THREE.Line(rayGeo, rayMat);
  ray.name = 'xr-ray';
  ray.raycast = () => {};
  ctrl.add(ray);

  // コントローラーモデル（grip）
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModelFactory.createControllerModel(grip));
  scene.add(grip);

  xrState.controllers.push(ctrl);
}

const xrTmpMatrix = new THREE.Matrix4();
const xrRaycaster = new THREE.Raycaster();

function onXrSelectStart(ctrl) {
  // 床合わせモード中ならトリガーで床確定
  if (xrState.floor.calibrating) {
    xrFloor.confirmFloorCalibration();
    return;
  }

  const idx = ctrl.userData.xrIndex;
  const grabber = xrState.grabbers[idx];

  // コントローラーから前方へレイキャスト
  xrTmpMatrix.identity().extractRotation(ctrl.matrixWorld);
  xrRaycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
  xrRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(xrTmpMatrix);

  const targets = Array.from(managedObjects.values());
  const hits = xrRaycaster.intersectObjects(targets, true);
  if (hits.length === 0) return;

  let obj = hits[0].object;
  while (obj.parent && !obj.userData.objectId) obj = obj.parent;
  if (!obj.userData?.objectId) return;
  if (obj.userData._isLockOverlay) return;

  // 他人にロックされている場合は不可
  if (isLockedByOthers(obj.userData.objectId)) return;

  // すでに反対の手が同じオブジェクトを掴んでいるかチェック
  const otherIdx = idx === 0 ? 1 : 0;
  const otherGrabber = xrState.grabbers[otherIdx];

  if (otherGrabber.active && otherGrabber.object === obj) {
    // ── 両手モード昇格 ──
    grabber.active = true;
    grabber.object = obj;
    startTwoHandMode(obj);
    return;
  }

  // ── 片手モード（新規掴み） ──
  ensureLock(obj.userData.objectId);

  // 掴み開始時のオブジェクト姿勢を保存
  grabber.initialObjectQuat.copy(obj.quaternion);

  // 掴み開始時のコントローラーY軸回転を保存
  const ctrlWorldQuat = new THREE.Quaternion();
  ctrl.getWorldQuaternion(ctrlWorldQuat);
  grabber.initialControllerYaw = extractYaw(ctrlWorldQuat);

  // コントローラーローカル空間での位置オフセット
  const objWorldPos = new THREE.Vector3();
  obj.getWorldPosition(objWorldPos);
  grabber.grabOffsetLocal.copy(objWorldPos);
  ctrl.worldToLocal(grabber.grabOffsetLocal);

  grabber.active = true;
  grabber.object = obj;
}

function onXrSelectEnd(ctrl) {
  const idx = ctrl.userData.xrIndex;
  const grabber = xrState.grabbers[idx];
  if (!grabber.active) return;

  const obj = grabber.object;
  const otherIdx = idx === 0 ? 1 : 0;
  const otherGrabber = xrState.grabbers[otherIdx];

  // 両手モード中の場合は片手モードへ降格
  if (xrState.twoHand.active && xrState.twoHand.object === obj) {
    endTwoHandMode();
    grabber.active = false;
    grabber.object = null;

    // 残った手で片手モードを継続するため、その手の初期姿勢を再キャプチャ
    if (otherGrabber.active && otherGrabber.object === obj) {
      reCaptureSingleHandGrab(otherGrabber, xrState.controllers[otherIdx], obj);
    }
    return;
  }

  // 通常の片手リリース
  grabber.active = false;
  grabber.object = null;

  // 反対の手も掴んでいなければ unlock
  const stillHeld = otherGrabber.active && otherGrabber.object === obj;
  if (!stillHeld) {
    if (obj.userData?.objectId) {
      // 最終姿勢を送信してから unlock
      broadcastObjectDelta(obj, broadcast);
      ensureUnlock(obj.userData.objectId);
    }
  }
}

// 片手モード継続のため、現在の状態を再キャプチャ
function reCaptureSingleHandGrab(grabber, ctrl, obj) {
  grabber.initialObjectQuat.copy(obj.quaternion);

  const ctrlWorldQuat = new THREE.Quaternion();
  ctrl.getWorldQuaternion(ctrlWorldQuat);
  grabber.initialControllerYaw = extractYaw(ctrlWorldQuat);

  const objWorldPos = new THREE.Vector3();
  obj.getWorldPosition(objWorldPos);
  grabber.grabOffsetLocal.copy(objWorldPos);
  ctrl.worldToLocal(grabber.grabOffsetLocal);
}

// ── 両手モード開始 ─────────────────────────────────────
function startTwoHandMode(obj) {
  const ctrl0 = xrState.controllers[0];
  const ctrl1 = xrState.controllers[1];

  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  getControllerWorldPos(ctrl0, p0);
  getControllerWorldPos(ctrl1, p1);

  const distance = p0.distanceTo(p1);
  if (distance < 0.0001) return;  // ほぼ同位置なら昇格しない

  const midpoint = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
  const dir = new THREE.Vector3().subVectors(p1, p0).normalize();
  // dir のY軸方向角度（XZ平面への投影）
  const dirYaw = Math.atan2(dir.x, dir.z);

  const objWorldPos = new THREE.Vector3();
  obj.getWorldPosition(objWorldPos);

  xrState.twoHand.active = true;
  xrState.twoHand.object = obj;
  xrState.twoHand.initialDistance = distance;
  xrState.twoHand.initialDirYaw = dirYaw;
  xrState.twoHand.initialObjectScale.copy(obj.scale);
  xrState.twoHand.initialObjectQuat.copy(obj.quaternion);
  xrState.twoHand.initialOffsetFromMidpoint.subVectors(objWorldPos, midpoint);
}

// ── 両手モード終了 ─────────────────────────────────────
function endTwoHandMode() {
  xrState.twoHand.active = false;
  xrState.twoHand.object = null;
}

// グリップ長押しでVR/MR切り替え（連打防止のためデバウンス）
let xrSqueezeStartTime = 0;
let xrModeToggleCooldown = 0;

function onXrSqueezeStart(ctrl) {
  const now = performance.now();
  if (now - xrModeToggleCooldown < 1500) return;  // 1.5秒のクールダウン
  xrSqueezeStartTime = now;

  // 0.6秒長押しを検出
  setTimeout(() => {
    // squeezestart から 0.6 秒経過した時点で
    // まだ squeeze が押されているかチェック
    const session = renderer.xr.getSession();
    if (!session) return;

    let stillPressed = false;
    for (const inputSource of session.inputSources) {
      if (inputSource.targetRayMode !== 'tracked-pointer') continue;
      const gp = inputSource.gamepad;
      if (!gp) continue;
      // gamepad.buttons[1] が squeeze（グリップ）の標準マッピング
      if (gp.buttons[1]?.pressed) {
        stillPressed = true;
        break;
      }
    }

    if (!stillPressed) return;
    if (performance.now() - xrSqueezeStartTime < 600) return;

    // モード切り替え実行
    xrModeToggleCooldown = performance.now();
    const next = xrCurrentMode === 'immersive-ar' ? 'immersive-vr' : 'immersive-ar';
    showToast(next === 'immersive-ar' ? 'MRに切り替えます…' : 'VRに切り替えます…');
    switchXrMode(next);
  }, 600);
}

// ── アバター送信ヘルパ ────────────────────────────────
const _avTmpPos = new THREE.Vector3();
const _avTmpQuat = new THREE.Quaternion();

function getControllerPose(index) {
  const ctrl = renderer.xr.getController(index);
  if (!ctrl) return { p: [0, 0, 0], q: [0, 0, 0, 1], active: false };
  const active = !!ctrl.visible;
  if (!active) return { p: [0, 0, 0], q: [0, 0, 0, 1], active: false };
  ctrl.getWorldPosition(_avTmpPos);
  ctrl.getWorldQuaternion(_avTmpQuat);
  return {
    p: [_avTmpPos.x, _avTmpPos.y, _avTmpPos.z],
    q: [_avTmpQuat.x, _avTmpQuat.y, _avTmpQuat.z, _avTmpQuat.w],
    active: true,
  };
}

function getHeadPose() {
  if (xrState.active) {
    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(_avTmpPos);
    cam.getWorldQuaternion(_avTmpQuat);
  } else {
    camera.getWorldPosition(_avTmpPos);
    camera.getWorldQuaternion(_avTmpQuat);
  }
  return {
    p: [_avTmpPos.x, _avTmpPos.y, _avTmpPos.z],
    q: [_avTmpQuat.x, _avTmpQuat.y, _avTmpQuat.z, _avTmpQuat.w],
  };
}

function getCurrentAvatarMode() {
  if (!xrState.active) return 'desktop';
  if (xrState.mode === 'immersive-ar' || xrCurrentMode === 'immersive-ar') return 'mr';
  return 'vr';
}

function shouldSkipAvatarSend(headPose) {
  const last = avatarState.lastSentHead;
  if (!last) return false;
  const dx = headPose.p[0] - last.p.x;
  const dy = headPose.p[1] - last.p.y;
  const dz = headPose.p[2] - last.p.z;
  if (dx * dx + dy * dy + dz * dz > AVATAR_POS_EPSILON * AVATAR_POS_EPSILON) return false;
  const dot = Math.abs(
    headPose.q[0] * last.q.x + headPose.q[1] * last.q.y +
    headPose.q[2] * last.q.z + headPose.q[3] * last.q.w
  );
  const angle = 2 * Math.acos(Math.min(1, dot));
  return angle < AVATAR_ROT_EPSILON;
}

function sendAvatarPose(nowMs) {
  if (!presenceState.id) return;
  if (nowMs - avatarState.lastSentAt < AVATAR_SEND_INTERVAL_MS) return;

  const head = getHeadPose();
  if (shouldSkipAvatarSend(head)) {
    if (nowMs - avatarState.lastSentAt < 1000) return;
  }

  const mode = getCurrentAvatarMode();
  const msg = {
    kind: 'scene-avatar',
    peerId: presenceState.id,
    nickname: presenceState.nickname || undefined,
    t: Date.now(),
    mode,
    head,
  };

  if (xrState.active) {
    msg.left = getControllerPose(0);
    msg.right = getControllerPose(1);
  }

  try {
    broadcast(msg);
    avatarState.lastSentAt = nowMs;
    if (!avatarState.lastSentHead) {
      avatarState.lastSentHead = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    }
    avatarState.lastSentHead.p.set(head.p[0], head.p[1], head.p[2]);
    avatarState.lastSentHead.q.set(head.q[0], head.q[1], head.q[2], head.q[3]);
  } catch (e) {
    console.warn('[avatar] send failed', e);
  }
}

const _xrTmpVec0 = new THREE.Vector3();
const _xrTmpVec1 = new THREE.Vector3();
const _xrTmpVec2 = new THREE.Vector3();
const _xrTmpQuat0 = new THREE.Quaternion();
const _xrTmpQuat1 = new THREE.Quaternion();
const _xrTmpEuler = new THREE.Euler();

function updateXrGrab() {
  // 両手モード優先
  if (xrState.twoHand.active && xrState.twoHand.object) {
    updateTwoHandGrab();
  } else {
    // 片手モード: 各コントローラーごとに独立処理
    for (let i = 0; i < xrState.grabbers.length; i++) {
      const grabber = xrState.grabbers[i];
      if (!grabber.active || !grabber.object) continue;
      updateSingleHandGrab(grabber, xrState.controllers[i]);
    }
  }

  // 50ms 間隔で delta を broadcast
  const now = performance.now();
  if (now - xrState.lastSent < 50) return;
  xrState.lastSent = now;

  // 動いているオブジェクト全てに対して delta 送信（重複は同じobjectIdなのでまとめる）
  const sentIds = new Set();
  if (xrState.twoHand.active && xrState.twoHand.object) {
    const id = xrState.twoHand.object.userData?.objectId;
    if (id && !sentIds.has(id)) {
      broadcastObjectDelta(xrState.twoHand.object, broadcast);
      sentIds.add(id);
    }
  } else {
    for (const grabber of xrState.grabbers) {
      if (!grabber.active || !grabber.object) continue;
      const id = grabber.object.userData?.objectId;
      if (id && !sentIds.has(id)) {
        broadcastObjectDelta(grabber.object, broadcast);
        sentIds.add(id);
      }
    }
  }
}

// ── 片手モードの位置・回転更新 ─────────────────────────
function updateSingleHandGrab(grabber, ctrl) {
  const obj = grabber.object;

  // 位置: コントローラーローカルオフセットをワールド変換
  _xrTmpVec0.copy(grabber.grabOffsetLocal);
  ctrl.localToWorld(_xrTmpVec0);
  obj.position.copy(_xrTmpVec0);

  // 回転: コントローラーのヨー差分のみ適用、初期姿勢を維持
  ctrl.getWorldQuaternion(_xrTmpQuat0);
  const currentYaw = extractYaw(_xrTmpQuat0);
  const deltaYaw = currentYaw - grabber.initialControllerYaw;
  _xrTmpEuler.set(0, deltaYaw, 0, 'YXZ');
  _xrTmpQuat1.setFromEuler(_xrTmpEuler);
  obj.quaternion.copy(_xrTmpQuat1).multiply(grabber.initialObjectQuat);
}

// ── 両手モードの位置・回転・スケール更新 ──────────────
function updateTwoHandGrab() {
  const obj = xrState.twoHand.object;
  const ctrl0 = xrState.controllers[0];
  const ctrl1 = xrState.controllers[1];

  const p0 = _xrTmpVec0;
  const p1 = _xrTmpVec1;
  getControllerWorldPos(ctrl0, p0);
  getControllerWorldPos(ctrl1, p1);

  const currentDistance = p0.distanceTo(p1);
  if (currentDistance < 0.0001) return;

  // ── スケール ──
  let ratio = currentDistance / xrState.twoHand.initialDistance;
  // 上限・下限クランプ
  ratio = Math.max(SCALE_MIN_RATIO, Math.min(SCALE_MAX_RATIO, ratio));
  obj.scale.copy(xrState.twoHand.initialObjectScale).multiplyScalar(ratio);

  // ── 回転 ──
  const dir = _xrTmpVec2.subVectors(p1, p0).normalize();
  const currentDirYaw = Math.atan2(dir.x, dir.z);
  const deltaYaw = currentDirYaw - xrState.twoHand.initialDirYaw;

  if (xrState.twoHandedFreeRotation) {
    // 6DoF: 両手間ベクトルでオブジェクトの+Z軸を合わせるクォータニオンを計算
    _xrTmpEuler.set(0, deltaYaw, 0, 'YXZ');
    _xrTmpQuat1.setFromEuler(_xrTmpEuler);
    obj.quaternion.copy(_xrTmpQuat1).multiply(xrState.twoHand.initialObjectQuat);
  } else {
    // Y軸ロック
    _xrTmpEuler.set(0, deltaYaw, 0, 'YXZ');
    _xrTmpQuat1.setFromEuler(_xrTmpEuler);
    obj.quaternion.copy(_xrTmpQuat1).multiply(xrState.twoHand.initialObjectQuat);
  }

  // ── 位置 ──
  // 両手の中点を基準に、初期オフセットを Y軸回転 deltaYaw だけ回したものを加える
  const midpoint = _xrTmpVec0.addVectors(p0, p1).multiplyScalar(0.5);
  const offset = _xrTmpVec2.copy(xrState.twoHand.initialOffsetFromMidpoint);
  // オフセットも Y軸回転で回す（中点周りで一緒に回るように）
  offset.applyQuaternion(_xrTmpQuat1);
  // スケール変化に応じてオフセットも伸縮
  offset.multiplyScalar(ratio);
  obj.position.copy(midpoint).add(offset);
}

// ── XR セッション開始/終了 ─────────────────────────────
let xrSavedBackground = null;

renderer.xr.addEventListener('sessionstart', async () => {
  xrState.active = true;
  const session = renderer.xr.getSession();
  // requestXrSession 経由で開始した場合は xrCurrentMode が設定済み
  // それ以外（XR ボタン直接クリック）は blendMode で推定
  if (xrCurrentMode) {
    xrState.mode = xrCurrentMode;
  } else {
    const blendMode = session.environmentBlendMode || 'opaque';
    xrState.mode = (blendMode === 'opaque') ? 'immersive-vr' : 'immersive-ar';
    xrCurrentMode = xrState.mode;
  }

  // TransformControls を退避
  if (transformCtrl.object) {
    const oid = transformCtrl.object.userData?.objectId;
    if (oid) broadcast({ kind: 'scene-unlock', objectId: oid });
    transformCtrl.detach();
  }
  const helper = transformCtrl.getHelper();
  if (helper) helper.visible = false;
  hideToolbar();

  // OrbitControls を無効化
  orbit.enabled = false;

  // MR の場合は背景を透過
  if (xrState.mode === 'immersive-ar') {
    xrSavedBackground = scene.background;
    scene.background = null;
  }

  // dom-overlay 用トグルボタンの表示制御
  const xrToggleBtn = dom.xrToggleBtn;
  if (xrToggleBtn) {
    if (xrState.mode === 'immersive-ar') {
      xrToggleBtn.style.display = 'inline-flex';
      xrToggleBtn.textContent = '🔄 VRに切替';
      xrToggleBtn.onclick = () => switchXrMode('immersive-vr');
    } else {
      // VR セッション中は dom-overlay が効かないので非表示
      xrToggleBtn.style.display = 'none';
    }
  }

  await xrFloor.handleSessionStart(session, xrState.mode);

  console.log('[XR] session started:', {
    mode: xrState.mode,
    calibrating: xrState.floor.calibrating,
    hitTestSource: !!xrState.floor.hitTestSource,
  });
});

renderer.xr.addEventListener('sessionend', () => {
  // トグルボタンと床合わせボタンを隠す
  const xrToggleBtn = dom.xrToggleBtn;
  if (xrToggleBtn) xrToggleBtn.style.display = 'none';

  xrState.active = false;

  // 掴み中だった場合は全てのコントローラー・両手状態をリリース
  endTwoHandMode();
  for (let i = 0; i < xrState.grabbers.length; i++) {
    const grabber = xrState.grabbers[i];
    if (!grabber.active || !grabber.object) continue;
    const obj = grabber.object;
    grabber.active = false;
    grabber.object = null;
    if (obj.userData?.objectId) {
      broadcastObjectDelta(obj, broadcast);
      ensureUnlock(obj.userData.objectId);
    }
  }
  // 念のため lockOwnedByMe を全クリア
  for (const id of xrState.lockOwnedByMe) {
    broadcast({ kind: 'scene-unlock', objectId: id });
  }
  xrState.lockOwnedByMe.clear();

  // UI 復元
  const helper = transformCtrl.getHelper();
  if (helper) helper.visible = true;
  orbit.enabled = true;

  // 背景復元
  if (xrState.mode === 'immersive-ar') {
    if (xrSavedBackground !== null) {
      scene.background = xrSavedBackground;
      xrSavedBackground = null;
    } else if (environmentManager.getCurrentEnvId()) {
      environmentManager.loadEnvironment(environmentManager.getCurrentEnvId(), {
        source: 'remote',
        broadcastChange: false,
      });
    }
  }

  xrState.mode = null;
  xrCurrentMode = null;

  // 保留中のモード切り替えがあれば即座に新セッション開始
  if (xrPendingMode) {
    const next = xrPendingMode;
    xrPendingMode = null;
    // setTimeout を挟まず即座に呼ぶ（ユーザージェスチャチェーンを保つ）
    requestXrSession(next).catch((e) => {
      console.error('[XR] auto-restart failed:', e);
      handleXrRestartFailure(next, e);
    });
  }

  xrFloor.handleSessionEnd();
});

// ── コントロール ─────────────────────────────────────────

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.1;

const transformCtrl = new TransformControls(camera, renderer.domElement);
// Three.js 0.170+ では getHelper() で Object3D を取得して scene に追加
scene.add(transformCtrl.getHelper());

let isDragging = false;
let dragIntervalId = null;
let dragStartState = null;

transformCtrl.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  isDragging = e.value;

  if (isDragging) {
    const obj = transformCtrl.object;
    if (obj && obj.userData.objectId) {
      dragStartState = {
        objectId: obj.userData.objectId,
        name: obj.userData.name || obj.userData.objectId,
        beforePos: obj.position.toArray(),
        beforeRot: obj.quaternion.toArray(),
        beforeScl: obj.scale.toArray(),
      };
    }
    dragIntervalId = setInterval(() => {
      sendSelectedDelta();
    }, 50);
  } else {
    clearInterval(dragIntervalId);
    dragIntervalId = null;
    sendSelectedDelta();

    // ドラッグ終了時に履歴に追加
    if (dragStartState) {
      const obj = transformCtrl.object;
      if (obj && obj.userData.objectId === dragStartState.objectId) {
        const afterPos = obj.position.toArray();
        const afterRot = obj.quaternion.toArray();
        const afterScl = obj.scale.toArray();

        // 値が変更されている場合のみ履歴に追加
        if (!arraysEqual(dragStartState.beforePos, afterPos) ||
            !arraysEqual(dragStartState.beforeRot, afterRot) ||
            !arraysEqual(dragStartState.beforeScl, afterScl)) {
          const historyEntry = HistoryManager.createDeltaEntry(
            dragStartState.objectId,
            dragStartState.name,
            dragStartState.beforePos,
            dragStartState.beforeRot,
            dragStartState.beforeScl,
            afterPos,
            afterRot,
            afterScl
          );
          presenceState.historyManager.push(historyEntry);
        }
      }
      dragStartState = null;
    }
  }
});

function arraysEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(v - b[i]) < 0.0001);
}

function sendSelectedDelta() {
  const obj = transformCtrl.object;
  if (!obj || !obj.userData.objectId) return;

  const pos = obj.position.toArray();
  const rot = obj.quaternion.toArray();
  const scl = obj.scale.toArray();

  if (!isFinite(pos[0]) || !isFinite(pos[1]) || !isFinite(pos[2])) return;

  broadcast({
    kind: 'scene-delta',
    objectId: obj.userData.objectId,
    position: pos,
    rotation: rot,
    scale: scl,
  });
  notifySceneStateChanged('selected-transform-sent');
}

// ── サンプルオブジェクト ──────────────────────────────────

const sampleGeo = new THREE.BoxGeometry(1, 1, 1);
const sampleMat = new THREE.MeshStandardMaterial({ color: 0x4488ff });
const sampleCube = new THREE.Mesh(sampleGeo, sampleMat);
sampleCube.position.set(0, 0.5, 0);
sampleCube.userData.objectId = 'sample-cube';
scene.add(sampleCube);

// ── オブジェクト管理 ─────────────────────────────────────

// objectId → THREE.Object3D
const managedObjects = new Map();
managedObjects.set('sample-cube', sampleCube);

// objectId → lockOwnerId
const locks = new Map();

// objectId → wireframe mesh
const lockOverlays = new Map();

// ── ロック表示 ──────────────────────────────────────────

function createCornerLines(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const min = box.min;
  const max = box.max;
  const size = box.getSize(new THREE.Vector3());
  const len = Math.max(size.x, size.y, size.z) * 0.2;

  const corners = [
    [min.x, min.y, min.z],
    [max.x, min.y, min.z],
    [min.x, max.y, min.z],
    [max.x, max.y, min.z],
    [min.x, min.y, max.z],
    [max.x, min.y, max.z],
    [min.x, max.y, max.z],
    [max.x, max.y, max.z],
  ];

  const dirs = [
    [[1,0,0],[0,1,0],[0,0,1]],
    [[-1,0,0],[0,1,0],[0,0,1]],
    [[1,0,0],[0,-1,0],[0,0,1]],
    [[-1,0,0],[0,-1,0],[0,0,1]],
    [[1,0,0],[0,1,0],[0,0,-1]],
    [[-1,0,0],[0,1,0],[0,0,-1]],
    [[1,0,0],[0,-1,0],[0,0,-1]],
    [[-1,0,0],[0,-1,0],[0,0,-1]],
  ];

  const points = [];
  for (let i = 0; i < 8; i++) {
    const [cx, cy, cz] = corners[i];
    for (const [dx, dy, dz] of dirs[i]) {
      points.push(cx, cy, cz);
      points.push(cx + dx * len, cy + dy * len, cz + dz * len);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xff8800,
    linewidth: 2,
    transparent: true,
    opacity: 0.8,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.raycast = () => {};
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function createLockLabel(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 256;
  canvas.height = 64;

  ctx.clearRect(0, 0, 256, 64);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  roundRect(ctx, 4, 4, 248, 56, 12);
  ctx.fill();

  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ff8800';
  ctx.fillText(text, 128, 32);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2, 0.5, 1);
  sprite.raycast = () => {};
  return sprite;
}

function updateLockOverlayPosition(group, obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  const oldLines = group.children.find(c => c.isLineSegments);
  if (oldLines) {
    group.remove(oldLines);
    oldLines.geometry.dispose();
    oldLines.material.dispose();
  }
  const newLines = createCornerLines(obj);
  group.add(newLines);

  const label = group.children.find(c => c.isSprite);
  if (label) {
    label.position.set(center.x, box.max.y + size.y * 0.3 + 0.5, center.z);
  }
}

function addLockOverlay(objectId, fromInfo) {
  removeLockOverlay(objectId);

  const obj = managedObjects.get(objectId);
  if (!obj) return;

  const group = new THREE.Group();
  group.userData._isLockOverlay = true;
  group.raycast = () => {};

  const cornerLines = createCornerLines(obj);
  group.add(cornerLines);

  const nickname = fromInfo?.nickname || fromInfo?.from?.nickname || '?';
  const label = createLockLabel('🔒 ' + nickname);
  group.add(label);

  updateLockOverlayPosition(group, obj);

  scene.add(group);
  lockOverlays.set(objectId, { group, target: obj });
}

function removeLockOverlay(objectId) {
  const entry = lockOverlays.get(objectId);
  if (!entry) return;

  const { group } = entry;
  scene.remove(group);
  group.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  });

  lockOverlays.delete(objectId);
}

// ── ロード中オーバーレイ ─────────────────────────────────

// objectId → { group, placeholder }
const loadingOverlays = new Map();

function createLoadingLabel(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 512;
  canvas.height = 128;

  ctx.clearRect(0, 0, 512, 128);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  roundRect(ctx, 4, 4, 504, 120, 16);
  ctx.fill();

  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#88ccff';
  ctx.fillText('読み込み中…', 256, 38);

  ctx.font = '24px sans-serif';
  ctx.fillStyle = '#ffffff';
  const maxWidth = 480;
  let label = text;
  if (ctx.measureText(label).width > maxWidth) {
    while (label.length > 1 && ctx.measureText(label + '…').width > maxWidth) {
      label = label.slice(0, -1);
    }
    label = label + '…';
  }
  ctx.fillText(label, 256, 86);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3, 0.75, 1);
  sprite.raycast = () => {};
  return sprite;
}

function createObjectNameLabel(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 512;
  canvas.height = 128;

  ctx.clearRect(0, 0, 512, 128);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  roundRect(ctx, 4, 4, 504, 120, 16);
  ctx.fill();

  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';

  const maxWidth = 470;
  let label = text || '';
  if (ctx.measureText(label).width > maxWidth) {
    while (label.length > 1 && ctx.measureText(label + '…').width > maxWidth) {
      label = label.slice(0, -1);
    }
    label = label + '…';
  }
  ctx.fillText(label, 256, 64);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.4, 0.6, 1);
  sprite.raycast = () => {};
  return sprite;
}

function createLoadingPlaceholder() {
  const group = new THREE.Group();

  const geo = new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({
    color: 0x88ccff,
    transparent: true,
    opacity: 0.8,
  });
  const box = new THREE.LineSegments(edges, mat);
  box.raycast = () => {};
  group.add(box);
  geo.dispose();

  return group;
}

function addLoadingOverlay(objectId, name, info) {
  removeLoadingOverlay(objectId);

  const group = new THREE.Group();
  group.userData._isLoadingOverlay = true;
  group.raycast = () => {};

  const placeholder = createLoadingPlaceholder();
  group.add(placeholder);

  const label = createLoadingLabel(name || objectId);
  label.position.set(0, 1.1, 0);
  group.add(label);

  if (info?.position) group.position.fromArray(info.position);

  scene.add(group);
  loadingOverlays.set(objectId, { group, placeholder });
}

function removeLoadingOverlay(objectId) {
  const entry = loadingOverlays.get(objectId);
  if (!entry) return;

  const { group } = entry;
  scene.remove(group);
  group.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  });

  loadingOverlays.delete(objectId);
}

// ── レイキャスト選択 ─────────────────────────────────────

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function selectManagedObject(obj) {
  if (!obj || !obj.userData.objectId) return;

  if (transformCtrl.object && transformCtrl.object !== obj) {
    broadcast({
      kind: 'scene-unlock',
      objectId: transformCtrl.object.userData.objectId,
    });
  }

  transformCtrl.attach(obj);
  broadcast({ kind: 'scene-lock', objectId: obj.userData.objectId });
  showToolbar();
  updateToolbarActive(transformCtrl.mode);
  updatePeersList();
  notifySelectionChanged('object-selected');
}

function selectObjectAt(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const targets = Array.from(managedObjects.values());
  const hits = raycaster.intersectObjects(targets, true);
  if (hits.length > 0) {
    let obj = hits[0].object;
    while (obj.parent && !obj.userData.objectId) obj = obj.parent;
    // ロックオーバーレイは除外
    if (obj.userData._isLockOverlay) return;
    if (obj.userData.objectId) {
      // ロック確認
      if (locks.has(obj.userData.objectId)) {
        const lockInfo = locks.get(obj.userData.objectId);
        const who = lockInfo.nickname || lockInfo.from?.nickname || '他のユーザー';
        showToast(`${who} が編集中です`);
        return;
      }
      selectManagedObject(obj);
    }
  } else {
    if (transformCtrl.object) {
      broadcast({
        kind: 'scene-unlock',
        objectId: transformCtrl.object.userData.objectId
      });
    }
    transformCtrl.detach();
    hideToolbar();
    updatePeersList();
    notifySelectionChanged('selection-cleared-raycast');
  }
}

renderer.domElement.addEventListener('dblclick', (e) => {
  selectObjectAt(e.clientX, e.clientY);
});

// ── タッチ操作（iOS Safari 対応） ───────────────────────

let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;
const DOUBLE_TAP_DELAY = 300;
const DOUBLE_TAP_DISTANCE = 30;
let touchMoved = false;
let singleTapTimer = null;

renderer.domElement.addEventListener('touchstart', (e) => {
  touchMoved = false;
}, { passive: true });

renderer.domElement.addEventListener('touchmove', (e) => {
  touchMoved = true;
}, { passive: true });

function handleDoubleTap(clientX, clientY) {
  selectObjectAt(clientX, clientY);
}

renderer.domElement.addEventListener('touchend', (e) => {
  if (e.touches.length > 0) return;
  const touch = e.changedTouches[0];
  if (!touch) return;

  const now = Date.now();
  const dx = touch.clientX - lastTapX;
  const dy = touch.clientY - lastTapY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  clearTimeout(singleTapTimer);

  if (now - lastTapTime < DOUBLE_TAP_DELAY && dist < DOUBLE_TAP_DISTANCE) {
    // ダブルタップ
    e.preventDefault();
    handleDoubleTap(touch.clientX, touch.clientY);
    lastTapTime = 0;
  } else {
    lastTapTime = now;
    lastTapX = touch.clientX;
    lastTapY = touch.clientY;

    // シングルタップ
    const tapX = touch.clientX;
    const tapY = touch.clientY;
    singleTapTimer = setTimeout(() => {
      if (!touchMoved && transformCtrl.object) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((tapX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((tapY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const targets = Array.from(managedObjects.values());
        const hits = raycaster.intersectObjects(targets, true);
        if (hits.length === 0) {
          broadcast({
            kind: 'scene-unlock',
            objectId: transformCtrl.object.userData.objectId,
          });
          transformCtrl.detach();
          hideToolbar();
        }
      }
    }, DOUBLE_TAP_DELAY + 50);
  }
}, { passive: false });

// ── 削除ロジック（共通） ──────────────────────────────────

function deleteSelectedObject() {
  const attached = transformCtrl.object;
  if (!attached) return;

  let deleteId = null;
  for (const [id, obj] of managedObjects) {
    if (obj === attached) {
      deleteId = id;
      break;
    }
  }

  transformCtrl.detach();
  hideToolbar();

  if (deleteId) {
    if (locks.has(deleteId)) {
      const lockInfo = locks.get(deleteId);
      const lockOwnerId = lockInfo?.id;
      if (lockOwnerId && lockOwnerId !== presenceState.id) {
        showToast('他のユーザーが編集中です');
        return;
      }
      // 自分のロックなら unlock をブロードキャストして解除
      broadcast({ kind: 'scene-unlock', objectId: deleteId });
    }

    removeLockOverlay(deleteId);
    locks.delete(deleteId);

    // 削除前にオブジェクト情報を保存
    const name = attached.userData.name || deleteId;
    const position = attached.position.toArray();
    const rotation = attached.quaternion.toArray();
    const scale = attached.scale.toArray();
    const asset = attached.userData.asset || {};

    scene.remove(attached);
    attached.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
    managedObjects.delete(deleteId);

    // 履歴に追加
    presenceState.historyManager.push(
      HistoryManager.createRemoveEntry(deleteId, name, asset, position, rotation, scale)
    );

    broadcast({ kind: 'scene-remove', objectId: deleteId });
    notifySceneStateChanged('selected-object-deleted');
  }
}

// ── モバイルツールバー ──────────────────────────────────

const toolbar = document.getElementById('mobile-toolbar');
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnMove = document.getElementById('btn-move');
const btnRotate = document.getElementById('btn-rotate');
const btnScale = document.getElementById('btn-scale');
const btnDelete = document.getElementById('btn-delete');
const btnDeselect = document.getElementById('btn-deselect');

function showToolbar() {
  if (toolbar) toolbar.style.display = 'flex';
}

function hideToolbar() {
  if (toolbar) toolbar.style.display = 'none';
}

function updateToolbarActive(mode) {
  [btnMove, btnRotate, btnScale].forEach(b => b?.classList.remove('active'));
  if (mode === 'translate') btnMove?.classList.add('active');
  if (mode === 'rotate') btnRotate?.classList.add('active');
  if (mode === 'scale') btnScale?.classList.add('active');
}

btnMove?.addEventListener('click', () => {
  transformCtrl.setMode('translate');
  updateToolbarActive('translate');
});

btnRotate?.addEventListener('click', () => {
  transformCtrl.setMode('rotate');
  updateToolbarActive('rotate');
});

btnScale?.addEventListener('click', () => {
  transformCtrl.setMode('scale');
  updateToolbarActive('scale');
});

btnDeselect?.addEventListener('click', () => {
  if (transformCtrl.object) {
    broadcast({
      kind: 'scene-unlock',
      objectId: transformCtrl.object.userData.objectId,
    });
  }
  transformCtrl.detach();
  hideToolbar();
  notifySelectionChanged('selection-cleared-button');
});

btnDelete?.addEventListener('click', () => {
  deleteSelectedObject();
});

// ── Undo/Redo ボタン ──────────────────────────────────────

function updateHistoryButtonState() {
  const canUndo = presenceState.historyManager.canUndo();
  const canRedo = presenceState.historyManager.canRedo();

  if (btnUndo) btnUndo.disabled = !canUndo;
  if (btnRedo) btnRedo.disabled = !canRedo;
}

btnUndo?.addEventListener('click', () => {
  if (presenceState.historyManager.canUndo()) {
    performUndo();
  }
});

btnRedo?.addEventListener('click', () => {
  if (presenceState.historyManager.canRedo()) {
    performRedo();
  }
});

// ── キーボードショートカット ──────────────────────────────

window.addEventListener('keydown', (e) => {
  // テキスト入力中は無視
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // ドラッグ中は Undo/Redo を無効化
  if (isDragging) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'y')) {
      e.preventDefault();
      return;
    }
  }

  // Undo: Ctrl+Z (Cmd+Z on Mac)
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    performUndo();
    return;
  }

  // Redo: Ctrl+Y or Ctrl+Shift+Z (Cmd+Shift+Z on Mac)
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault();
    performRedo();
    return;
  }

  switch (e.key.toLowerCase()) {
    case 'w': transformCtrl.setMode('translate'); break;
    case 'e': transformCtrl.setMode('rotate'); break;
    case 'r': transformCtrl.setMode('scale'); break;
    case 'escape':
      if (transformCtrl.object) {
        broadcast({
          kind: 'scene-unlock',
          objectId: transformCtrl.object.userData.objectId,
        });
      }
      transformCtrl.detach();
      hideToolbar();
      break;
    case 'delete':
    case 'backspace': {
      e.preventDefault();
      deleteSelectedObject();
      break;
    }
  }
});

// ── リサイズ ─────────────────────────────────────────────

function onResize() {
  if (xrState.active) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

window.addEventListener('resize', onResize);
// iOS Safari はキーボード閉鎖時に window.resize が発火しないため
// visualViewport.resize でも監視して canvas サイズを確実に復元する
window.visualViewport?.addEventListener('resize', onResize);

// ── MR hit-test 毎フレーム更新 ─────────────────────────
function updateXrHitTest(frame) {
  const reticle = xrState.floor.reticle;
  if (!reticle) {
    if (Math.random() < 0.01) console.log('[XR-debug] no reticle');
    return;
  }

  // 床合わせモード中でなければレチクルを隠す
  if (!xrState.floor.calibrating) {
    reticle.visible = false;
    xrState.floor.lastHitY = null;
    return;
  }

  if (!frame) {
    if (Math.random() < 0.01) console.log('[XR-debug] no frame');
    reticle.visible = false;
    return;
  }

  if (!xrState.floor.hitTestSource) {
    if (Math.random() < 0.01) console.log('[XR-debug] no hitTestSource');
    reticle.visible = false;
    return;
  }

  const refSpace = xrState.floor.offsetSpace || xrState.floor.referenceSpace;
  if (!refSpace) {
    if (Math.random() < 0.01) console.log('[XR-debug] no refSpace');
    reticle.visible = false;
    return;
  }

  // HMD（視線）の hit-test のみを使用
  const results = frame.getHitTestResults(xrState.floor.hitTestSource);
  if (Math.random() < 0.02) {
    console.log('[XR-debug] hit results:', results.length);
  }
  if (results.length === 0) {
    reticle.visible = false;
    xrState.floor.lastHitY = null;
    return;
  }

  const pose = results[0].getPose(refSpace);
  if (!pose) {
    reticle.visible = false;
    return;
  }

  reticle.visible = true;
  reticle.matrix.fromArray(pose.transform.matrix);
  reticle.matrix.decompose(reticle.position, reticle.quaternion, reticle.scale);
  reticle.matrixAutoUpdate = true;
  reticle.updateMatrixWorld(true);
  xrState.floor.lastHitY = pose.transform.position.y;
  xrState.floor.lastHitPose = pose;
}


// ── レンダリングループ ────────────────────────────────────

renderer.setAnimationLoop((time, frame) => {
  if (!xrState.active) {
    orbit.update();
  }

  for (const [objectId, entry] of lockOverlays) {
    if (entry.target && entry.group) {
      updateLockOverlayPosition(entry.group, entry.target);
    }
  }

  for (const [objectId, entry] of loadingOverlays) {
    if (entry.placeholder) {
      entry.placeholder.rotation.y += 0.02;
    }
  }

  if (xrState.active) {
    updateXrGrab();
    updateXrHitTest(frame);
  }

  sendAvatarPose(time);
  remoteAvatarManager.updateRemoteAvatars(time);

  renderer.render(scene, camera);
});

// ── Presence 接続 ────────────────────────────────────────

const statusEl = document.getElementById('status');
const dotEl = statusEl.querySelector('.dot');
const nicknameLabel = document.getElementById('nickname-label');
const nicknameChip = document.getElementById('nickname-chip');
const roomSectionEl = document.getElementById('room-section');
const sceneInspectorToggleBtn = document.getElementById('scene-inspector-toggle');
const sceneInspectorPanel = document.getElementById('scene-inspector-panel');
const sceneInspectorCloseBtn = document.getElementById('scene-inspector-close');
const sceneInspectorRefreshBtn = document.getElementById('scene-inspector-refresh');
const sceneInspectorCopyBtn = document.getElementById('scene-inspector-copy');
const sceneInspectorEditBtn = document.getElementById('scene-inspector-edit');
const sceneInspectorFormatBtn = document.getElementById('scene-inspector-format');
const sceneInspectorResetBtn = document.getElementById('scene-inspector-reset');
const sceneInspectorValidateBtn = document.getElementById('scene-inspector-validate');
const sceneInspectorApplyBtn = document.getElementById('scene-inspector-apply');
const sceneInspectorCancelBtn = document.getElementById('scene-inspector-cancel');
const sceneInspectorSummaryEl = document.getElementById('scene-inspector-summary');
const sceneInspectorModeEl = document.getElementById('scene-inspector-mode');
const sceneInspectorEditNoteEl = document.getElementById('scene-inspector-edit-note');
const sceneInspectorEditMetaEl = document.getElementById('scene-inspector-edit-meta');
const sceneInspectorValidationEl = document.getElementById('scene-inspector-validation');
const sceneInspectorDiffEl = document.getElementById('scene-inspector-diff');
const sceneInspectorEditorEl = document.getElementById('scene-inspector-editor');
const sceneInspectorOutputEl = document.getElementById('scene-inspector-output');
const sceneInspectorObjectMetaEl = document.getElementById('scene-inspector-object-meta');
const sceneInspectorObjectEmptyEl = document.getElementById('scene-inspector-object-empty');
const sceneInspectorObjectHeadEl = document.getElementById('scene-inspector-object-head');
const sceneInspectorObjectActionsEl = document.getElementById('scene-inspector-object-actions');
const sceneInspectorObjectEditBtn = document.getElementById('scene-inspector-object-edit');
const sceneInspectorObjectFormatBtn = document.getElementById('scene-inspector-object-format');
const sceneInspectorObjectResetBtn = document.getElementById('scene-inspector-object-reset');
const sceneInspectorObjectValidateBtn = document.getElementById('scene-inspector-object-validate');
const sceneInspectorObjectApplyBtn = document.getElementById('scene-inspector-object-apply');
const sceneInspectorObjectCancelBtn = document.getElementById('scene-inspector-object-cancel');
const sceneInspectorObjectNoteEl = document.getElementById('scene-inspector-object-note');
const sceneInspectorObjectValidationEl = document.getElementById('scene-inspector-object-validation');
const sceneInspectorObjectDiffEl = document.getElementById('scene-inspector-object-diff');
const sceneInspectorObjectEditorEl = document.getElementById('scene-inspector-object-editor');
const sceneInspectorObjectOutputEl = document.getElementById('scene-inspector-object-output');

function resolvePresenceUrl() {
  const params = new URLSearchParams(location.search);
  const override = params.get('presence');
  if (override) return override;
  const isLocal = location.hostname === 'localhost'
                 || location.hostname === '127.0.0.1';
  return isLocal ? 'ws://localhost:8787' : 'wss://afjk.jp/presence';
}

function sanitizeRoomCode(s) {
  if (!s) return null;
  const cleaned = String(s).trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  return cleaned || null;
}

function randomRoomCode() {
  return Math.random().toString(36).slice(2, 8);
}

function loadInitialNickname() {
  const nameParam = new URLSearchParams(location.search).get('name');
  if (nameParam) return nameParam.slice(0, 40);
  const stored = localStorage.getItem('pipe.deviceName');
  if (stored) return stored;
  return 'User-' + Math.random().toString(36).slice(2, 6);
}

// ── 参加者一覧 ──────────────────────────────────────────

const peersListEl = document.getElementById('peers-list');

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPeerItem(name, isSelf, editingObjectId) {
  const dotClass = isSelf ? 'peer-dot self' : 'peer-dot';
  const editLabel = editingObjectId ? '✏️' : '';
  const selfLabel = isSelf ? ' (自分)' : '';
  return `<div class="peer-item">`
    + `<span class="${dotClass}"></span>`
    + `<span class="peer-name">${escapeHtml(name)}${selfLabel}</span>`
    + `${editLabel ? `<span class="peer-editing">${editLabel}</span>` : ''}`
    + `</div>`;
}

function updatePeersList() {
  if (!peersListEl) return;

  const editingMap = new Map();
  for (const [objectId, owner] of locks) {
    const ownerId = owner.id || owner;
    editingMap.set(ownerId, objectId);
  }

  let html = '';

  const selfEditing = transformCtrl.object
    ? transformCtrl.object.userData.objectId || ''
    : '';
  html += renderPeerItem(presenceState.nickname || '自分', true, selfEditing);

  for (const peer of presenceState.peers) {
    if (peer.id === presenceState.id) continue;
    const editing = editingMap.get(peer.id) || '';
    html += renderPeerItem(peer.nickname || peer.device || '?', false, editing);
  }

  peersListEl.innerHTML = html;
}

const userManager = createUserManager();

function getApiBaseUrl() {
  const params = new URLSearchParams(location.search);
  const presenceOverride = params.get('presence');
  if (presenceOverride) {
    const url = new URL(presenceOverride, window.location.origin);
    return url.origin + url.pathname + '/api';
  }
  const isLocal = location.hostname === 'localhost'
                 || location.hostname === '127.0.0.1';
  return isLocal ? 'http://localhost:8787/api' : 'https://afjk.jp/presence/api';
}

const linkManager = createLinkManager(getApiBaseUrl());

const presenceState = {
  ws: null,
  id: null,
  userId: userManager.getUserId(),
  room: null,
  nickname: loadInitialNickname(),
  peers: [],
  historyManager: createHistoryManager(),
  linkManager,
};

// 履歴状態が変わったときにボタンを更新
presenceState.historyManager.onChange = () => {
  updateHistoryButtonState();
};

// 初期状態を反映
updateHistoryButtonState();

const remoteAvatarManager = createRemoteAvatarManager({
  scene,
  localPeerId: () => presenceState.id,
  avatarTimeoutMs: AVATAR_TIMEOUT_MS,
});

let activeRoomCode = sanitizeRoomCode(new URLSearchParams(location.search).get('room'));
let sceneReceived = false;
let sceneRequestTimer = null;
let sceneRequestAttempt = 0;
let reconnectTimer = null;
const sceneInspectorState = {
  isOpen: false,
  isEditing: false,
  refreshTimer: null,
  lastReason: null,
  baseSnapshot: null,
  draftText: '',
  parsedSnapshot: null,
  validationErrors: [],
  diffSummary: null,
  lastAppliedSummary: null,
  objectEditor: {
    isEditing: false,
    objectId: null,
    baseObject: null,
    draftText: '',
    parsedObject: null,
    validationErrors: [],
    diffSummary: null,
    lastAppliedSummary: null,
  },
};

// ── Loom 統合初期化 ──────────────────────────────────
const loomIntegration = createSceneSyncLoomIntegration({
  getObjectById: (objectId) => managedObjects.get(objectId) || null,
  send: (payload) => broadcast(payload),
  getServerTime: () => Date.now() / 1000,
  isObjectBeingEdited: (objectId) => {
    if (!objectId) return false;

    const transformObjectId = transformCtrl.object?.userData?.objectId;
    if (transformObjectId === objectId) return true;

    if (xrState.twoHand?.active && xrState.twoHand.object?.userData?.objectId === objectId) {
      return true;
    }

    for (const grabber of xrState.grabbers || []) {
      if (grabber.active && grabber.object?.userData?.objectId === objectId) {
        return true;
      }
    }

    return false;
  },
  showToast,
});

// ── ニックネーム編集 ───────────────────────────────────

function updateNicknameLabel() {
  if (nicknameLabel) nicknameLabel.textContent = presenceState.nickname;
}

function editNickname() {
  const next = prompt('表示名を入力してください', presenceState.nickname) || '';
  const cleaned = next.trim().slice(0, 40);
  if (!cleaned || cleaned === presenceState.nickname) return;
  presenceState.nickname = cleaned;
  localStorage.setItem('pipe.deviceName', cleaned);
  updateNicknameLabel();
  updatePeersList();
  // 接続中なら hello を再送して即時反映
  const ws = presenceState.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'hello',
      nickname: cleaned,
      device: navigator.userAgent.slice(0, 60),
      userId: presenceState.userId,
    }));
  }
}

// ── ルーム制御 ────────────────────────────────────────

function roomShareUrl(code) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('room', code);
  return u.toString();
}

function pipeUrlForRoom(code) {
  const u = new URL('/pipe/', location.href);
  if (code) u.searchParams.set('room', code);
  return u.toString();
}

function resetSceneState() {
  for (const [objectId, obj] of [...managedObjects]) {
    if (objectId === 'sample-cube') continue;
    removeLoadingOverlay(objectId);
    removeLockOverlay(objectId);
    locks.delete(objectId);
    if (transformCtrl.object === obj) transformCtrl.detach();
    scene.remove(obj);
    obj.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    });
    managedObjects.delete(objectId);
  }
  hideToolbar();
  presenceState.peers = [];
  sceneReceived = false;
  sceneRequestAttempt = 0;
  clearTimeout(sceneRequestTimer);
  updatePeersList();
}

function reconnectPresence() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (presenceState.ws) {
    const old = presenceState.ws;
    presenceState.ws = null; // intentional close — onclose will skip reconnect
    try { old.close(); } catch {}
  }
  resetSceneState();
  connectPresence();
  renderRoomSection();
}

function applyRoomCode(code) {
  const cleaned = sanitizeRoomCode(code);
  if (!cleaned) return;
  activeRoomCode = cleaned;
  const u = new URL(location.href);
  u.searchParams.set('room', cleaned);
  history.replaceState(null, '', u.toString());
  reconnectPresence();
  notifyConnectionStateChanged('room-applied');
}

function generateRoom() {
  applyRoomCode(randomRoomCode());
}

function joinRoom(code) {
  applyRoomCode(code);
}

function clearRoom() {
  activeRoomCode = null;
  const u = new URL(location.href);
  u.searchParams.delete('room');
  history.replaceState(null, '', u.toString());
  reconnectPresence();
  notifyConnectionStateChanged('room-cleared');
}

function copyRoomUrl() {
  if (!activeRoomCode) return;
  navigator.clipboard.writeText(roomShareUrl(activeRoomCode))
    .then(() => showToast('URL をコピーしました'))
    .catch(() => showToast('コピーに失敗しました'));
}

function renderRoomSection() {
  if (!roomSectionEl) return;
  roomSectionEl.innerHTML = '';

  if (activeRoomCode) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = `🏠 <span id="room-code">${escapeHtml(activeRoomCode)}</span>`;
    chip.title = 'ルームコード';
    roomSectionEl.appendChild(chip);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'chip';
    copyBtn.textContent = 'URL コピー';
    copyBtn.title = 'ルーム URL をコピー';
    copyBtn.addEventListener('click', copyRoomUrl);
    roomSectionEl.appendChild(copyBtn);

    const pipeLink = document.createElement('a');
    pipeLink.className = 'chip';
    pipeLink.href = pipeUrlForRoom(activeRoomCode);
    pipeLink.textContent = '📥 pipe';
    pipeLink.title = '同じルームを pipe で開く';
    roomSectionEl.appendChild(pipeLink);

    const leaveBtn = document.createElement('button');
    leaveBtn.type = 'button';
    leaveBtn.className = 'chip danger';
    leaveBtn.textContent = '退場';
    leaveBtn.addEventListener('click', clearRoom);
    roomSectionEl.appendChild(leaveBtn);
  } else {
    const noRoomChip = document.createElement('div');
    noRoomChip.className = 'chip';
    noRoomChip.innerHTML = '🏠 <span style="opacity:0.6">未設定</span>';
    roomSectionEl.appendChild(noRoomChip);

    const genBtn = document.createElement('button');
    genBtn.type = 'button';
    genBtn.className = 'chip primary';
    genBtn.textContent = '作成';
    genBtn.title = '新しいルームを作成';
    genBtn.addEventListener('click', generateRoom);
    roomSectionEl.appendChild(genBtn);

    const pipeLink = document.createElement('a');
    pipeLink.className = 'chip';
    pipeLink.href = pipeUrlForRoom(null);
    pipeLink.textContent = '📥 pipe';
    pipeLink.title = 'pipe を開く';
    roomSectionEl.appendChild(pipeLink);

    const joinGroup = document.createElement('div');
    joinGroup.className = 'join-group';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'room-input';
    input.placeholder = 'コードを入力';
    input.maxLength = 24;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinRoom(input.value);
    });
    joinGroup.appendChild(input);

    const joinBtn = document.createElement('button');
    joinBtn.type = 'button';
    joinBtn.className = 'chip';
    joinBtn.textContent = '参加';
    joinBtn.addEventListener('click', () => joinRoom(input.value));
    joinGroup.appendChild(joinBtn);

    roomSectionEl.appendChild(joinGroup);
  }
}

function connectPresence() {
  const base = resolvePresenceUrl();
  const url = activeRoomCode
    ? `${base}/?room=${encodeURIComponent(activeRoomCode)}`
    : base;

  const ws = new WebSocket(url);
  presenceState.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'hello',
      nickname: presenceState.nickname,
      device: navigator.userAgent.slice(0, 60),
      userId: presenceState.userId,
    }));
  };

  ws.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }

    switch (data.type) {
      case 'welcome':
        presenceState.id = data.id;
        presenceState.room = data.room;
        updateStatus(true);
        updatePeersList();
        notifyConnectionStateChanged('presence-welcome');
        break;

      case 'peers': {
        const isFirstPeers = presenceState.peers.length === 0
          && (data.peers || []).length > 0;
        presenceState.peers = data.peers || [];
        updateStatus(true);
        // 切断したピアのロックを解除
        const peerIds = new Set(data.peers.map(p => p.id));
        for (const [objId, ownerInfo] of locks) {
          const ownerId = ownerInfo?.id || ownerInfo;
          if (!peerIds.has(ownerId) && ownerId !== presenceState.id) {
            locks.delete(objId);
            removeLockOverlay(objId);
          }
        }
        // 切断したピアのアバターを削除
        for (const peerId of Array.from(remoteAvatarManager.remoteAvatars.keys())) {
          if (!peerIds.has(peerId)) remoteAvatarManager.disposeRemoteAvatar(peerId);
        }
        updatePeersList();
        // 初回 peers 受信時にシーンリクエスト
        if (isFirstPeers && !sceneReceived) {
          requestSceneFromPeer();
        }
        notifyConnectionStateChanged('peers-updated');
        break;
      }

      case 'handoff':
        handleHandoff(data);
        break;
    }
  };

  ws.onclose = () => {
    // 意図的な切断（ルーム切替）では presenceState.ws が先に null になる
    if (presenceState.ws !== ws) return;
    presenceState.ws = null;
    updateStatus(false);
    remoteAvatarManager.disposeAllRemoteAvatars();
    updatePeersList();
    notifyConnectionStateChanged('presence-closed');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (presenceState.ws) return;
      sceneReceived = false;
      sceneRequestAttempt = 0;
      clearTimeout(sceneRequestTimer);
      connectPresence();
    }, 3000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

function updateStatus(connected) {
  if (connected) {
    const n = presenceState.peers.length;
    dotEl.className = 'dot on';
    statusEl.innerHTML = `<span class="dot on"></span>${escapeHtml(presenceState.nickname)} · ${escapeHtml(presenceState.room || '—')} · ${n} peer${n !== 1 ? 's' : ''}`;
  } else {
    dotEl.className = 'dot off';
    statusEl.innerHTML = '<span class="dot off"></span>再接続中…';
  }
  notifyConnectionStateChanged(connected ? 'status-connected' : 'status-disconnected');
}

// ── シーンリクエスト（後から参加したクライアント用） ───────

function requestSceneFromPeer() {
  const peers = presenceState.peers.filter(p => p.id !== presenceState.id);
  if (peers.length === 0) {
    sceneReceived = true;
    return;
  }

  if (sceneRequestAttempt >= peers.length) {
    console.warn('[SceneSync] All peers failed to respond');
    sceneReceived = true;
    return;
  }

  const target = peers[sceneRequestAttempt];
  console.log('[SceneSync] Requesting scene from:', target.nickname || target.id);

  const ws = presenceState.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'handoff',
      targetId: target.id,
      payload: { kind: 'scene-request' },
    }));
  }

  clearTimeout(sceneRequestTimer);
  sceneRequestTimer = setTimeout(() => {
    if (!sceneReceived) {
      sceneRequestAttempt++;
      requestSceneFromPeer();
    }
  }, 5000);
}

// ── シーン応答（後から参加したクライアント用） ─────────────

const gltfExporter = new GLTFExporter();

function exportObjectAsGlb(obj) {
  return new Promise((resolve, reject) => {
    const overlayChildren = [];
    obj.traverse(child => {
      if (child.userData._isLockOverlay) {
        overlayChildren.push(child);
      }
    });
    overlayChildren.forEach(c => { c.visible = false; });

    gltfExporter.parse(
      obj,
      (result) => {
        overlayChildren.forEach(c => { c.visible = true; });
        resolve(result);
      },
      (err) => {
        overlayChildren.forEach(c => { c.visible = true; });
        reject(err);
      },
      { binary: true }
    );
  });
}

async function respondToSceneRequest(from) {
  console.log('[SceneSync] Responding to scene-request from:',
    from?.nickname || from?.id);

  const objects = {};

  for (const [objectId, obj] of managedObjects) {
    const entry = {
      name: obj.userData.name || obj.name || objectId,
      position: obj.position.toArray(),
      rotation: obj.quaternion.toArray(),
      scale: obj.scale.toArray(),
    };

    // 保存済み meshPath を再利用（再エクスポート不要）
    if (obj.userData.meshPath) {
      entry.meshPath = obj.userData.meshPath;
    }
    if (obj.userData.asset) {
      entry.asset = structuredClone(obj.userData.asset);
    }

    objects[objectId] = entry;
  }

  const ws = presenceState.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    const payload = { kind: 'scene-state', envId: environmentManager.getCurrentEnvId(), objects };

    // Loom graph state を含める
    const loomGraphState = loomIntegration.exportState();
    if (loomGraphState.scene !== null || Object.keys(loomGraphState.objects).length > 0) {
      payload.loomGraphs = loomGraphState;
    }

    ws.send(JSON.stringify({
      type: 'handoff',
      targetId: from.id,
      payload,
    }));
  }
}

// ── Handoff 受信（Scene Sync 用） ────────────────────────

function handleHandoff(data) {
  const payload = data.payload;
  if (!payload) return;

  // Handle scene-graph-* protocol messages (Loom graph protocol)
  const sceneGraphTypes = new Set(['scene-graph-set', 'scene-graph-clear', 'scene-graph-patch', 'scene-graph-input']);
  if (sceneGraphTypes.has(payload.type)) {
    handleSceneGraphMessage(payload);
    return;
  }

  if (!payload.kind) return;

  // 操作が自分またはAIが代理している場合、履歴に追加するか判定
  const isOwn = data.from.id === presenceState.id;
  const isOnBehalfOf = payload.onBehalfOf === presenceState.userId;
  const shouldTrackHistory = isOwn || isOnBehalfOf;

  switch (payload.kind) {
    case 'scene-state': {
      sceneReceived = true;
      clearTimeout(sceneRequestTimer);
      if (payload.envId) {
        environmentManager.loadEnvironment(payload.envId, {
          source: 'handoff',
          broadcastChange: false,
        });
      }
      const objects = payload.objects || {};
      for (const [objectId, info] of Object.entries(objects)) {
        addOrUpdateObject(objectId, info);
      }

      // Loom graph 状態を復元
      if (payload.loomGraphs) {
        try {
          loomIntegration.importState(payload.loomGraphs);
        } catch (error) {
          console.warn('[loom] failed to import loomGraphs from scene-state:', error);
          showToast?.('Loom graph restore failed');
        }
      }
      notifySceneStateChanged('scene-state-handoff');
      break;
    }
    case 'scene-request': {
      respondToSceneRequest(data.from);
      break;
    }
    case 'scene-delta': {
      if (isOwn) break; // 自分の echo は無視
      const obj = managedObjects.get(payload.objectId);
      if (!obj) break;
      const beforePos = obj.position.toArray();
      const beforeRot = obj.quaternion.toArray();
      const beforeScl = obj.scale.toArray();
      if (typeof payload.name === 'string') applyObjectName(obj, payload.name);
      if (payload.position) obj.position.fromArray(payload.position);
      if (payload.rotation) obj.quaternion.fromArray(payload.rotation);
      if (payload.scale) obj.scale.fromArray(payload.scale);
      if (typeof payload.visible === 'boolean') applyObjectVisibility(obj, payload.visible);
      if (payload.asset) {
        applyAssetDelta(obj, payload.asset);
      }
      if (shouldTrackHistory && isOnBehalfOf) {
        const afterPos = obj.position.toArray();
        const afterRot = obj.quaternion.toArray();
        const afterScl = obj.scale.toArray();
        const historyEntry = HistoryManager.createDeltaEntry(
          payload.objectId,
          obj.userData?.name || payload.objectId,
          beforePos,
          beforeRot,
          beforeScl,
          afterPos,
          afterRot,
          afterScl
        );
        presenceState.historyManager.push(historyEntry);
      }
      notifySceneStateChanged('scene-delta-handoff');
      break;
    }
    case 'scene-add': {
      if (isOwn) break; // 自分の echo は無視
      addOrUpdateObject(payload.objectId, payload);
      if (shouldTrackHistory && isOnBehalfOf) {
        const historyEntry = HistoryManager.createAddEntry(
          payload.objectId,
          payload.asset,
          payload.position || [0, 0, 0],
          payload.rotation || [0, 0, 0, 1],
          payload.scale || [1, 1, 1],
          payload.name || payload.objectId,
          payload.meshPath
        );
        presenceState.historyManager.push(historyEntry);
      }
      notifySceneStateChanged('scene-add-handoff');
      break;
    }
    case 'scene-remove': {
      const objectId = payload.objectId;
      const obj = managedObjects.get(objectId);
      if (shouldTrackHistory && isOnBehalfOf && obj) {
        const historyEntry = HistoryManager.createRemoveEntry(
          objectId,
          obj.userData?.name || objectId,
          obj.userData?.asset || {},
          obj.position.toArray(),
          obj.quaternion.toArray(),
          obj.scale.toArray()
        );
        presenceState.historyManager.push(historyEntry);
      }
      removeLockOverlay(objectId);
      locks.delete(objectId);
      if (obj) {
        if (transformCtrl.object === obj) { transformCtrl.detach(); hideToolbar(); }
        scene.remove(obj);
        managedObjects.delete(objectId);
      }
      // Loom object graph をクリーンアップ
      loomIntegration.clearObjectGraph(objectId);
      notifySceneStateChanged('scene-remove-handoff');
      break;
    }
    case 'scene-mesh': {
      const obj = managedObjects.get(payload.objectId);
      const loadingName = obj?.userData?.name || payload.meshPath;
      const loadingInfo = obj ? {
        position: obj.position.toArray(),
        rotation: obj.quaternion.toArray(),
        scale: obj.scale.toArray(),
      } : null;
      addLoadingOverlay(payload.objectId, loadingName, loadingInfo);
      const url = BLOB_BASE + '/' + payload.meshPath;
      const initialPosition = payload.position
        ? new THREE.Vector3().fromArray(payload.position)
        : undefined;

      glbLoader.loadFromUrl(url, initialPosition, scene, (model) => {
        removeLoadingOverlay(payload.objectId);
        model.userData.objectId = payload.objectId;
        model.userData.name = obj?.userData?.name || payload.name || payload.meshPath;
        model.userData.meshPath = payload.meshPath;

        if (obj) {
          // 位置・回転・スケールを引き継ぐ
          model.position.copy(obj.position);
          model.quaternion.copy(obj.quaternion);
          model.scale.copy(obj.scale);
          if (transformCtrl.object === obj) transformCtrl.detach();
          scene.remove(obj);
        } else {
          applyTransform(model, payload);
        }
        managedObjects.set(payload.objectId, model);
        notifySceneStateChanged('scene-mesh-loaded');
      }).catch((err) => {
        removeLoadingOverlay(payload.objectId);
        // glB ロード失敗時のフォールバック
        console.warn('Failed to load mesh:', err);
        // 既存オブジェクトがあれば使用し続ける、なければ Box を生成
        if (!obj) {
          const geo = new THREE.BoxGeometry(1, 1, 1);
          const mat = new THREE.MeshStandardMaterial({ color: 0xff4444 });
          const fallback = new THREE.Mesh(geo, mat);
          fallback.userData.objectId = payload.objectId;
          scene.add(fallback);
          managedObjects.set(payload.objectId, fallback);
          notifySceneStateChanged('scene-mesh-fallback-created');
          return;
        }
        notifySceneStateChanged('scene-mesh-load-failed');
      });
      break;
    }
    case 'scene-lock': {
      locks.set(payload.objectId, data.from);
      addLockOverlay(payload.objectId, data.from);
      updatePeersList();
      notifySceneStateChanged('scene-lock-handoff');
      break;
    }
    case 'scene-unlock': {
      locks.delete(payload.objectId);
      removeLockOverlay(payload.objectId);
      updatePeersList();
      notifySceneStateChanged('scene-unlock-handoff');
      break;
    }
    case 'scene-env': {
      if (payload.envId) {
        const beforeEnvId = environmentManager.getCurrentEnvId?.() || 'outdoor_day';
        environmentManager.loadEnvironment(payload.envId, {
          source: 'remote',
          broadcastChange: false,
        });
        if (shouldTrackHistory && isOnBehalfOf) {
          const historyEntry = HistoryManager.createEnvEntry(beforeEnvId, payload.envId);
          presenceState.historyManager.push(historyEntry);
        }
      }
      notifySceneStateChanged('scene-env-handoff');
      break;
    }
    case 'scene-avatar': {
      remoteAvatarManager.handleAvatarMessage(payload);
      break;
    }
    case 'scene-batch': {
      payload.actions?.forEach(action => {
        handleHandoff({ ...data, payload: action });
      });
      notifySceneStateChanged('scene-batch-handoff');
      break;
    }
    case 'ai-command': {
      void handleAiCommand(data.from, payload);
      break;
    }
    case 'ai-link-established': {
      const matchesPeer = payload.peerId && payload.peerId === presenceState.id;
      const matchesLegacyUser = !payload.peerId && payload.userId === presenceState.userId;
      if (matchesPeer || matchesLegacyUser) {
        presenceState.linkManager.establishLink({
          linkId: payload.linkId,
          roomId: payload.roomId || presenceState.room,
          expiresAt: payload.expiresAt
        });
        showPairingDialogLinked(payload.expiresAt);
        showToast('AIリンクが確立しました');
      }
      break;
    }
    case 'ai-link-revoked': {
      if (presenceState.linkManager.linkId === payload.linkId) {
        presenceState.linkManager.clearLocal();
        updateLinkButtonState();
        showToast('AIリンクが解除されました');
      }
      break;
    }
    default:
      break;
  }
}

function handleSceneGraphMessage(msg) {
  loomIntegration.handlePayload(msg);
}

function sendAiResult(targetId, requestId, result = {}) {
  const ws = presenceState.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN || !targetId) return;
  ws.send(JSON.stringify({
    type: 'handoff',
    targetId,
    payload: {
      kind: 'ai-result',
      requestId,
      ...result,
    },
  }));
}

function getCameraPose() {
  return {
    position: camera.position.toArray(),
    quaternion: camera.quaternion.toArray(),
  };
}

function focusCameraOnObject(objectId) {
  const obj = managedObjects.get(objectId);
  if (!obj) {
    return { ok: false, error: `object not found: ${objectId}` };
  }

  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 1);
  const direction = camera.position.clone().sub(orbit.target);
  if (direction.lengthSq() < 1e-6) {
    direction.set(1, 0.6, 1);
  }
  direction.normalize();

  orbit.target.copy(center);
  camera.position.copy(center.clone().add(direction.multiplyScalar(radius * 2.5)));
  camera.lookAt(center);
  orbit.update();

  return {
    ok: true,
    objectId,
    target: center.toArray(),
    camera: getCameraPose(),
  };
}

function captureScreenshotBlob() {
  return new Promise((resolve, reject) => {
    const canvas = renderer.domElement;
    if (!canvas) {
      reject(new Error('renderer canvas not available'));
      return;
    }

    const tcHelper = transformCtrl.getHelper?.();
    const tcWasVisible = tcHelper ? tcHelper.visible : false;
    try {
      if (tcHelper) {
        tcHelper.visible = false;
      }
      renderer.render(scene, camera);
    } catch (err) {
      if (tcHelper) {
        tcHelper.visible = tcWasVisible;
      }
      reject(err);
      return;
    }
    const finish = (blob) => {
      if (tcHelper) {
        tcHelper.visible = tcWasVisible;
      }
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error('failed to encode screenshot'));
    };

    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(finish, 'image/jpeg', 0.92);
      return;
    }

    try {
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const base64 = dataUrl.split(',')[1] || '';
      const bytes = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
      finish(new Blob([bytes], { type: 'image/jpeg' }));
    } catch (err) {
      reject(err);
    }
  });
}

async function uploadBlobToStore(blob, contentType = 'application/octet-stream', extension = '') {
  const path = `${generateRandomPath()}${extension}`;
  const res = await fetch(`${BLOB_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: blob,
  });
  if (!res.ok) {
    throw new Error(`blob upload failed: ${res.status}`);
  }
  return {
    path,
    url: `${BLOB_BASE}/${path}`,
  };
}

async function uploadGlbFromUrl(url, params = {}) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch glb: ${response.status}`);
  }

  const blob = await response.blob();
  const fileName = params.name || url.split('/').pop() || 'remote.glb';
  const file = new File([blob], fileName, { type: blob.type || 'model/gltf-binary' });
  const objectId = params.objectId || `web-${Math.random().toString(36).slice(2, 10)}`;
  const position = Array.isArray(params.position)
    ? new THREE.Vector3().fromArray(params.position)
    : new THREE.Vector3(0, 0, 0);

  const model = await glbLoader.loadFromFile(file, position, scene);

  if (Array.isArray(params.rotation) && params.rotation.length === 4) {
    model.quaternion.fromArray(params.rotation);
  }

  if (Array.isArray(params.scale) && params.scale.length === 3) {
    model.scale.fromArray(params.scale);
  }

  model.userData.objectId = objectId;
  model.userData.name = file.name;
  managedObjects.set(model.userData.objectId, model);
  selectManagedObject(model);
  notifySceneStateChanged('glb-uploaded-from-url');

  const arrayBuffer = await blob.arrayBuffer();
  await uploadAndBroadcast(
    model.userData.objectId,
    file.name,
    model,
    arrayBuffer
  );

  return {
    ok: true,
    objectId,
    name: file.name,
    position: model.position.toArray(),
    rotation: model.quaternion.toArray(),
    scale: model.scale.toArray(),
  };
}

async function handleAiCommand(from, payload) {
  const requestId = payload.requestId || `req-${Date.now()}`;

  try {
    let result;
    switch (payload.action) {
      case 'getCameraPose':
        result = { ok: true, pose: getCameraPose() };
        break;
      case 'focusObject':
        result = focusCameraOnObject(payload.params?.objectId);
        break;
      case 'undo':
        if (!presenceState.historyManager.canUndo()) {
          result = { ok: false, error: 'nothing to undo' };
          break;
        }
        performUndo();
        result = { ok: true, history: presenceState.historyManager.getHistory(10) };
        break;
      case 'redo':
        if (!presenceState.historyManager.canRedo()) {
          result = { ok: false, error: 'nothing to redo' };
          break;
        }
        performRedo();
        result = { ok: true, history: presenceState.historyManager.getHistory(10) };
        break;
      case 'getHistory':
        result = {
          ok: true,
          history: presenceState.historyManager.getHistory(payload.params?.count || 10),
        };
        break;
      case 'screenshot': {
        const blob = await captureScreenshotBlob();
        const uploaded = await uploadBlobToStore(blob, 'image/jpeg', '.jpg');
        result = { ok: true, ...uploaded };
        break;
      }
      case 'uploadGlbFromUrl':
        result = await uploadGlbFromUrl(payload.params?.url, payload.params || {});
        break;
      default:
        result = { ok: false, error: `unsupported ai-command action: ${payload.action}` };
        break;
    }

    sendAiResult(from.id, requestId, result);
  } catch (err) {
    sendAiResult(from.id, requestId, {
      ok: false,
      error: err?.message || String(err),
    });
  }
}

// ── シーン同期ヘルパー ───────────────────────────────────

function addOrUpdateObject(objectId, info) {
  const existing = managedObjects.get(objectId);
  const asset = info.asset;

  if (asset) {
    switch (asset.type) {
      case 'primitive':
        replaceManagedObject(objectId, buildPrimitiveObject(objectId, info, asset), info);
        return;
      case 'mesh':
        if (asset.meshPath) {
          loadMeshObject(objectId, info, asset.meshPath, existing);
          return;
        }
        break;
      default:
        console.warn(`unsupported asset type: ${asset.type}`);
        replaceManagedObject(objectId, buildUnsupportedAssetObject(objectId, info), info);
        return;
    }
  }

  if (info.meshPath) {
    loadMeshObject(objectId, info, info.meshPath, existing);
    return;
  }

  if (!existing) {
    replaceManagedObject(objectId, buildDefaultBoxObject(objectId, info), info);
    return;
  }

  applyObjectName(existing, info.name);
  applyTransform(existing, info);
  applyObjectVisibility(existing, info.visible);
  notifySceneStateChanged('managed-object-updated');
}

function loadMeshObject(objectId, info, meshPath, existing) {
  addLoadingOverlay(objectId, info.name || objectId, info);
  const url = BLOB_BASE + '/' + meshPath;
  const initialPosition = info.position
    ? new THREE.Vector3().fromArray(info.position)
    : undefined;

  glbLoader.loadFromUrl(url, initialPosition, scene, (model) => {
    removeLoadingOverlay(objectId);
    model.userData.objectId = objectId;
    model.userData.name = info.name;
    model.userData.meshPath = meshPath;
    if (info.asset) model.userData.asset = structuredClone(info.asset);

    if (existing) {
      model.position.copy(existing.position);
      model.quaternion.copy(existing.quaternion);
      model.scale.copy(existing.scale);
      if (transformCtrl.object === existing) transformCtrl.detach();
      scene.remove(existing);
    }

    replaceManagedObject(objectId, model, info);
  }).catch((err) => {
    removeLoadingOverlay(objectId);
    console.warn('Failed to load mesh for', objectId, ':', err);
    if (!existing) {
      replaceManagedObject(objectId, buildDefaultBoxObject(objectId, info, 0xff4444), info);
      return;
    }
    notifySceneStateChanged('mesh-load-failed');
  });
}

function replaceManagedObject(objectId, nextObject, info) {
  const current = managedObjects.get(objectId);
  if (current) {
    if (transformCtrl.object === current) transformCtrl.detach();
    scene.remove(current);
  }

  nextObject.userData.objectId = objectId;
  applyObjectName(nextObject, info.name);
  applyTransform(nextObject, info);
  applyObjectVisibility(nextObject, info.visible);
  scene.add(nextObject);
  managedObjects.set(objectId, nextObject);
  notifySceneStateChanged('managed-object-replaced');
}

function buildDefaultBoxObject(objectId, info, color = 0x4488ff) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color });
  const object = new THREE.Mesh(geometry, material);
  object.userData.objectId = objectId;
  applyObjectName(object, info.name);
  return object;
}

function buildPrimitiveObject(objectId, info, asset) {
  let geometry;
  switch (asset?.primitive) {
    case 'sphere':
      geometry = new THREE.SphereGeometry(0.5, 32, 32);
      break;
    case 'cylinder':
      geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
      break;
    case 'cone':
      geometry = new THREE.ConeGeometry(0.5, 1, 32);
      break;
    case 'plane':
      geometry = new THREE.PlaneGeometry(1, 1);
      break;
    case 'torus':
      geometry = new THREE.TorusGeometry(0.4, 0.15, 16, 48);
      break;
    case 'box':
    default:
      geometry = new THREE.BoxGeometry(1, 1, 1);
      break;
  }

  const material = new THREE.MeshStandardMaterial({
    color: asset?.color || '#888888',
  });
  const object = new THREE.Mesh(geometry, material);
  object.userData.objectId = objectId;
  applyObjectName(object, info.name);
  object.userData.asset = structuredClone(asset);
  return object;
}

function buildUnsupportedAssetObject(objectId, info) {
  const group = new THREE.Group();
  const mesh = buildDefaultBoxObject(objectId, info, 0x888888);
  group.add(mesh);

  const label = createObjectNameLabel(info.name || objectId);
  label.position.set(0, 1.1, 0);
  group.add(label);

  group.userData.objectId = objectId;
  applyObjectName(group, info.name);
  if (info.asset) group.userData.asset = structuredClone(info.asset);
  return group;
}

function applyTransform(obj, info) {
  if (info.position) obj.position.fromArray(info.position);
  if (info.rotation) obj.quaternion.fromArray(info.rotation);
  if (info.scale) obj.scale.fromArray(info.scale);
}

function applyObjectName(obj, name) {
  if (!obj || typeof name !== 'string') return;
  obj.userData.name = name;
  obj.name = name;
}

function applyObjectVisibility(obj, visible) {
  if (!obj || typeof visible !== 'boolean') return;
  obj.visible = visible;
}

function applyObjectColor(obj, color) {
  if (!obj || !color) return;

  obj.traverse((child) => {
    if (!child.isMesh || !child.material) return;

    if (Array.isArray(child.material)) {
      child.material = child.material.map((material) => {
        const cloned = material.clone();
        if (cloned.color) cloned.color.set(color);
        cloned.needsUpdate = true;
        return cloned;
      });
      return;
    }

    const cloned = child.material.clone();
    if (cloned.color) cloned.color.set(color);
    cloned.needsUpdate = true;
    child.material = cloned;
  });
}

function applyAssetDelta(obj, asset) {
  if (!obj || !asset || typeof asset !== 'object') return;

  obj.userData.asset = {
    ...(obj.userData.asset || {}),
    ...structuredClone(asset),
  };

  if (asset.color) {
    applyObjectColor(obj, asset.color);
  }
  notifySceneStateChanged('asset-delta-applied');
}

// ── Undo/Redo 処理 ──────────────────────────────────────

function performUndo() {
  const historyManager = presenceState.historyManager;
  if (!historyManager.canUndo()) return;

  const operation = historyManager.undo();
  if (!operation) return;

  applyOperationToScene(operation);
  broadcast(operation);
}

function performRedo() {
  const historyManager = presenceState.historyManager;
  if (!historyManager.canRedo()) return;

  const operation = historyManager.redo();
  if (!operation) return;

  applyOperationToScene(operation);
  broadcast(operation);
}

function applyOperationToScene(operation) {
  switch (operation.kind) {
    case 'scene-add': {
      addOrUpdateObject(operation.objectId, operation);
      break;
    }
    case 'scene-remove': {
      const obj = managedObjects.get(operation.objectId);
      if (obj) {
        if (transformCtrl.object === obj) {
          transformCtrl.detach();
          hideToolbar();
        }
        scene.remove(obj);
        managedObjects.delete(operation.objectId);
      }
      // Loom object graph をクリーンアップ
      loomIntegration.clearObjectGraph(operation.objectId);
      notifySceneStateChanged('undo-redo-scene-remove');
      break;
    }
    case 'scene-delta': {
      const obj = managedObjects.get(operation.objectId);
      if (obj) {
        if (typeof operation.name === 'string') applyObjectName(obj, operation.name);
        applyTransform(obj, operation);
        if (typeof operation.visible === 'boolean') applyObjectVisibility(obj, operation.visible);
        if (operation.asset) {
          applyAssetDelta(obj, operation.asset);
        }
      }
      notifySceneStateChanged('undo-redo-scene-delta');
      break;
    }
    case 'scene-env': {
      environmentManager.loadEnvironment(operation.envId, {
        source: 'undo-redo',
        broadcastChange: false,
      });
      notifySceneStateChanged('undo-redo-scene-env');
      break;
    }
    case 'scene-batch': {
      operation.actions?.forEach(action => applyOperationToScene(action));
      notifySceneStateChanged('undo-redo-scene-batch');
      break;
    }
  }
}

// ── broadcast 送信ヘルパー（次 Step 以降で使用） ─────────

function broadcast(payload) {
  const ws = presenceState.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'broadcast', payload }));
}

// ── 公開 API（scene.js 内から利用） ──────────────────────

export { scene, camera, renderer, managedObjects, broadcast, presenceState };

function generateRandomPath() {
  return Math.random().toString(36).slice(2, 10);
}

async function uploadAndBroadcast(objectId, name, model, arrayBuffer) {
  const meshPath = generateRandomPath();
  let actualMeshPath = null;

  try {
    try {
      await fetch(BLOB_BASE + '/' + meshPath, {
        method: 'POST',
        headers: { 'Content-Type': 'model/gltf-binary' },
        body: arrayBuffer,
      });
      actualMeshPath = meshPath;
      model.userData.meshPath = meshPath;
    } catch (err) {
      console.warn('POST failed:', err);
      showToast('GLB アップロード失敗: ' + err.message);
      return;
    }

    // 履歴に追加
    const asset = model.userData.asset || {
      type: 'gltf',
      meshPath: actualMeshPath,
    };
    const historyEntry = HistoryManager.createAddEntry(
      objectId,
      asset,
      model.position.toArray(),
      model.quaternion.toArray(),
      model.scale.toArray(),
      name,
      actualMeshPath
    );
    presenceState.historyManager.push(historyEntry);
    notifySceneStateChanged('object-uploaded');

    broadcast({
      kind: 'scene-add',
      objectId,
      name,
      position: model.position.toArray(),
      rotation: model.quaternion.toArray(),
      scale: model.scale.toArray(),
      meshPath: actualMeshPath,
    });
  } finally {
    removeLoadingOverlay(objectId);
  }
}

const dragDropManager = new DragDropManager({
  container: document,
  camera,
  renderer,
  scene,
  fileInput: dom.fileInput,
  addBtn: dom.addBtn,
  dropOverlay: dom.dropOverlay,
  showToast,
  glbLoader,
  getRaycastTargets: () => Array.from(managedObjects.values())
    .filter(obj => obj.userData?.dropRaycastTarget && obj.visible !== false),
  onLoadStart: async ({ objectId, file, position }) => {
    addLoadingOverlay(objectId, file.name, { position: position?.toArray?.() });
  },
  onLoadEnd: async ({ objectId }) => {
    removeLoadingOverlay(objectId);
  },
  onLoaded: async (model, file) => {
    managedObjects.set(model.userData.objectId, model);
    selectManagedObject(model);
    notifySelectionChanged('drag-drop-object-selected');

    const arrayBuffer = await file.arrayBuffer();
    await uploadAndBroadcast(
      model.userData.objectId,
      file.name,
      model,
      arrayBuffer
    );
  },
});

// ── AI ペアリング UI ───────────────────────────────────────────────────

const linkBtn = document.getElementById('link-btn');
const pairingDialog = document.getElementById('pairing-dialog');
const pairingStepCode = document.getElementById('pairing-step-code');
const pairingStepLinked = document.getElementById('pairing-step-linked');
const pairingCode = document.getElementById('pairing-code');
const pairingTimer = document.getElementById('pairing-timer');
const pairingError = document.getElementById('pairing-error');
const btnCancelPairing = document.getElementById('btn-cancel-pairing');
const btnRevokeLink = document.getElementById('btn-revoke-link');
const btnCopyPairingCode = document.getElementById('btn-copy-pairing-code');
const sceneSyncOperatorLink = document.getElementById('scene-sync-operator-link');
const linkIcon = document.getElementById('link-icon');
const linkLabel = document.getElementById('link-label');

let pairingCountdown = null;
let pairingExpireTime = null;

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function updatePairingTimer() {
  if (!pairingExpireTime || !pairingTimer) return;
  const remaining = pairingExpireTime - Date.now();
  pairingTimer.textContent = formatTime(remaining);
  if (remaining <= 0) {
    cancelPairing();
  }
}

function showPairingDialogCode() {
  btnCancelPairing.textContent = '閉じる';
  btnCancelPairing.style.display = 'inline-block';
  btnRevokeLink.style.display = 'none';
  pairingStepCode.style.display = 'block';
  pairingStepLinked.style.display = 'none';
  pairingDialog.style.display = 'flex';
}

async function copyText(text, successMessage = 'コピーしました') {
  if (!text) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.setAttribute('readonly', '');
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }
    showToast(successMessage);
    return true;
  } catch {
    showToast('コピーに失敗しました');
    return false;
  }
}

function copyPairingCode() {
  return copyText(pairingCode?.textContent?.trim(), 'AIリンクコードをコピーしました');
}

function serializeInspectorAsset(asset) {
  if (asset === undefined) return undefined;
  if (asset === null || typeof asset !== 'object') return asset;

  try {
    return structuredClone(asset);
  } catch {
    try {
      return JSON.parse(JSON.stringify(asset));
    } catch {
      return {
        __inspectorSerializationError: true,
        type: asset?.type || null,
      };
    }
  }
}

const EDITABLE_SCENE_OBJECT_FIELDS = new Set([
  'name',
  'label',
  'position',
  'rotation',
  'scale',
  'visible',
  'asset',
]);

function cloneInspectorValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;

  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function valuesEqual(left, right) {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateNumberArray(value, size, path, errors) {
  if (!Array.isArray(value) || value.length !== size) {
    errors.push(`${path} must be an array of ${size} finite numbers.`);
    return false;
  }
  if (!value.every(entry => Number.isFinite(entry))) {
    errors.push(`${path} must contain only finite numbers.`);
    return false;
  }
  return true;
}

function validateColorValue(value, path, errors) {
  const valid = typeof value === 'string' || typeof value === 'number';
  if (!valid) {
    errors.push(`${path} must be a string or number color value.`);
  }
  return valid;
}

function addIgnoredSceneInspectorEntry(entries, path, reason) {
  entries.push({ path, reason });
}

function formatSceneInspectorIgnoredEntry(entry) {
  return `${entry.path}: ${entry.reason}`;
}

function trimSceneInspectorPathPrefix(path, prefix) {
  if (!prefix) return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function getChangedObjectIds(baseObjects, editedObjects) {
  const changedObjectIds = [];
  const allObjectIds = new Set([
    ...Object.keys(baseObjects || {}),
    ...Object.keys(editedObjects || {}),
  ]);
  for (const objectId of allObjectIds) {
    if (!valuesEqual(baseObjects?.[objectId], editedObjects?.[objectId])) {
      changedObjectIds.push(objectId);
    }
  }
  return changedObjectIds.sort((left, right) => left.localeCompare(right));
}

function buildSceneInspectorEditableDiff(baseSnapshot, editedSnapshot) {
  const errors = [];
  const ignoredEntries = [];
  const lockedObjectIds = [];
  const actions = [];
  const changedFieldsByObject = [];

  if (!editedSnapshot || typeof editedSnapshot !== 'object' || Array.isArray(editedSnapshot)) {
    errors.push('Edited JSON must be an object.');
    return { errors, summary: null, operation: null };
  }

  if (!editedSnapshot.objects || typeof editedSnapshot.objects !== 'object' || Array.isArray(editedSnapshot.objects)) {
    errors.push('Edited JSON must include an `objects` map.');
    return { errors, summary: null, operation: null };
  }

  const baseObjects = baseSnapshot?.objects || {};
  const editedObjects = editedSnapshot.objects || {};

  const rootKeys = new Set([
    ...Object.keys(baseSnapshot || {}),
    ...Object.keys(editedSnapshot || {}),
  ]);
  for (const key of rootKeys) {
    if (key === 'objects') continue;
    if (!valuesEqual(baseSnapshot?.[key], editedSnapshot?.[key])) {
      addIgnoredSceneInspectorEntry(
        ignoredEntries,
        key,
        'root metadata is not editable in this prototype'
      );
    }
  }

  const changedObjectIds = getChangedObjectIds(baseObjects, editedObjects);
  for (const objectId of changedObjectIds) {
    const baseObject = baseObjects[objectId];
    const editedObject = editedObjects[objectId];

    if (!baseObject) {
      addIgnoredSceneInspectorEntry(
        ignoredEntries,
        `objects.${objectId}`,
        'adding new objects is not supported'
      );
      continue;
    }
    if (!editedObject || typeof editedObject !== 'object' || Array.isArray(editedObject)) {
      addIgnoredSceneInspectorEntry(
        ignoredEntries,
        `objects.${objectId}`,
        'removing objects is not supported'
      );
      continue;
    }
    if (isLockedByOthers(objectId)) {
      lockedObjectIds.push(objectId);
      continue;
    }

    const objectDelta = {
      kind: 'scene-delta',
      objectId,
    };
    const changedFields = [];

    const editedLabel = typeof editedObject.label === 'string' ? editedObject.label : undefined;
    const editedName = typeof editedObject.name === 'string'
      ? editedObject.name
      : editedLabel;
    if (editedName !== undefined && editedName !== baseObject.name) {
      objectDelta.name = editedName;
      changedFields.push('name');
    }

    if (!valuesEqual(baseObject.position, editedObject.position)) {
      if (validateNumberArray(editedObject.position, 3, `objects.${objectId}.position`, errors)) {
        objectDelta.position = [...editedObject.position];
        changedFields.push('position');
      }
    }

    if (!valuesEqual(baseObject.rotation, editedObject.rotation)) {
      if (validateNumberArray(editedObject.rotation, 4, `objects.${objectId}.rotation`, errors)) {
        objectDelta.rotation = [...editedObject.rotation];
        changedFields.push('rotation');
      }
    }

    if (!valuesEqual(baseObject.scale, editedObject.scale)) {
      if (validateNumberArray(editedObject.scale, 3, `objects.${objectId}.scale`, errors)) {
        objectDelta.scale = [...editedObject.scale];
        changedFields.push('scale');
      }
    }

    if (!valuesEqual(baseObject.visible, editedObject.visible)) {
      if (typeof editedObject.visible !== 'boolean') {
        errors.push(`objects.${objectId}.visible must be a boolean.`);
      } else {
        objectDelta.visible = editedObject.visible;
        changedFields.push('visible');
      }
    }

    if (!valuesEqual(baseObject.asset, editedObject.asset)) {
      const baseAsset = baseObject.asset;
      const editedAsset = editedObject.asset;
      const baseAssetIsPrimitive = baseAsset?.type === 'primitive';
      const assetKeys = new Set([
        ...Object.keys(baseAsset || {}),
        ...Object.keys(editedAsset || {}),
      ]);
      const changedAssetKeys = Array.from(assetKeys)
        .filter((key) => !valuesEqual(baseAsset?.[key], editedAsset?.[key]));

      const unsupportedAssetKeys = changedAssetKeys.filter((key) => key !== 'color');
      if (unsupportedAssetKeys.length > 0) {
        for (const key of unsupportedAssetKeys) {
          addIgnoredSceneInspectorEntry(
            ignoredEntries,
            `objects.${objectId}.asset.${key}`,
            'only asset.color is editable in this prototype'
          );
        }
      }

      if (changedAssetKeys.includes('color')) {
        if (!editedAsset || typeof editedAsset !== 'object' || Array.isArray(editedAsset)) {
          addIgnoredSceneInspectorEntry(
            ignoredEntries,
            `objects.${objectId}.asset.color`,
            'color edits require an asset object'
          );
        } else if (!baseAssetIsPrimitive) {
          addIgnoredSceneInspectorEntry(
            ignoredEntries,
            `objects.${objectId}.asset.color`,
            'color edits are limited to primitive objects'
          );
        } else if (validateColorValue(editedAsset?.color, `objects.${objectId}.asset.color`, errors)) {
          objectDelta.asset = { color: editedAsset.color };
          changedFields.push('asset.color');
        }
      }
    }

    const objectKeys = new Set([
      ...Object.keys(baseObject || {}),
      ...Object.keys(editedObject || {}),
    ]);
    for (const key of objectKeys) {
      if (EDITABLE_SCENE_OBJECT_FIELDS.has(key)) continue;
      if (!valuesEqual(baseObject?.[key], editedObject?.[key])) {
        addIgnoredSceneInspectorEntry(
          ignoredEntries,
          `objects.${objectId}.${key}`,
          'field is not editable'
        );
      }
    }

    if (changedFields.length > 0) {
      actions.push(objectDelta);
      changedFieldsByObject.push({ objectId, fields: changedFields });
    }
  }

  const summary = {
    actionCount: actions.length,
    changedObjectCount: changedFieldsByObject.length,
    changedFieldCount: changedFieldsByObject.reduce((count, entry) => count + entry.fields.length, 0),
    changedFieldsByObject,
    ignoredEntries: ignoredEntries.sort((left, right) =>
      left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason)
    ),
    lockedObjectIds: lockedObjectIds.sort((left, right) => left.localeCompare(right)),
  };

  const operation = actions.length === 0
    ? null
    : (actions.length === 1 ? actions[0] : { kind: 'scene-batch', actions });

  return { errors, summary, operation };
}

function formatSceneInspectorSummary(summary, options = {}) {
  if (!summary) return '';
  const changedPrefix = options.changedPrefix || '';
  const ignoredPrefix = options.ignoredPrefix || '';
  const changedLabel = options.changedLabel || null;
  if (summary.actionCount === 0) {
    const lines = ['No editable changes detected.'];
    lines.push('Applied: none');
    if (summary.lockedObjectIds.length > 0) {
      lines.push(`Locked objects skipped: ${summary.lockedObjectIds.join(', ')}`);
    }
    if (summary.ignoredEntries.length > 0) {
      lines.push('Ignored:');
      lines.push(
        ...summary.ignoredEntries.map((entry) =>
          `- ${trimSceneInspectorPathPrefix(formatSceneInspectorIgnoredEntry(entry), ignoredPrefix)}`
        )
      );
    }
    return lines.join('\n');
  }

  const lines = [
    `Editable changes: ${summary.changedFieldCount} field(s) across ${summary.changedObjectCount} object(s).`,
    `Broadcast payload: ${summary.actionCount === 1 ? 'scene-delta' : `scene-batch (${summary.actionCount} scene-delta actions)`}.`,
  ];

  if (summary.changedFieldsByObject.length > 0) {
    lines.push('Applied:');
    lines.push(
      ...summary.changedFieldsByObject.map((entry) => {
        const targetLabel = changedLabel
          || trimSceneInspectorPathPrefix(`objects.${entry.objectId}`, changedPrefix);
        return `- ${targetLabel}: ${entry.fields.join(', ')}`;
      })
    );
  }
  if (summary.lockedObjectIds.length > 0) {
    lines.push(`Locked objects skipped: ${summary.lockedObjectIds.join(', ')}`);
  }
  if (summary.ignoredEntries.length > 0) {
    lines.push('Ignored:');
    lines.push(
      ...summary.ignoredEntries.map((entry) =>
        `- ${trimSceneInspectorPathPrefix(formatSceneInspectorIgnoredEntry(entry), ignoredPrefix)}`
      )
    );
  }

  return lines.join('\n');
}

function formatSceneInspectorValidationMessage(summary, options = {}) {
  if (!summary) return '';
  const ignoredPrefix = options.ignoredPrefix || '';

  const lines = [];
  if (summary.actionCount === 0) {
    lines.push('No editable changes will be broadcast.');
  } else if (summary.ignoredEntries.length > 0) {
    lines.push('Some changes are not editable and will be ignored.');
  } else {
    return '';
  }

  const previewEntries = summary.ignoredEntries.slice(0, 4);
  if (previewEntries.length > 0) {
    lines.push(
      ...previewEntries.map((entry) =>
        `- ${trimSceneInspectorPathPrefix(formatSceneInspectorIgnoredEntry(entry), ignoredPrefix)}`
      )
    );
    if (summary.ignoredEntries.length > previewEntries.length) {
      lines.push(`- ...and ${summary.ignoredEntries.length - previewEntries.length} more ignored change(s).`);
    }
  }

  if (summary.lockedObjectIds.length > 0) {
    lines.push(`- Locked objects skipped: ${summary.lockedObjectIds.join(', ')}`);
  }

  return lines.join('\n');
}

function buildSelectedObjectInspectorContext(snapshot) {
  const objectId = snapshot.selection.objectId;
  if (!objectId) {
    return {
      objectId: null,
      objectSnapshot: null,
    };
  }

  return {
    objectId,
    objectSnapshot: snapshot.objects?.[objectId] ? cloneInspectorValue(snapshot.objects[objectId]) : null,
  };
}

function buildObjectBlockDiff(objectId, baseObject, editedObject) {
  const baseSnapshot = {
    objects: {
      [objectId]: cloneInspectorValue(baseObject),
    },
  };
  const editedSnapshot = {
    objects: {
      [objectId]: editedObject,
    },
  };
  return buildSceneInspectorEditableDiff(baseSnapshot, editedSnapshot);
}

function captureEditorScrollPosition(element) {
  if (!element) return null;
  return {
    scrollTop: element.scrollTop,
    scrollLeft: element.scrollLeft,
    selectionStart: typeof element.selectionStart === 'number' ? element.selectionStart : null,
    selectionEnd: typeof element.selectionEnd === 'number' ? element.selectionEnd : null,
  };
}

function restoreEditorScrollPosition(element, state) {
  if (!element || !state) return;
  element.scrollTop = state.scrollTop;
  element.scrollLeft = state.scrollLeft;
  if (typeof state.selectionStart === 'number' && typeof state.selectionEnd === 'number') {
    try {
      element.setSelectionRange(state.selectionStart, state.selectionEnd);
    } catch {}
  }
}

function formatJsonText(text) {
  return JSON.stringify(JSON.parse(text), null, 2);
}

function isSceneInspectorDirty() {
  if (!sceneInspectorState.isEditing || !sceneInspectorState.baseSnapshot) return false;
  const currentText = sceneInspectorEditorEl?.value ?? sceneInspectorState.draftText;
  return currentText !== JSON.stringify(sceneInspectorState.baseSnapshot, null, 2);
}

function isSceneInspectorObjectDirty() {
  const objectEditor = sceneInspectorState.objectEditor;
  if (!objectEditor.isEditing || !objectEditor.baseObject) return false;
  const currentText = sceneInspectorObjectEditorEl?.value ?? objectEditor.draftText;
  return currentText !== JSON.stringify(objectEditor.baseObject, null, 2);
}

function updateSceneInspectorMode() {
  if (!sceneInspectorModeEl) return;
  const parts = [];

  if (sceneInspectorState.isEditing) {
    parts.push('<span class="scene-inspector-mode-badge">Editing Scene JSON</span>');
    if (isSceneInspectorDirty()) {
      parts.push('<span class="scene-inspector-mode-dirty">Unsaved scene changes</span>');
    }
  }

  if (sceneInspectorState.objectEditor.isEditing) {
    parts.push('<span class="scene-inspector-mode-badge object">Editing Selected Object JSON</span>');
    if (isSceneInspectorObjectDirty()) {
      parts.push('<span class="scene-inspector-mode-dirty">Unsaved object changes</span>');
    }
  }

  sceneInspectorModeEl.innerHTML = parts.join(' ');
  sceneInspectorModeEl.hidden = parts.length === 0;
}

function formatObjectBlockHeader(objectId, objectSnapshot) {
  if (!objectId || !objectSnapshot) return '';
  const assetType = objectSnapshot.asset?.type || 'none';
  return [
    `objectId: ${objectId}`,
    `type: ${objectSnapshot.type || 'unknown'}`,
    `assetType: ${assetType}`,
  ].join('\n');
}

function resetSceneInspectorObjectEditor({ preserveObjectId = false } = {}) {
  const nextObjectId = preserveObjectId ? sceneInspectorState.objectEditor.objectId : null;
  sceneInspectorState.objectEditor = {
    isEditing: false,
    objectId: nextObjectId,
    baseObject: null,
    draftText: '',
    parsedObject: null,
    validationErrors: [],
    diffSummary: null,
  };
}

function renderSceneInspector(snapshot = buildSceneInspectorSnapshot()) {
  const roomLabel = snapshot.room || 'no-room';
  const selectedLabel = snapshot.selection.objectId || 'none';
  const selectedObject = buildSelectedObjectInspectorContext(snapshot);
  let objectEditorState = sceneInspectorState.objectEditor;
  const objectPathPrefix = selectedObject.objectId ? `objects.${selectedObject.objectId}` : '';
  if (sceneInspectorSummaryEl) {
    sceneInspectorSummaryEl.textContent =
      `Room ${roomLabel} | ${snapshot.objectCount} objects | selected ${selectedLabel} | ${new Date().toLocaleTimeString()}`;
  }

  if (objectEditorState.isEditing && objectEditorState.objectId !== selectedObject.objectId) {
    resetSceneInspectorObjectEditor();
    objectEditorState = sceneInspectorState.objectEditor;
  }

  if (sceneInspectorOutputEl && !sceneInspectorState.isEditing) {
    sceneInspectorOutputEl.textContent = JSON.stringify(snapshot, null, 2);
  }

  const isEditing = sceneInspectorState.isEditing;
  sceneInspectorEditBtn.hidden = isEditing;
  sceneInspectorFormatBtn.hidden = !isEditing;
  sceneInspectorResetBtn.hidden = !isEditing;
  sceneInspectorValidateBtn.hidden = !isEditing;
  sceneInspectorApplyBtn.hidden = !isEditing;
  sceneInspectorCancelBtn.hidden = !isEditing;
  sceneInspectorEditNoteEl.hidden = !isEditing;
  sceneInspectorEditMetaEl.hidden = !isEditing;
  sceneInspectorEditorEl.hidden = !isEditing;
  sceneInspectorOutputEl.hidden = isEditing;
  if (isEditing && sceneInspectorEditorEl && sceneInspectorEditorEl.value !== sceneInspectorState.draftText) {
    sceneInspectorEditorEl.value = sceneInspectorState.draftText;
  }

  const baseSnapshot = sceneInspectorState.baseSnapshot;
  if (sceneInspectorEditMetaEl) {
    const baseTime = baseSnapshot?.generatedAt || 'unknown';
    sceneInspectorEditMetaEl.textContent =
      `Base snapshot captured at ${baseTime}.\nApplied fields: existing object \`name\`, \`position\`, \`rotation\`, \`scale\`, \`visible\`, and primitive \`asset.color\`.\nIgnored fields: root metadata, object add/remove, ids, locks, room, connection, environment, Loom graph state, \`meshPath\`, and all other non-editable fields.`;
  }

  const hasErrors = sceneInspectorState.validationErrors.length > 0;
  const summary = sceneInspectorState.diffSummary;
  const hasWarnings = isEditing && !hasErrors && !!summary && (summary.actionCount === 0 || summary.ignoredEntries.length > 0);
  sceneInspectorValidationEl.hidden = !isEditing || (!hasErrors && !hasWarnings);
  sceneInspectorValidationEl?.classList.toggle('is-error', hasErrors);
  sceneInspectorValidationEl?.classList.toggle('is-warning', hasWarnings);
  if (sceneInspectorValidationEl) {
    if (hasErrors) {
      sceneInspectorValidationEl.textContent = sceneInspectorState.validationErrors
        .map((message) => `- ${message}`)
        .join('\n');
    } else if (hasWarnings) {
      sceneInspectorValidationEl.textContent = formatSceneInspectorValidationMessage(summary);
    } else {
      sceneInspectorValidationEl.textContent = '';
    }
  }

  const summaryText = isEditing ? formatSceneInspectorSummary(summary) : '';
  sceneInspectorDiffEl.hidden = !isEditing || !summaryText;
  if (sceneInspectorDiffEl) {
    sceneInspectorDiffEl.textContent = summaryText;
  }

  const hasSelection = !!selectedObject.objectId && !!selectedObject.objectSnapshot;
  const objectEditorIsEditing = objectEditorState.isEditing && hasSelection;
  if (sceneInspectorObjectMetaEl) {
    sceneInspectorObjectMetaEl.textContent = hasSelection
      ? `${selectedObject.objectId}`
      : 'No object selected';
  }
  sceneInspectorObjectEmptyEl.hidden = hasSelection;
  sceneInspectorObjectHeadEl.hidden = !hasSelection;
  sceneInspectorObjectActionsEl.hidden = !hasSelection;
  sceneInspectorObjectNoteEl.hidden = !objectEditorIsEditing;
  sceneInspectorObjectOutputEl.hidden = !hasSelection || objectEditorIsEditing;
  sceneInspectorObjectEditorEl.hidden = !objectEditorIsEditing;
  sceneInspectorObjectEditBtn.hidden = objectEditorIsEditing;
  sceneInspectorObjectFormatBtn.hidden = !objectEditorIsEditing;
  sceneInspectorObjectResetBtn.hidden = !objectEditorIsEditing;
  sceneInspectorObjectValidateBtn.hidden = !objectEditorIsEditing;
  sceneInspectorObjectApplyBtn.hidden = !objectEditorIsEditing;
  sceneInspectorObjectCancelBtn.hidden = !objectEditorIsEditing;

  if (sceneInspectorObjectHeadEl) {
    sceneInspectorObjectHeadEl.textContent = hasSelection
      ? formatObjectBlockHeader(selectedObject.objectId, selectedObject.objectSnapshot)
      : '';
  }

  if (hasSelection && sceneInspectorObjectOutputEl && !objectEditorIsEditing) {
    sceneInspectorObjectOutputEl.textContent = JSON.stringify(selectedObject.objectSnapshot, null, 2);
  }
  if (objectEditorIsEditing && sceneInspectorObjectEditorEl && sceneInspectorObjectEditorEl.value !== objectEditorState.draftText) {
    sceneInspectorObjectEditorEl.value = objectEditorState.draftText;
  }

  const objectHasErrors = objectEditorState.validationErrors.length > 0;
  const objectSummary = objectEditorState.diffSummary;
  const objectHasWarnings = !objectHasErrors && !!objectSummary
    && (objectSummary.actionCount === 0 || objectSummary.ignoredEntries.length > 0);
  sceneInspectorObjectValidationEl.hidden = !objectEditorIsEditing || (!objectHasErrors && !objectHasWarnings);
  sceneInspectorObjectValidationEl?.classList.toggle('is-error', objectHasErrors);
  sceneInspectorObjectValidationEl?.classList.toggle('is-warning', objectHasWarnings);
  if (sceneInspectorObjectValidationEl) {
    if (objectHasErrors) {
      sceneInspectorObjectValidationEl.textContent = objectEditorState.validationErrors
        .map((message) => `- ${trimSceneInspectorPathPrefix(message, `${objectPathPrefix}.`)}`)
        .join('\n');
    } else if (objectHasWarnings) {
      sceneInspectorObjectValidationEl.textContent = formatSceneInspectorValidationMessage(objectSummary, {
        ignoredPrefix: `${objectPathPrefix}.`,
      });
    } else {
      sceneInspectorObjectValidationEl.textContent = '';
    }
  }

  const objectSummaryText = objectEditorIsEditing
    ? formatSceneInspectorSummary(objectSummary, {
        changedPrefix: `objects.${selectedObject.objectId}`,
        changedLabel: selectedObject.objectId,
        ignoredPrefix: `${objectPathPrefix}.`,
      })
    : '';
  sceneInspectorObjectDiffEl.hidden = !objectEditorIsEditing || !objectSummaryText;
  if (sceneInspectorObjectDiffEl) {
    sceneInspectorObjectDiffEl.textContent = objectSummaryText;
  }

  updateSceneInspectorMode();
}

function buildSceneInspectorEditSnapshot() {
  return cloneInspectorValue(buildSceneInspectorSnapshot());
}

function enterSceneInspectorEditMode() {
  resetSceneInspectorObjectEditor();
  const snapshot = buildSceneInspectorEditSnapshot();
  sceneInspectorState.isEditing = true;
  sceneInspectorState.baseSnapshot = snapshot;
  sceneInspectorState.parsedSnapshot = cloneInspectorValue(snapshot);
  sceneInspectorState.draftText = JSON.stringify(snapshot, null, 2);
  sceneInspectorState.validationErrors = [];
  sceneInspectorState.diffSummary = null;
  sceneInspectorState.lastAppliedSummary = null;
  renderSceneInspector(snapshot);
  sceneInspectorEditorEl?.focus();
  sceneInspectorEditorEl?.setSelectionRange(0, 0);
}

function exitSceneInspectorEditMode() {
  sceneInspectorState.isEditing = false;
  sceneInspectorState.baseSnapshot = null;
  sceneInspectorState.parsedSnapshot = null;
  sceneInspectorState.draftText = '';
  sceneInspectorState.validationErrors = [];
  sceneInspectorState.diffSummary = null;
  sceneInspectorState.lastAppliedSummary = null;
  refreshSceneInspector();
}

function enterSceneInspectorObjectEditMode() {
  if (sceneInspectorState.isEditing) {
    exitSceneInspectorEditMode();
  }
  const snapshot = buildSceneInspectorSnapshot();
  const { objectId, objectSnapshot } = buildSelectedObjectInspectorContext(snapshot);
  if (!objectId || !objectSnapshot) {
    showToast('オブジェクトを選択してから編集してください');
    return;
  }

  sceneInspectorState.objectEditor = {
    isEditing: true,
    objectId,
    baseObject: objectSnapshot,
    draftText: JSON.stringify(objectSnapshot, null, 2),
    parsedObject: cloneInspectorValue(objectSnapshot),
    validationErrors: [],
    diffSummary: null,
    lastAppliedSummary: null,
  };
  renderSceneInspector(snapshot);
  sceneInspectorObjectEditorEl?.focus();
  sceneInspectorObjectEditorEl?.setSelectionRange(0, 0);
}

function exitSceneInspectorObjectEditMode() {
  resetSceneInspectorObjectEditor();
  refreshSceneInspector();
}

function validateSceneInspectorDraft() {
  const scrollState = captureEditorScrollPosition(sceneInspectorEditorEl);
  const draftText = sceneInspectorEditorEl?.value ?? sceneInspectorState.draftText;
  sceneInspectorState.draftText = draftText;

  let parsedSnapshot;
  try {
    parsedSnapshot = JSON.parse(draftText);
  } catch (error) {
    sceneInspectorState.parsedSnapshot = null;
    sceneInspectorState.validationErrors = [`Invalid JSON: ${error.message}`];
    sceneInspectorState.diffSummary = null;
    renderSceneInspector();
    restoreEditorScrollPosition(sceneInspectorEditorEl, scrollState);
    return null;
  }

  sceneInspectorState.parsedSnapshot = parsedSnapshot;

  const result = buildSceneInspectorEditableDiff(
    sceneInspectorState.baseSnapshot,
    parsedSnapshot
  );
  sceneInspectorState.validationErrors = result.errors;
  sceneInspectorState.diffSummary = result.summary;
  renderSceneInspector();
  restoreEditorScrollPosition(sceneInspectorEditorEl, scrollState);
  return result;
}

function validateSceneInspectorObjectDraft() {
  const scrollState = captureEditorScrollPosition(sceneInspectorObjectEditorEl);
  const objectEditorState = sceneInspectorState.objectEditor;
  const draftText = sceneInspectorObjectEditorEl?.value ?? objectEditorState.draftText;
  objectEditorState.draftText = draftText;

  let parsedObject;
  try {
    parsedObject = JSON.parse(draftText);
  } catch (error) {
    objectEditorState.parsedObject = null;
    objectEditorState.validationErrors = [`Invalid JSON: ${error.message}`];
    objectEditorState.diffSummary = null;
    renderSceneInspector();
    restoreEditorScrollPosition(sceneInspectorObjectEditorEl, scrollState);
    return null;
  }

  if (!parsedObject || typeof parsedObject !== 'object' || Array.isArray(parsedObject)) {
    objectEditorState.parsedObject = null;
    objectEditorState.validationErrors = ['Selected object JSON block must be an object.'];
    objectEditorState.diffSummary = null;
    renderSceneInspector();
    restoreEditorScrollPosition(sceneInspectorObjectEditorEl, scrollState);
    return null;
  }

  objectEditorState.parsedObject = parsedObject;
  const result = buildObjectBlockDiff(
    objectEditorState.objectId,
    objectEditorState.baseObject,
    parsedObject
  );
  objectEditorState.validationErrors = result.errors;
  objectEditorState.diffSummary = result.summary;
  renderSceneInspector();
  restoreEditorScrollPosition(sceneInspectorObjectEditorEl, scrollState);
  return result;
}

function applySceneInspectorDraft() {
  const scrollState = captureEditorScrollPosition(sceneInspectorEditorEl);
  const result = validateSceneInspectorDraft();
  if (!result) return;
  if (result.errors.length > 0) return;
  if (!result.operation) {
    showToast('適用できる editable change はありません');
    restoreEditorScrollPosition(sceneInspectorEditorEl, scrollState);
    return;
  }

  const changedObjects = result.summary?.changedObjectCount || 0;
  const changedFields = result.summary?.changedFieldCount || 0;
  sceneInspectorState.lastAppliedSummary = result.summary;
  applyOperationToScene(result.operation);
  broadcast(result.operation);
  notifySceneStateChanged('scene-inspector-json-edit-applied');
  showToast(`Scene JSON broadcast complete: ${changedFields} field(s) across ${changedObjects} object(s).`);
  exitSceneInspectorEditMode();
}

function applySceneInspectorObjectDraft() {
  const scrollState = captureEditorScrollPosition(sceneInspectorObjectEditorEl);
  const result = validateSceneInspectorObjectDraft();
  if (!result) return;
  if (result.errors.length > 0) return;
  if (!result.operation) {
    showToast('適用できる object change はありません');
    restoreEditorScrollPosition(sceneInspectorObjectEditorEl, scrollState);
    return;
  }

  const objectId = sceneInspectorState.objectEditor.objectId;
  const changedFields = result.summary?.changedFieldCount || 0;
  sceneInspectorState.objectEditor.lastAppliedSummary = result.summary;
  applyOperationToScene(result.operation);
  broadcast(result.operation);
  notifySceneStateChanged('scene-inspector-object-json-edit-applied');
  notifySelectionChanged('scene-inspector-object-json-edit-applied');
  showToast(`Object ${objectId} broadcast complete: ${changedFields} field(s) applied.`);
  exitSceneInspectorObjectEditMode();
}

function formatSceneInspectorDraft() {
  const scrollState = captureEditorScrollPosition(sceneInspectorEditorEl);
  try {
    sceneInspectorState.draftText = formatJsonText(sceneInspectorEditorEl?.value ?? sceneInspectorState.draftText);
    if (sceneInspectorEditorEl) sceneInspectorEditorEl.value = sceneInspectorState.draftText;
    sceneInspectorState.validationErrors = [];
    sceneInspectorState.diffSummary = null;
    updateSceneInspectorMode();
    showToast('Scene JSON formatted');
  } catch (error) {
    sceneInspectorState.validationErrors = [`Invalid JSON: ${error.message}`];
    sceneInspectorState.diffSummary = null;
    renderSceneInspector();
  }
  restoreEditorScrollPosition(sceneInspectorEditorEl, scrollState);
}

function resetSceneInspectorDraftToCurrent() {
  const scrollState = captureEditorScrollPosition(sceneInspectorEditorEl);
  const snapshot = buildSceneInspectorEditSnapshot();
  sceneInspectorState.baseSnapshot = snapshot;
  sceneInspectorState.parsedSnapshot = cloneInspectorValue(snapshot);
  sceneInspectorState.draftText = JSON.stringify(snapshot, null, 2);
  sceneInspectorState.validationErrors = [];
  sceneInspectorState.diffSummary = null;
  renderSceneInspector(snapshot);
  showToast('Scene JSON editor reset to current scene');
  restoreEditorScrollPosition(sceneInspectorEditorEl, scrollState);
}

function formatSceneInspectorObjectDraft() {
  const scrollState = captureEditorScrollPosition(sceneInspectorObjectEditorEl);
  try {
    sceneInspectorState.objectEditor.draftText = formatJsonText(
      sceneInspectorObjectEditorEl?.value ?? sceneInspectorState.objectEditor.draftText
    );
    if (sceneInspectorObjectEditorEl) {
      sceneInspectorObjectEditorEl.value = sceneInspectorState.objectEditor.draftText;
    }
    sceneInspectorState.objectEditor.validationErrors = [];
    sceneInspectorState.objectEditor.diffSummary = null;
    updateSceneInspectorMode();
    showToast('Selected object JSON formatted');
  } catch (error) {
    sceneInspectorState.objectEditor.validationErrors = [`Invalid JSON: ${error.message}`];
    sceneInspectorState.objectEditor.diffSummary = null;
    renderSceneInspector();
  }
  restoreEditorScrollPosition(sceneInspectorObjectEditorEl, scrollState);
}

function resetSceneInspectorObjectDraftToCurrent() {
  const scrollState = captureEditorScrollPosition(sceneInspectorObjectEditorEl);
  const snapshot = buildSceneInspectorSnapshot();
  const { objectId, objectSnapshot } = buildSelectedObjectInspectorContext(snapshot);
  if (!objectId || !objectSnapshot) {
    showToast('オブジェクトを選択してから編集してください');
    return;
  }
  sceneInspectorState.objectEditor.objectId = objectId;
  sceneInspectorState.objectEditor.baseObject = objectSnapshot;
  sceneInspectorState.objectEditor.parsedObject = cloneInspectorValue(objectSnapshot);
  sceneInspectorState.objectEditor.draftText = JSON.stringify(objectSnapshot, null, 2);
  sceneInspectorState.objectEditor.validationErrors = [];
  sceneInspectorState.objectEditor.diffSummary = null;
  renderSceneInspector(snapshot);
  showToast('Selected object editor reset to current object');
  restoreEditorScrollPosition(sceneInspectorObjectEditorEl, scrollState);
}

function tryExitSceneInspectorEditMode() {
  if (isSceneInspectorDirty()) {
    showToast('Scene JSON editor has unsaved changes. Reset or broadcast before canceling.');
    return false;
  }
  exitSceneInspectorEditMode();
  return true;
}

function tryExitSceneInspectorObjectEditMode() {
  if (isSceneInspectorObjectDirty()) {
    showToast('Selected object editor has unsaved changes. Reset or broadcast before canceling.');
    return false;
  }
  exitSceneInspectorObjectEditMode();
  return true;
}

function buildSceneInspectorSnapshot() {
  const objects = {};
  const sortedEntries = Array.from(managedObjects.entries())
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId));

  for (const [objectId, obj] of sortedEntries) {
    const entry = {
      name: obj.userData?.name || obj.name || objectId,
      type: obj.type,
      position: obj.position.toArray(),
      rotation: obj.quaternion.toArray(),
      scale: obj.scale.toArray(),
      visible: obj.visible !== false,
      childCount: obj.children?.length || 0,
    };

    if (obj.userData?.meshPath) {
      entry.meshPath = obj.userData.meshPath;
    }
    if (obj.userData?.asset !== undefined) {
      entry.asset = serializeInspectorAsset(obj.userData.asset);
    }
    if (locks.has(objectId)) {
      const lockInfo = locks.get(objectId);
      entry.lockedBy = {
        id: lockInfo?.id || null,
        nickname: lockInfo?.nickname || null,
      };
    }

    objects[objectId] = entry;
  }

  const snapshot = {
    kind: 'scene-inspector',
    room: presenceState.room || activeRoomCode || null,
    connection: {
      connected: presenceState.ws?.readyState === WebSocket.OPEN,
      peerId: presenceState.id,
      userId: presenceState.userId,
      sceneReceived,
    },
    environment: {
      currentEnvId: environmentManager.getCurrentEnvId?.() || null,
      appliedEnvId: environmentManager.getAppliedEnvId?.() || null,
    },
    selection: {
      objectId: transformCtrl.object?.userData?.objectId || null,
    },
    objectCount: sortedEntries.length,
    objects,
    generatedAt: new Date().toISOString(),
  };

  const loomGraphState = loomIntegration.exportState();
  if (loomGraphState.scene !== null || Object.keys(loomGraphState.objects).length > 0) {
    snapshot.loomGraphs = loomGraphState;
  }

  return snapshot;
}

function refreshSceneInspector() {
  renderSceneInspector(buildSceneInspectorSnapshot());
}

function scheduleSceneInspectorRefresh() {
  if (!sceneInspectorState.isOpen) return;
  if (sceneInspectorState.refreshTimer) return;
  sceneInspectorState.refreshTimer = setTimeout(() => {
    sceneInspectorState.refreshTimer = null;
    refreshSceneInspector();
  }, 80);
}

function notifyInspectorStateChanged(reason = 'unknown') {
  sceneInspectorState.lastReason = reason;
  scheduleSceneInspectorRefresh();
}

function notifySceneStateChanged(reason) {
  notifyInspectorStateChanged(`scene:${reason}`);
}

function notifySelectionChanged(reason) {
  notifyInspectorStateChanged(`selection:${reason}`);
}

function notifyConnectionStateChanged(reason) {
  notifyInspectorStateChanged(`connection:${reason}`);
}

function setSceneInspectorOpen(nextOpen) {
  sceneInspectorState.isOpen = nextOpen;
  sceneInspectorPanel?.classList.toggle('open', nextOpen);
  sceneInspectorToggleBtn?.classList.toggle('active', nextOpen);
  if (sceneInspectorToggleBtn) {
    sceneInspectorToggleBtn.title = nextOpen ? 'Scene Inspector を閉じる' : 'Scene Inspector を開く';
  }
  if (nextOpen) {
    refreshSceneInspector();
  }
}

function showPairingDialogLinked(expiresAtMs) {
  btnCancelPairing.textContent = '閉じる';
  btnCancelPairing.style.display = 'inline-block';
  btnRevokeLink.style.display = 'inline-block';
  pairingStepCode.style.display = 'none';
  pairingStepLinked.style.display = 'block';
  const expiresAt = new Date(expiresAtMs);
  document.getElementById('pairing-expires-at').textContent =
    `有効期限: ${expiresAt.toLocaleDateString()} ${expiresAt.toLocaleTimeString()}`;
  pairingDialog.style.display = 'flex';
}

async function startPairing() {
  if (!presenceState.room) {
    showToast('ルームに接続してからリンクしてください');
    return;
  }

  try {
    pairingError.style.display = 'none';
    pairingError.textContent = '';

    const result = await presenceState.linkManager.initiatePairing(
      presenceState.room,
      presenceState.userId,
      presenceState.id
    );

    pairingCode.textContent = result.code;
    pairingExpireTime = result.expiresAt;

    if (pairingCountdown) clearInterval(pairingCountdown);
    pairingCountdown = setInterval(updatePairingTimer, 100);
    showPairingDialogCode();
    updatePairingTimer();
  } catch (err) {
    pairingError.textContent = err.message;
    pairingError.style.display = 'block';
  }
}

function cancelPairing() {
  if (pairingCountdown) clearInterval(pairingCountdown);
  pairingCountdown = null;
  pairingExpireTime = null;
  pairingDialog.style.display = 'none';
}

async function revokeLink() {
  try {
    await presenceState.linkManager.revoke();
    cancelPairing();
    updateLinkButtonState();
    showToast('AI リンクを解除しました');
  } catch (err) {
    showToast('リンク解除に失敗しました: ' + err.message);
  }
}

function updateLinkButtonState() {
  const isLinked = presenceState.linkManager.isLinked();
  if (isLinked) {
    linkIcon.textContent = '✓';
    linkLabel.textContent = 'AIリンク中';
    linkBtn.classList.add('active');
  } else {
    linkIcon.textContent = '🔗';
    linkLabel.textContent = 'AIにリンク';
    linkBtn.classList.remove('active');
  }
}

linkBtn?.addEventListener('click', () => {
  if (presenceState.linkManager.isLinked()) {
    showPairingDialogLinked(presenceState.linkManager.expiresAt);
  } else {
    startPairing();
  }
});

btnCancelPairing?.addEventListener('click', cancelPairing);
btnRevokeLink?.addEventListener('click', revokeLink);
btnCopyPairingCode?.addEventListener('click', copyPairingCode);
pairingCode?.addEventListener('click', copyPairingCode);
sceneInspectorToggleBtn?.addEventListener('click', () => {
  setSceneInspectorOpen(!sceneInspectorState.isOpen);
});
sceneInspectorCloseBtn?.addEventListener('click', () => {
  setSceneInspectorOpen(false);
});
sceneInspectorRefreshBtn?.addEventListener('click', refreshSceneInspector);
sceneInspectorCopyBtn?.addEventListener('click', () => {
  const text = sceneInspectorState.isEditing
    ? (sceneInspectorEditorEl?.value || sceneInspectorState.draftText)
    : sceneInspectorOutputEl?.textContent?.trim();
  copyText(text, 'Scene JSON をコピーしました');
});
sceneInspectorEditBtn?.addEventListener('click', enterSceneInspectorEditMode);
sceneInspectorFormatBtn?.addEventListener('click', formatSceneInspectorDraft);
sceneInspectorResetBtn?.addEventListener('click', resetSceneInspectorDraftToCurrent);
sceneInspectorValidateBtn?.addEventListener('click', () => {
  const result = validateSceneInspectorDraft();
  if (!result || result.errors.length > 0) return;
  showToast(
    result.operation
      ? 'Editable changes are ready to broadcast'
      : 'No editable changes detected'
  );
});
sceneInspectorApplyBtn?.addEventListener('click', applySceneInspectorDraft);
sceneInspectorCancelBtn?.addEventListener('click', tryExitSceneInspectorEditMode);
sceneInspectorEditorEl?.addEventListener('input', () => {
  sceneInspectorState.draftText = sceneInspectorEditorEl.value;
  sceneInspectorState.validationErrors = [];
  sceneInspectorState.diffSummary = null;
  updateSceneInspectorMode();
});
sceneInspectorEditorEl?.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    sceneInspectorValidateBtn?.click();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    tryExitSceneInspectorEditMode();
  }
});
sceneInspectorObjectEditBtn?.addEventListener('click', enterSceneInspectorObjectEditMode);
sceneInspectorObjectFormatBtn?.addEventListener('click', formatSceneInspectorObjectDraft);
sceneInspectorObjectResetBtn?.addEventListener('click', resetSceneInspectorObjectDraftToCurrent);
sceneInspectorObjectValidateBtn?.addEventListener('click', () => {
  const result = validateSceneInspectorObjectDraft();
  if (!result || result.errors.length > 0) return;
  showToast(
    result.operation
      ? 'Selected object changes are ready to broadcast'
      : 'No editable object changes detected'
  );
});
sceneInspectorObjectApplyBtn?.addEventListener('click', applySceneInspectorObjectDraft);
sceneInspectorObjectCancelBtn?.addEventListener('click', tryExitSceneInspectorObjectEditMode);
sceneInspectorObjectEditorEl?.addEventListener('input', () => {
  sceneInspectorState.objectEditor.draftText = sceneInspectorObjectEditorEl.value;
  sceneInspectorState.objectEditor.validationErrors = [];
  sceneInspectorState.objectEditor.diffSummary = null;
  updateSceneInspectorMode();
});
sceneInspectorObjectEditorEl?.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    sceneInspectorObjectValidateBtn?.click();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    tryExitSceneInspectorObjectEditMode();
  }
});
pairingDialog?.addEventListener('click', (event) => {
  if (event.target === pairingDialog) {
    cancelPairing();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pairingDialog?.style.display === 'flex') {
    cancelPairing();
    return;
  }
  if (event.key === 'Escape' && sceneInspectorState.isEditing) {
    tryExitSceneInspectorEditMode();
    return;
  }
  if (event.key === 'Escape' && sceneInspectorState.objectEditor.isEditing) {
    tryExitSceneInspectorObjectEditMode();
    return;
  }
  if (event.key === 'Escape' && sceneInspectorState.isOpen) {
    setSceneInspectorOpen(false);
  }
});

presenceState.linkManager.onStatusChange = () => {
  updateLinkButtonState();
};

setSceneInspectorOpen(false);

if (sceneSyncOperatorLink) {
  if (SCENE_SYNC_OPERATOR_URL) {
    sceneSyncOperatorLink.href = SCENE_SYNC_OPERATOR_URL;
  } else {
    sceneSyncOperatorLink.style.display = 'none';
  }
}

// 初期状態を反映（DOM 参照と関数定義が揃った後で呼ぶ）
updateLinkButtonState();

// ── 起動 ─────────────────────────────────────────────────

nicknameChip?.addEventListener('click', editNickname);
updateNicknameLabel();
renderRoomSection();
connectPresence();

// Safari / iOS: バックグラウンドから復帰時に即再接続（3秒タイマーを待たない）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const ws = presenceState.ws;
  if (ws && ws.readyState === WebSocket.OPEN) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws && presenceState.ws === ws) {
    presenceState.ws = null;
    try { ws.close(); } catch {}
  }
  connectPresence();
});

// Safari BFCache 復元時の再接続
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  const ws = presenceState.ws;
  if (ws && ws.readyState === WebSocket.OPEN) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws && presenceState.ws === ws) {
    presenceState.ws = null;
    try { ws.close(); } catch {}
  }
  connectPresence();
});
environmentManager.loadEnvironment('outdoor_day', {
  source: 'init',
  broadcastChange: false,
});
