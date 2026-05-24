// ── scene.js ─────────────────────────────────────────────
// Three.js ビューア + presence-server 接続
// ─────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { createThreeApp } from './core/three-app.js';
import { createEnvironmentManager } from './core/environment.js';
import { DragDropManager, SKY_DROP_UPNESS_THRESHOLD } from './components/drag-drop-manager.js';
import { ClipboardImportManager } from './components/clipboard-import-manager.js';
import { GLBFileLoader } from './loaders/glb-file-loader.js';
import { buildPlaneGlbFromImage, planeSizeFromImage } from './loaders/image-to-plane.js';
import { createImageCanvasForScene } from './loaders/image-optimizer.js';
import { generateTemporaryImageObjectId } from './loaders/image-preview.js';
import { buildImageSkySphereGlb } from './loaders/image-to-sky-sphere.js';
import { buildTextPlaneGlb } from './loaders/text-to-plane.js';
import { loadVideoTextureFromUrl, createVideoPlaneGroup } from './loaders/video-url-importer.js';
import { classifyUrl, URL_KIND } from './loaders/url-classifier.js';
import { resolveDroppedUrl } from './loaders/url-resolver.js';
import { normalizeTextAsset, renderTextPanelCanvas, DEFAULT_TEXT_LAYOUT, DEFAULT_TEXT_SCROLL } from './components/text-panel-renderer.js';
import { dispatchUrlImport } from './loaders/url-importers/index.js';
import { getSceneSyncDom } from './ui/dom.js';
import { showToast } from './ui/toast.js';
import { createWelcomeDialog } from './ui/welcome-dialog.js';
import { focusTextInputIfSafe, blurActiveEditableElement } from './ui/input-focus-guard.js';
import { applySceneSyncDeviceMode, isSceneSyncMobileDevice } from './ui/device-mode.js';
import { normalizeDisplayName } from './utils/display-name.js';
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
import { computeAssetId } from './assets/asset-id.js';
import { createSceneAssetCache } from './assets/asset-cache.js';
import { createSceneSyncFileTransferAdapter } from './assets/file-transfer-adapter.js';
import { createExpiredGlbRecovery } from './assets/expired-glb-recovery.js';
import { createRoomSnapshotCache } from './assets/scene-snapshot-cache.js';
import { reportPreviousCrashProbe, markCrashProbe, clearCrashProbe } from './utils/crash-probe-helper.js';
import { isSnapshotRestoreDisabled, isGlbLoadDisabled, logDiagnosticFlags } from './utils/diagnostic-flags.js';
import { buildExportPackage } from '../scenesync-export/export/build-export-package.js';

const ABSOLUTE_IMAGE_FILE_LIMIT_BYTES = 80 * 1024 * 1024;

// ── Three.js 基本セットアップ ────────────────────────────

const threeApp = createThreeApp();
const {
  scene,
  camera,
  renderer,
  pmremGenerator,
} = threeApp;
const dom = getSceneSyncDom();
applySceneSyncDeviceMode(document.body);
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

// Skybox Sphere 管理
function isSkySphereObject(obj) {
  return obj?.metadata?.role === 'sky-sphere'
    || obj?.objectId?.startsWith('sky-')
    || obj?.name?.startsWith('sky:');
}

function isSkySphereThreeObject(obj) {
  let current = obj;

  while (current) {
    const objectId = current.userData?.objectId;
    const metadata = current.userData?.metadata;
    const name = current.userData?.name;

    if (
      metadata?.role === 'sky-sphere' ||
      objectId?.startsWith('sky-') ||
      name?.startsWith('sky:')
    ) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

function getSkySphereObjects() {
  const result = [];
  for (const [objectId, obj] of managedObjects.entries()) {
    const info = {
      objectId,
      metadata: obj.userData?.metadata,
      name: obj.userData?.name,
    };
    if (isSkySphereObject(info)) {
      result.push(info);
    }
  }
  return result;
}

function getSkySpherePayloads() {
  const result = [];
  for (const [objectId, obj] of managedObjects.entries()) {
    const info = {
      objectId,
      metadata: obj.userData?.metadata,
      name: obj.userData?.name,
    };
    if (!isSkySphereObject(info)) continue;

    result.push({
      kind: 'scene-add',
      objectId,
      name: obj.userData?.name || obj.name || objectId,
      position: obj.position.toArray(),
      rotation: obj.quaternion.toArray(),
      scale: obj.scale.toArray(),
      asset: obj.userData?.asset || null,
      metadata: obj.userData?.metadata || { role: 'sky-sphere' },
      meshPath: obj.userData?.meshPath || obj.userData?.asset?.meshPath || null,
    });
  }
  return result;
}

function updateEnvironmentMenuSkyboxControls() {
  const hasSkybox = getSkySphereObjects().length > 0;
  if (dom.deleteSkyboxBtn) {
    dom.deleteSkyboxBtn.hidden = !hasSkybox;
  }
  const mobileDeleteSkyboxBtn = document.getElementById('mobile-delete-skybox-btn');
  if (mobileDeleteSkyboxBtn) {
    mobileDeleteSkyboxBtn.hidden = !hasSkybox;
  }
}

function removeSkyboxSpheres() {
  const skyObjects = getSkySphereObjects();

  if (skyObjects.length === 0) {
    showToast('削除できる背景画像がありません');
    return false;
  }

  for (const obj of skyObjects) {
    deleteObjectById(obj.objectId);
  }

  showToast('背景画像を削除しました');
  updateEnvironmentMenuSkyboxControls();
  notifySceneStateChanged('skybox-removed');

  return true;
}

function syncSceneUiState() {
  updateEnvironmentMenuSkyboxControls();
}

dom.envSelect?.addEventListener('change', () => {
  if (mobileEnvSelect) {
    mobileEnvSelect.value = dom.envSelect.value;
  }
  notifySceneStateChanged('environment-select-change');
  updateEnvironmentMenuSkyboxControls();
});

dom.deleteSkyboxBtn?.addEventListener('click', () => {
  removeSkyboxSpheres();
});

dom.clearBgmButton?.addEventListener('click', () => {
  if (!serializeSceneBgm()) {
    showToast('削除するBGMはありません');
    updateBgmControls();
    return;
  }

  applySceneBgm(null);

  const operation = {
    kind: 'scene-bgm',
    bgm: null,
  };
  broadcast(operation);

  showToast('BGMを削除しました');
  notifySceneStateChanged('bgm-cleared');
});

setupXrButtons({
  renderer,
  dom,
});
const BLOB_BASE = location.hostname === 'localhost'
  ? 'http://localhost:8787/blob'
  : `${location.origin}/presence/blob`;
const SCENE_SYNC_OPERATOR_URL = 'https://chatgpt.com/g/g-69eac2f9af04819193334b81da1b7993-scene-sync-operator';

const FONT_PRESETS = {
  'system-sans': 'system-ui, -apple-system, "Segoe UI", sans-serif',
  'serif': 'Georgia, "Times New Roman", serif',
  'monospace': '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  'japanese-sans': 'system-ui, -apple-system, "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif',
  'japanese-serif': '"Hiragino Mincho ProN", "Yu Mincho", serif',
};

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

  const targets = Array.from(managedObjects.values())
    .filter(obj => !isSkySphereThreeObject(obj));
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
let multiTransformPivot = null;
let multiTransformActive = false;
let multiTransformMode = null;
let multiTransformStartPivotMatrix = null;
const multiTransformStartObjectMatrices = new Map();
let multiTransformStartSnapshots = new Map();
let multiMoveBroadcastIntervalId = null;
let multiMovePendingOps = [];
const multiTransformLockedObjectIds = new Set();
const MULTI_MOVE_SYNC_INTERVAL_MS = 50;

transformCtrl.addEventListener('objectChange', () => {
  if (multiTransformActive && transformCtrl.object === multiTransformPivot) {
    updateMultiTransformFromPivot();
  }
});

transformCtrl.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  isDragging = e.value;

  if (multiTransformActive && transformCtrl.object === multiTransformPivot) {
    if (isDragging) {
      beginMultiTransformHistory();
      lockMultiSelectedObjects();
      ensureMultiMoveBroadcastInterval();
    } else {
      flushMultiMoveBroadcast();
      stopMultiMoveBroadcastInterval();
      endMultiTransformHistory();
      unlockMultiSelectedObjects();
    }
    return;
  }

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

function computeSelectionCenter(objects) {
  const center = new THREE.Vector3();
  if (!objects.length) return center;

  for (const object of objects) {
    center.add(object.position);
  }

  center.multiplyScalar(1 / objects.length);
  return center;
}

function ensureMultiTransformPivot() {
  if (multiTransformPivot) return multiTransformPivot;

  multiTransformPivot = new THREE.Object3D();
  multiTransformPivot.name = 'Multi Selection Pivot';
  multiTransformPivot.userData.role = 'multi-transform-pivot';
  multiTransformPivot.userData._temporary = true;
  multiTransformPivot.userData.nonSerializable = true;
  scene.add(multiTransformPivot);
  return multiTransformPivot;
}

function cleanupMultiTransformPivot() {
  flushMultiMoveBroadcast();
  stopMultiMoveBroadcastInterval();
  unlockMultiSelectedObjects();

  if (transformCtrl?.object === multiTransformPivot) {
    transformCtrl.detach();
  }

  if (multiTransformPivot) {
    scene.remove(multiTransformPivot);
    multiTransformPivot = null;
  }

  multiTransformActive = false;
  multiTransformMode = null;
  multiTransformStartPivotMatrix = null;
  multiTransformStartObjectMatrices.clear();
  multiTransformStartSnapshots.clear();
  multiMovePendingOps = [];
}

function updateSelectionHelpers() {
  for (const helper of selectionHelpers.values()) {
    helper.update?.();
  }
}

function broadcastSceneBatchOrDeltas(ops, reason = 'batch') {
  if (!ops?.length) return;

  if (ops.length === 1) {
    broadcast(ops[0]);
    return;
  }

  broadcast({
    kind: 'scene-batch',
    ops,
    // `actions` is consumed by existing Scene Sync handlers; `ops` keeps parity with newer payloads.
    actions: ops,
    reason,
    sentAt: Date.now(),
  });
}

function lockMultiSelectedObjects() {
  for (const objectId of selectedObjectIds) {
    if (!managedObjects.has(objectId)) continue;
    if (multiTransformLockedObjectIds.has(objectId)) continue;
    multiTransformLockedObjectIds.add(objectId);
    broadcast({ kind: 'scene-lock', objectId });
  }
}

function unlockMultiSelectedObjects() {
  for (const objectId of multiTransformLockedObjectIds) {
    broadcast({ kind: 'scene-unlock', objectId });
  }
  multiTransformLockedObjectIds.clear();
}

function flushMultiMoveBroadcast() {
  const ops = multiMovePendingOps.slice();
  multiMovePendingOps = [];
  if (!ops.length) return;

  broadcastSceneBatchOrDeltas(ops, 'multi-move');
  notifySceneStateChanged('multi-move');
}

function ensureMultiMoveBroadcastInterval() {
  if (multiMoveBroadcastIntervalId) return;
  multiMoveBroadcastIntervalId = setInterval(() => {
    flushMultiMoveBroadcast();
  }, MULTI_MOVE_SYNC_INTERVAL_MS);
}

function stopMultiMoveBroadcastInterval() {
  if (!multiMoveBroadcastIntervalId) return;
  clearInterval(multiMoveBroadcastIntervalId);
  multiMoveBroadcastIntervalId = null;
}

function startMultiTransformMode(mode) {
  const objects = getSelectedObjects();
  if (objects.length < 2) {
    cleanupMultiTransformPivot();
    return;
  }

  const pivot = ensureMultiTransformPivot();
  pivot.position.copy(computeSelectionCenter(objects));
  pivot.quaternion.identity();
  pivot.scale.set(1, 1, 1);
  pivot.updateMatrixWorld(true);

  multiTransformMode = mode;
  multiTransformActive = true;
  multiTransformStartPivotMatrix = pivot.matrixWorld.clone();
  multiTransformStartObjectMatrices.clear();
  multiTransformStartSnapshots.clear();

  for (const obj of objects) {
    const objectId = obj.userData?.objectId;
    if (!objectId) continue;
    obj.updateMatrixWorld(true);
    multiTransformStartObjectMatrices.set(objectId, obj.matrixWorld.clone());
  }

  transformCtrl.setMode(mode);
  transformCtrl.attach(pivot);
  updateSelectionHelpers();
}

function updateMultiTransformFromPivot() {
  if (!multiTransformActive || !multiTransformPivot || !multiTransformStartPivotMatrix) return;

  multiTransformPivot.updateMatrixWorld(true);

  // Multi-selection scale: enforce uniform scale on the pivot to avoid shear
  // when selected objects have non-identity rotations. Non-uniform scale applied
  // to a rotated object via matrix multiplication produces shear, which
  // Matrix4.decompose() cannot represent faithfully.
  if (multiTransformMode === 'scale') {
    const s = multiTransformPivot.scale;
    const uniform = Math.cbrt(Math.abs(s.x * s.y * s.z)) || 1;
    s.set(uniform, uniform, uniform);
    multiTransformPivot.updateMatrixWorld(true);
  }

  const inverseStartPivot = multiTransformStartPivotMatrix.clone().invert();
  const deltaMatrix = multiTransformPivot.matrixWorld.clone().multiply(inverseStartPivot);

  const newPosition = new THREE.Vector3();
  const newQuaternion = new THREE.Quaternion();
  const newScale = new THREE.Vector3();

  const ops = [];

  for (const objectId of selectedObjectIds) {
    const obj = managedObjects.get(objectId);
    const startMatrix = multiTransformStartObjectMatrices.get(objectId);
    if (!obj || !startMatrix) continue;

    const nextMatrix = deltaMatrix.clone().multiply(startMatrix);
    nextMatrix.decompose(newPosition, newQuaternion, newScale);

    obj.position.copy(newPosition);
    obj.quaternion.copy(newQuaternion);
    obj.scale.copy(newScale);
    obj.updateMatrixWorld(true);

    ops.push({
      kind: 'scene-delta',
      objectId,
      position: obj.position.toArray(),
      rotation: obj.quaternion.toArray(),
      scale: obj.scale.toArray(),
    });
  }

  updateSelectionHelpers();
  // Replace pending ops with the latest transform snapshot in the throttle window.
  multiMovePendingOps = ops;
  ensureMultiMoveBroadcastInterval();
}

function beginMultiTransformHistory() {
  multiTransformStartSnapshots.clear();

  for (const object of getSelectedObjects()) {
    const objectId = object.userData?.objectId;
    if (!objectId) continue;
    multiTransformStartSnapshots.set(objectId, {
      position: object.position.toArray(),
      rotation: object.quaternion.toArray(),
      scale: object.scale.toArray(),
    });
  }
}

function pushMultiTransformHistory(entries, label = 'Transformed') {
  const forwardActions = [];
  const backwardActions = [];

  for (const entry of entries) {
    forwardActions.push({
      kind: 'scene-delta',
      objectId: entry.objectId,
      position: entry.after.position,
      rotation: entry.after.rotation,
      scale: entry.after.scale,
    });
    backwardActions.push({
      kind: 'scene-delta',
      objectId: entry.objectId,
      position: entry.before.position,
      rotation: entry.before.rotation,
      scale: entry.before.scale,
    });
  }

  if (!forwardActions.length) return;

  presenceState.historyManager?.push(
    HistoryManager.createBatchEntry(
      forwardActions,
      backwardActions,
      `${label} ${forwardActions.length} objects`
    )
  );
}

function endMultiTransformHistory() {
  const entries = [];

  for (const [objectId, before] of multiTransformStartSnapshots.entries()) {
    const object = managedObjects.get(objectId);
    if (!object) continue;

    const after = {
      position: object.position.toArray(),
      rotation: object.quaternion.toArray(),
      scale: object.scale.toArray(),
    };

    if (arraysEqual(before.position, after.position) &&
        arraysEqual(before.rotation, after.rotation) &&
        arraysEqual(before.scale, after.scale)) {
      continue;
    }

    entries.push({ objectId, before, after });
  }

  if (entries.length > 0) {
    const modeLabel = multiTransformMode === 'rotate' ? 'Rotated' :
      multiTransformMode === 'scale' ? 'Scaled' : 'Moved';
    pushMultiTransformHistory(entries, modeLabel);
    notifySceneStateChanged(`multi-${multiTransformMode || 'transform'}-end`);
  }
}

// ── サンプルオブジェクト ──────────────────────────────────

const sampleGeo = new THREE.BoxGeometry(1, 1, 1);
const sampleMat = new THREE.MeshStandardMaterial({ color: 0x4488ff });
const sampleCube = new THREE.Mesh(sampleGeo, sampleMat);
sampleCube.position.set(0, 0.5, 0);
sampleCube.userData.objectId = 'sample-cube';
sampleCube.userData.name = 'Sample Cube';
const color = `#${sampleMat.color.getHexString()}`;
sampleCube.userData.asset = {
  type: 'primitive',
  primitive: 'box',
  color,
};
scene.add(sampleCube);

// ── オブジェクト管理 ─────────────────────────────────────

// objectId → THREE.Object3D
const managedObjects = new Map();
managedObjects.set('sample-cube', sampleCube);
const selectedObjectIds = new Set();
const selectionHelpers = new Map();
const removedObjectIds = new Set();

// Local image replacement preview management
// objectId → { token, objectUrl, overlayObject, cleanup }
const pendingMediaReplacementPreviews = new Map();

// objectId → lockOwnerId
const locks = new Map();

// objectId → wireframe mesh
const lockOverlays = new Map();

// ── BGM state ────────────────────────────────────────────────

const sceneBgmState = {
  audio: null,
  current: null,
  autoplayBlocked: false,
};

// ── トランスフォームツイーン（AI/GPT アニメーション） ────────

const activeTransformTweens = new Map();
const AI_TRANSFORM_TWEEN_DURATION_MS = 850;
const AI_TRANSFORM_TWEEN_STAGGER_MS = 35;
let aiTransformTweenSnapshotTimer = null;

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function animateObjectTransform(objectId, obj, payload, options = {}) {
  const duration = options.duration ?? AI_TRANSFORM_TWEEN_DURATION_MS;
  const delay = options.delay ?? 0;

  const tween = {
    objectId,
    object: obj,
    startTime: performance.now(),
    duration,
    delay,
    hasPosition: Array.isArray(payload.position),
    hasRotation: Array.isArray(payload.rotation),
    hasScale: Array.isArray(payload.scale),
    fromPosition: obj.position.clone(),
    toPosition: Array.isArray(payload.position)
      ? new THREE.Vector3().fromArray(payload.position)
      : null,
    fromQuaternion: obj.quaternion.clone(),
    toQuaternion: Array.isArray(payload.rotation)
      ? new THREE.Quaternion().fromArray(payload.rotation)
      : null,
    fromScale: obj.scale.clone(),
    toScale: Array.isArray(payload.scale)
      ? new THREE.Vector3().fromArray(payload.scale)
      : null,
  };

  activeTransformTweens.set(objectId, tween);

  console.debug('[ai-transform-tween] start', {
    objectId,
    hasPosition: tween.hasPosition,
    hasRotation: tween.hasRotation,
    hasScale: tween.hasScale,
    duration,
    delay,
  });
}

function scheduleAiTransformTweenSnapshot() {
  clearTimeout(aiTransformTweenSnapshotTimer);
  // Batch near-simultaneous tween completions into one snapshot save.
  aiTransformTweenSnapshotTimer = setTimeout(() => {
    aiTransformTweenSnapshotTimer = null;
    scheduleSaveRoomSnapshot('ai-transform-tween-complete');
  }, 50);
}

function updateTransformTweens(now = performance.now()) {
  let completedCount = 0;

  for (const [objectId, tween] of activeTransformTweens.entries()) {
    // Object may be removed/replaced while tween is active; drop safely.
    if (!tween.object || !tween.object.parent) {
      activeTransformTweens.delete(objectId);
      continue;
    }

    const elapsed = now - tween.startTime - tween.delay;

    if (elapsed < 0) continue;

    const t = Math.min(1, elapsed / tween.duration);
    const eased = easeOutCubic(t);

    if (tween.hasPosition && tween.toPosition) {
      tween.object.position.lerpVectors(
        tween.fromPosition,
        tween.toPosition,
        eased
      );
    }

    if (tween.hasRotation && tween.toQuaternion) {
      tween.object.quaternion.slerpQuaternions(
        tween.fromQuaternion,
        tween.toQuaternion,
        eased
      );
    }

    if (tween.hasScale && tween.toScale) {
      tween.object.scale.lerpVectors(
        tween.fromScale,
        tween.toScale,
        eased
      );
    }

    if (t >= 1) {
      if (tween.hasPosition && tween.toPosition) tween.object.position.copy(tween.toPosition);
      if (tween.hasRotation && tween.toQuaternion) tween.object.quaternion.copy(tween.toQuaternion);
      if (tween.hasScale && tween.toScale) tween.object.scale.copy(tween.toScale);
      tween.object.updateMatrixWorld(true);
      activeTransformTweens.delete(objectId);
      completedCount += 1;
      console.debug('[ai-transform-tween] complete', { objectId });
    }
  }

  if (completedCount > 0) {
    updateSelectionHelpers();
    scheduleAiTransformTweenSnapshot();
  }
}

// ── GLB Animation Mixers ─────────────────────────────────
// objectId → { mixer, clips, action, clipIndex }
const glbAnimationMixers = new Map();

// ── Runtime Time Model ───────────────────────────────────
// Selected objects evaluate at t=0 (edit mode).
// Unselected objects advance runtime time from 0.

function ensureObjectRuntime(obj) {
  if (!obj) return null;

  obj.userData.runtime = {
    enabled: true,
    speed: 1,
    startLocalTime: performance.now(),
    startServerTime: null,
    selectedTime: 0,
    ...(obj.userData.runtime || {}),
  };

  return obj.userData.runtime;
}

function isRuntimeFrozenForSelection(objectId) {
  if (!objectId) return false;
  return selectedObjectIds.has(objectId);
}

function getObjectRuntimeTime(objectId, now = performance.now()) {
  const obj = managedObjects.get(objectId);
  if (!obj) return 0;

  const runtime = ensureObjectRuntime(obj);
  if (!runtime?.enabled) return 0;

  if (isRuntimeFrozenForSelection(objectId)) {
    return runtime.selectedTime ?? 0;
  }

  const speed = Number.isFinite(runtime.speed) ? runtime.speed : 1;
  const start = Number.isFinite(runtime.startLocalTime)
    ? runtime.startLocalTime
    : now;

  return Math.max(0, ((now - start) / 1000) * speed);
}

// TODO: Replace local performance.now() with synchronized server time.
// Desired deterministic model:
//
// selected:
//   t = 0
//
// unselected:
//   t = ((serverNow - runtime.startServerTime) / 1000) * speed
//
// On deselect:
//   runtime.startServerTime = serverNow
//
// This should make GLB animation and Loomlet object graphs deterministic
// for late joiners and multi-client synchronization.

function resetObjectRuntimeOrigin(objectId, now = performance.now()) {
  const obj = managedObjects.get(objectId);
  if (!obj) return;

  const runtime = ensureObjectRuntime(obj);
  runtime.startLocalTime = now;
  runtime.selectedTime = 0;

  obj.userData.runtime = runtime;
}

let previousSelectedRuntimeObjectIds = new Set();

function updateRuntimeSelectionTransition() {
  const current = new Set(selectedObjectIds);

  // Compute newly selected and deselected objects
  const newlySelected = [];
  const deselected = [];

  for (const objectId of current) {
    if (!previousSelectedRuntimeObjectIds.has(objectId)) {
      newlySelected.push(objectId);
    }
  }

  for (const objectId of previousSelectedRuntimeObjectIds) {
    if (!current.has(objectId)) {
      deselected.push(objectId);
      resetObjectRuntimeOrigin(objectId);
    }
  }

  // Notify Loom integration of selection changes
  for (const objectId of newlySelected) {
    loomIntegration?.onObjectSelected?.(objectId);
  }

  for (const objectId of deselected) {
    loomIntegration?.onObjectDeselected?.(objectId);
  }

  previousSelectedRuntimeObjectIds = current;
}

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
const recoveryOverlays = new Map();
const failedOverlays = new Map();
const temporaryImagePreviews = new Map();

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

function createRecoveringPlaceholder() {
  const group = new THREE.Group();

  const geo = new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({
    color: 0xffaa44,
    transparent: true,
    opacity: 0.8,
  });
  const box = new THREE.LineSegments(edges, mat);
  box.raycast = () => {};
  group.add(box);
  geo.dispose();

  group.userData._animation = 'pulsing';
  group.userData._startTime = performance.now();

  return group;
}

function createFailedPlaceholder() {
  const group = new THREE.Group();

  const geo = new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({
    color: 0xff6666,
    transparent: true,
    opacity: 0.6,
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

function addRecoveringOverlay(objectId, info) {
  removeRecoveringOverlay(objectId);

  const group = new THREE.Group();
  group.userData._isRecoveringOverlay = true;
  group.raycast = () => {};

  const placeholder = createRecoveringPlaceholder();
  group.add(placeholder);

  if (info) {
    applySceneTransform(group, info);
  }

  scene.add(group);
  recoveryOverlays.set(objectId, { group, placeholder });
}

function removeRecoveringOverlay(objectId) {
  const entry = recoveryOverlays.get(objectId);
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

  recoveryOverlays.delete(objectId);
}

function addFailedOverlay(objectId, info) {
  removeFailedOverlay(objectId);

  const group = new THREE.Group();
  group.userData._isFailedPlaceholder = true;
  group.raycast = () => {};

  const placeholder = createFailedPlaceholder();
  group.add(placeholder);

  if (info) {
    applySceneTransform(group, info);
  }

  scene.add(group);
  failedOverlays.set(objectId, { group, placeholder });
}

function removeFailedOverlay(objectId) {
  const entry = failedOverlays.get(objectId);
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

  failedOverlays.delete(objectId);
}

function updateRecoveringOverlaysAnimation() {
  recoveryOverlays.forEach(entry => {
    const { placeholder } = entry;
    if (!placeholder || !placeholder.userData._animation) return;

    const elapsed = performance.now() - placeholder.userData._startTime;
    const phase = (elapsed / 1000) % 2;
    const opacity = Math.abs(Math.sin(phase * Math.PI)) * 0.5 + 0.3;

    placeholder.children.forEach(child => {
      if (child.material && child.material.opacity !== undefined) {
        child.material.opacity = opacity;
      }
    });
  });
}

// ── GLB Animation Setup and Updates ──────────────────────

function setupObjectGlbAnimation(objectId, model) {
  const clips = model.userData?.scenesync?.animations;
  if (!Array.isArray(clips) || clips.length === 0) return;

  disposeObjectGlbAnimation(objectId);

  const state = {
    enabled: true,
    clip: 0,
    mode: 'loop',
    speed: 1,
    ...(model.userData?.scenesync?.animationState || {}),
    ...(model.userData?.animationState || {}),
  };

  const mixer = new THREE.AnimationMixer(model);
  const clipIndex = clampAnimationClipIndex(state.clip, clips.length);
  state.clip = clipIndex;
  const clip = clips[clipIndex];
  const action = mixer.clipAction(clip);

  action.reset();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();

  model.userData.animationState = state;
  model.userData.scenesync = {
    ...model.userData.scenesync,
    animationState: state,
  };

  ensureObjectRuntime(model);

  glbAnimationMixers.set(objectId, {
    mixer,
    clips,
    action,
    clipIndex,
  });
}

function disposeObjectGlbAnimation(objectId) {
  const entry = glbAnimationMixers.get(objectId);
  if (!entry) return;

  entry.mixer.stopAllAction();
  glbAnimationMixers.delete(objectId);
}

function getObjectAnimationState(obj) {
  if (!obj) return null;

  const raw =
    obj?.userData?.animationState ||
    obj?.userData?.scenesync?.animationState ||
    null;

  if (!raw) return null;

  return {
    enabled: raw.enabled !== false,
    clip: Number.isInteger(raw.clip) ? raw.clip : 0,
    mode: raw.mode === 'once' ? 'once' : 'loop',
    speed: Number.isFinite(raw.speed) ? raw.speed : 1,
  };
}

function getObjectAnimationClipSummaries(obj) {
  const clips = obj?.userData?.scenesync?.animations;
  if (!Array.isArray(clips) || clips.length === 0) return [];

  return clips.map((clip, index) => ({
    index,
    name: clip?.name || `Animation ${index}`,
    duration: Number.isFinite(clip?.duration) ? clip.duration : null,
  }));
}

function normalizeAnimationClipName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[-]+/g, '_');
}

function getObjectAnimationClips(obj) {
  const clips = obj?.userData?.scenesync?.animations;
  return Array.isArray(clips) ? clips : [];
}

function serializeObjectAnimationClipSummariesForExternalUse(obj) {
  return getObjectAnimationClips(obj).map((clip, index) => ({
    index,
    name: clip?.name || `Animation ${index}`,
    duration: Number.isFinite(clip?.duration) ? clip.duration : null,
  }));
}

function resolveAnimationClipIndex(obj, params = {}) {
  const clips = getObjectAnimationClips(obj);

  if (clips.length === 0) {
    return {
      ok: false,
      error: 'target object has no animation clips',
      clips: [],
    };
  }

  if (params.clip !== undefined) {
    const clipIndex = clampAnimationClipIndex(params.clip, clips.length);
    return {
      ok: true,
      clipIndex,
      clipName: clips[clipIndex]?.name || `Animation ${clipIndex}`,
      matchedBy: 'clip',
      clips,
    };
  }

  const requestedName = params.clipName ?? params.name;
  if (typeof requestedName !== 'string' || !requestedName.trim()) {
    return {
      ok: false,
      error: 'clip or clipName is required',
      clips,
    };
  }

  const normalizedRequested = normalizeAnimationClipName(requestedName);

  // 1. exact normalized match
  let clipIndex = clips.findIndex((clip, index) => {
    const displayName = clip?.name || `Animation ${index}`;
    return normalizeAnimationClipName(displayName) === normalizedRequested;
  });

  // 2. case-insensitive raw exact match
  if (clipIndex < 0) {
    const lowerRequested = requestedName.trim().toLowerCase();
    clipIndex = clips.findIndex((clip, index) => {
      const displayName = clip?.name || `Animation ${index}`;
      return String(displayName).trim().toLowerCase() === lowerRequested;
    });
  }

  // 3. safe partial match only if exactly one candidate matches
  if (clipIndex < 0) {
    const candidates = clips
      .map((clip, index) => ({
        index,
        name: clip?.name || `Animation ${index}`,
        normalized: normalizeAnimationClipName(clip?.name || `Animation ${index}`),
      }))
      .filter((candidate) => candidate.normalized.includes(normalizedRequested));

    if (candidates.length === 1) {
      clipIndex = candidates[0].index;
    } else if (candidates.length > 1) {
      return {
        ok: false,
        error: `ambiguous animation clip name: ${requestedName}`,
        candidates: candidates.map((candidate) => ({
          index: candidate.index,
          name: candidate.name,
        })),
        clips,
      };
    }
  }

  if (clipIndex < 0) {
    return {
      ok: false,
      error: `animation clip not found: ${requestedName}`,
      clips: serializeObjectAnimationClipSummariesForExternalUse(obj),
    };
  }

  return {
    ok: true,
    clipIndex,
    clipName: clips[clipIndex]?.name || `Animation ${clipIndex}`,
    matchedBy: 'clipName',
    clips,
  };
}

function clampAnimationClipIndex(value, clipCount) {
  const index = Number.parseInt(value, 10);
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.max(0, clipCount - 1), index));
}

function updateObjectGlbAnimationClip(objectId, nextClipIndex) {
  const entry = glbAnimationMixers.get(objectId);
  if (!entry || !Array.isArray(entry.clips) || entry.clips.length === 0) return;

  const clipIndex = clampAnimationClipIndex(nextClipIndex, entry.clips.length);
  if (entry.clipIndex === clipIndex && entry.action) return;

  if (entry.action) {
    entry.action.stop();
    entry.mixer.uncacheAction(entry.clips[entry.clipIndex]);
  }

  const clip = entry.clips[clipIndex];
  const action = entry.mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();

  entry.action = action;
  entry.clipIndex = clipIndex;

  const obj = managedObjects.get(objectId);
  if (obj) {
    const current =
      obj.userData?.animationState ||
      obj.userData?.scenesync?.animationState ||
      {};
    const next = {
      ...current,
      clip: clipIndex,
    };
    obj.userData.animationState = next;
    obj.userData.scenesync = {
      ...(obj.userData.scenesync || {}),
      animationState: next,
    };
  }

  console.info('[SceneSync] GLB animation clip selected', {
    objectId,
    clipIndex,
    name: clip?.name || `Animation ${clipIndex}`,
    duration: clip?.duration || null,
  });
}

function normalizeObjectAnimationState(current, delta, clipCount = 0) {
  const next = {
    enabled: current?.enabled !== false,
    clip: Number.isInteger(current?.clip) ? current.clip : 0,
    mode: current?.mode === 'once' ? 'once' : 'loop',
    speed: Number.isFinite(current?.speed) ? current.speed : 1,
  };

  if (typeof delta.enabled === 'boolean') {
    next.enabled = delta.enabled;
  }

  if (delta.clip !== undefined) {
    const rawIndex = Number.parseInt(delta.clip, 10);
    if (Number.isFinite(rawIndex)) {
      const maxIndex = Math.max(0, clipCount - 1);
      next.clip = Math.max(0, Math.min(maxIndex, rawIndex));
    }
  }

  if (delta.mode === 'loop' || delta.mode === 'once') {
    next.mode = delta.mode;
  }

  if (delta.speed !== undefined) {
    const speed = Number(delta.speed);
    if (Number.isFinite(speed) && speed >= 0) {
      next.speed = speed;
    }
  }

  return next;
}

function applyObjectAnimationDelta(obj, animationDelta) {
  if (!obj || !animationDelta || typeof animationDelta !== 'object') return;

  const clips = obj.userData?.scenesync?.animations;
  const clipCount = Array.isArray(clips) ? clips.length : 0;
  if (clipCount <= 0) return;

  const current =
    obj.userData?.animationState ||
    obj.userData?.scenesync?.animationState ||
    {};

  const next = normalizeObjectAnimationState(current, animationDelta, clipCount);

  obj.userData.animationState = next;
  obj.userData.scenesync = {
    ...(obj.userData.scenesync || {}),
    animationState: next,
  };

  updateObjectGlbAnimationClip(obj.userData.objectId, next.clip);
}

function serializeObjectAnimationState(obj) {
  const raw =
    obj?.userData?.animationState ||
    obj?.userData?.scenesync?.animationState ||
    null;
  if (!raw) return null;

  const clips = obj?.userData?.scenesync?.animations;
  const clipCount = Array.isArray(clips) ? clips.length : 0;
  const clip = clampAnimationClipIndex(raw.clip, clipCount || 1);
  const clipName = clips?.[clip]?.name || raw.clipName || null;

  return {
    enabled: raw.enabled !== false,
    clip,
    clipName,
    mode: raw.mode === 'once' ? 'once' : 'loop',
    speed: Number.isFinite(raw.speed) ? raw.speed : 1,
  };
}

function registerLoadedGlbAnimation(objectId, model, reason = 'unknown') {
  if (!objectId || !model) return;

  model.userData.objectId = objectId;
  managedObjects.set(objectId, model);
  setupObjectGlbAnimation(objectId, model);

  const clips = model.userData?.scenesync?.animations;
  if (Array.isArray(clips) && clips.length > 0) {
    console.info('[SceneSync] GLB animations registered', {
      objectId,
      reason,
      count: clips.length,
      names: clips.map((clip) => clip?.name || '(unnamed)'),
    });
  }
}

function updateObjectGlbAnimations(now = performance.now()) {
  for (const [objectId, entry] of glbAnimationMixers) {
    const obj = managedObjects.get(objectId);
    if (!obj) {
      disposeObjectGlbAnimation(objectId);
      continue;
    }

    const state = obj.userData?.animationState || obj.userData?.scenesync?.animationState;
    if (!state?.enabled) continue;

    const clipIndex = clampAnimationClipIndex(state.clip, entry.clips.length);
    if (entry.clipIndex !== clipIndex || !entry.action) {
      updateObjectGlbAnimationClip(objectId, clipIndex);
    }

    const clip = entry.clips[entry.clipIndex] || entry.clips[0];
    if (!clip || !entry.action) continue;

    const baseTime = getObjectRuntimeTime(objectId, now);
    const animationSpeed = Number.isFinite(state.speed) ? state.speed : 1;
    const t = baseTime * animationSpeed;
    const duration = clip.duration || 1;
    const clipTime = state.mode === 'loop'
      ? t % duration
      : Math.min(t, duration);

    entry.action.enabled = true;
    entry.action.paused = false;
    entry.action.time = clipTime;

    entry.mixer.update(0);
  }
}

function showTemporaryImagePreview(objectId, file, position, options = {}) {
  if (!objectId || !file) return;

  removeTemporaryImagePreview(objectId);

  const entry = {
    object: null,
    cancelled: false,
    objectUrl: null,
    texture: null,
    geometry: null,
    material: null,
  };

  temporaryImagePreviews.set(objectId, entry);

  if (options.targetKind === 'sky') {
    createTemporarySkyPreview(objectId, file, entry);
    return;
  }

  createTemporaryPlanePreview(objectId, file, position, entry, options);
}

async function createTemporaryPlanePreview(objectId, file, position, entry, options = {}) {
  const t0 = performance.now();

  try {
    const objectUrl = URL.createObjectURL(file);
    entry.objectUrl = objectUrl;

    const texture = await new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(objectUrl, resolve, undefined, reject);
    });

    if (entry.cancelled) {
      texture.dispose();
      return;
    }

    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    entry.texture = texture;

    const image = texture.image;
    const width = image?.naturalWidth || image?.width || 1;
    const height = image?.naturalHeight || image?.height || 1;
    const { width: planeWidth, height: planeHeight } = planeSizeFromImage(width, height, 2);

    const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      opacity: 0.75,
    });

    entry.geometry = geometry;
    entry.material = material;

    const group = new THREE.Group();
    group.name = 'temporary image preview';
    group.userData.objectId = objectId;
    group.userData._temporary = true;
    group.userData._temporaryImagePreview = true;
    // Temporary preview should not become selectable/inspectable.
    group.raycast = () => {};

    if (position?.copy) {
      group.position.copy(position);
    } else if (Array.isArray(position)) {
      group.position.fromArray(position);
    }

    const placementQuaternion = Array.isArray(options.placementRotation)
      ? new THREE.Quaternion().fromArray(options.placementRotation)
      : options.placementQuaternion || null;
    if (placementQuaternion) {
      group.quaternion.copy(placementQuaternion);
    }

    const mesh = new THREE.Mesh(geometry, material);
    // Match generated GLB grounding (root at bottom, mesh lifted by half height).
    mesh.position.y = planeHeight / 2;
    mesh.raycast = () => {};
    group.add(mesh);

    scene.add(group);
    entry.object = group;

    console.debug('[image-import] temporary preview shown', {
      tempObjectId: objectId,
      ms: Math.round(performance.now() - t0),
      width,
      height,
    });
  } catch (error) {
    if (!entry.cancelled) {
      console.warn('[image-import] temporary preview failed:', error);
    }
  }
}

async function createTemporarySkyPreview(objectId, file, entry) {
  const t0 = performance.now();

  try {
    const objectUrl = URL.createObjectURL(file);
    entry.objectUrl = objectUrl;

    const texture = await new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(objectUrl, resolve, undefined, reject);
    });

    if (entry.cancelled) {
      texture.dispose();
      return;
    }

    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    entry.texture = texture;

    const geometry = new THREE.SphereGeometry(49, 64, 32);
    geometry.scale(-1, 1, 1);
    geometry.computeVertexNormals();

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.FrontSide,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });

    entry.geometry = geometry;
    entry.material = material;

    const sphere = new THREE.Mesh(geometry, material);
    sphere.name = 'temporary skybox preview';
    sphere.userData.objectId = objectId;
    sphere.userData._temporary = true;
    sphere.userData._temporaryImagePreview = true;
    sphere.userData._temporarySkyPreview = true;
    // Temporary preview should not become selectable/inspectable.
    sphere.raycast = () => {};

    scene.add(sphere);
    entry.object = sphere;

    console.debug('[image-import] temporary sky preview shown', {
      tempObjectId: objectId,
      ms: Math.round(performance.now() - t0),
    });
  } catch (error) {
    if (!entry.cancelled) {
      console.warn('[image-import] temporary sky preview failed:', error);
    }
  }
}

function removeTemporaryImagePreview(objectId) {
  const entry = temporaryImagePreviews.get(objectId);
  if (!entry) return;

  entry.cancelled = true;

  if (entry.object) {
    scene.remove(entry.object);
  }

  entry.texture?.dispose();
  entry.geometry?.dispose();
  entry.material?.dispose();

  if (entry.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
  }

  temporaryImagePreviews.delete(objectId);
}

// ── レイキャスト選択 ─────────────────────────────────────

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerSelectionStart = null;
let lastPointerEventForPastePreview = null;

function getSelectedObjects() {
  return Array.from(selectedObjectIds)
    .map((objectId) => managedObjects.get(objectId))
    .filter(Boolean);
}

function removeSelectionHelper(objectId) {
  const helper = selectionHelpers.get(objectId);
  if (!helper) return;
  scene.remove(helper);
  helper.geometry?.dispose?.();
  helper.material?.dispose?.();
  selectionHelpers.delete(objectId);
}

function clearSelectionHelpers() {
  for (const objectId of Array.from(selectionHelpers.keys())) {
    removeSelectionHelper(objectId);
  }
}

function showSelectionHelper(object) {
  const objectId = object.userData?.objectId;
  if (!objectId || selectionHelpers.has(objectId)) return;

  const helper = new THREE.BoxHelper(object, 0xffff00);
  helper.userData.role = 'selection-helper';
  helper.raycast = () => {};
  scene.add(helper);
  selectionHelpers.set(objectId, helper);
}

function isPastePreviewUserData(userData) {
  if (!userData) return false;
  return userData.isPastePreview || userData.role === 'paste-preview';
}

function isSelectableObject(object) {
  if (!object) return false;

  const userData = object.userData || {};
  if (userData.role === 'multi-transform-pivot') return false;
  if (userData._temporary) return false;
  if (isPastePreviewUserData(userData)) return false;
  if (userData._isLoadingOverlay) return false;
  if (userData._isLockOverlay) return false;
  if (userData.role === 'avatar') return false;
  if (userData.role === 'helper') return false;
  if (userData.role === 'lock-overlay') return false;
  if (userData.isTransformHelper) return false;
  if (isSkySphereThreeObject(object)) return false;

  const objectId = userData.objectId;
  if (!objectId) return false;
  if (!managedObjects.has(objectId)) return false;

  return true;
}

function broadcastUnlockForObjectId(objectId) {
  if (!objectId) return;
  broadcast({
    kind: 'scene-unlock',
    objectId,
  });
}

function updateSelectionToolbar() {
  const count = selectedObjectIds.size;

  if (btnMove) btnMove.disabled = count === 0;
  if (btnRotate) btnRotate.disabled = count === 0;
  if (btnScale) btnScale.disabled = count === 0;
  if (btnCopy) btnCopy.disabled = count !== 1;
  if (btnDelete) btnDelete.disabled = count === 0;
}

function updateSelectionState(options = {}) {
  const {
    reason = 'selection-updated',
    broadcastUnlock = true,
    broadcastLock = true,
  } = options;

  for (const objectId of Array.from(selectedObjectIds)) {
    if (!managedObjects.has(objectId)) {
      selectedObjectIds.delete(objectId);
    }
  }

  const selectedObjects = getSelectedObjects();
  const shouldCleanupMultiPivot = selectedObjects.length <= 1 || !['translate', 'rotate', 'scale'].includes(transformCtrl.mode);
  if (shouldCleanupMultiPivot) {
    cleanupMultiTransformPivot();
  }

  const attachedObject = transformCtrl.object;
  const attachedObjectId = attachedObject?.userData?.objectId || null;
  const nextSingleObject = selectedObjects.length === 1 ? selectedObjects[0] : null;
  const nextSingleObjectId = nextSingleObject?.userData?.objectId || null;

  clearSelectionHelpers();
  selectedObjects.forEach(showSelectionHelper);

  if (attachedObjectId && attachedObjectId !== nextSingleObjectId && broadcastUnlock) {
    broadcastUnlockForObjectId(attachedObjectId);
  }

  if (selectedObjects.length === 0) {
    if (transformCtrl.object) transformCtrl.detach();
    hideToolbar();
    updateSelectionToolbar();
    updatePeersList();
    notifySelectionChanged(reason);
    return;
  }

  if (nextSingleObject) {
    if (transformCtrl.object !== nextSingleObject) {
      transformCtrl.attach(nextSingleObject);
    }
    if (broadcastLock && nextSingleObjectId && attachedObjectId !== nextSingleObjectId) {
      broadcast({ kind: 'scene-lock', objectId: nextSingleObjectId });
    }
    showToolbar();
    updateToolbarActive(transformCtrl.mode);
  } else {
    if (['translate', 'rotate', 'scale'].includes(transformCtrl.mode)) {
      startMultiTransformMode(transformCtrl.mode);
    } else if (transformCtrl.object) {
      transformCtrl.detach();
    }
    showToolbar();
  }

  updateSelectionToolbar();
  updatePeersList();
  notifySelectionChanged(reason);
}

function setSingleSelection(objectId, options = {}) {
  selectedObjectIds.clear();
  if (objectId) selectedObjectIds.add(objectId);
  updateSelectionState(options);
}

function toggleObjectSelection(objectId, options = {}) {
  if (!objectId) return;
  if (selectedObjectIds.has(objectId)) {
    selectedObjectIds.delete(objectId);
  } else {
    selectedObjectIds.add(objectId);
  }
  updateSelectionState(options);
}

function clearSelection(options = {}) {
  selectedObjectIds.clear();
  updateSelectionState(options);
}

function handleObjectSelection(object, event = null) {
  if (!isSelectableObject(object)) {
    clearSelection({ reason: 'selection-cleared-invalid' });
    return;
  }

  const objectId = object.userData.objectId;
  const multiToggle = event?.shiftKey || event?.metaKey || event?.ctrlKey;

  if (multiToggle) {
    toggleObjectSelection(objectId, { reason: 'object-selection-toggled' });
  } else {
    setSingleSelection(objectId, { reason: 'object-selected' });
  }
}

function selectManagedObject(obj, options = {}) {
  if (!isSelectableObject(obj)) return;
  const reason = options.reason || 'object-selected';
  setSingleSelection(obj.userData.objectId, { reason });
}

function selectObjectAt(clientX, clientY, event = null) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const targets = Array.from(managedObjects.values())
    .filter(obj => !isSkySphereThreeObject(obj));
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
      handleObjectSelection(obj, event);
    }
  } else {
    clearSelection({ reason: 'selection-cleared-raycast' });
  }
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (pastePreviewMode) {
    pointerSelectionStart = null;
    return;
  }
  if (e.pointerType === 'touch') return;
  pointerSelectionStart = {
    x: e.clientX,
    y: e.clientY,
    button: e.button,
  };
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
    lastPointerEventForPastePreview = {
      clientX: e.clientX,
      clientY: e.clientY,
    };
  }
  if (!pastePreviewMode) return;
  updatePastePreviewFromPointer(e);
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (pastePreviewMode) {
    pointerSelectionStart = null;
    return;
  }
  if (e.pointerType === 'touch') return;
  if (isDragging || !pointerSelectionStart) return;
  if (pointerSelectionStart.button !== 0 || e.button !== 0) return;

  const dx = e.clientX - pointerSelectionStart.x;
  const dy = e.clientY - pointerSelectionStart.y;
  pointerSelectionStart = null;

  if ((dx * dx + dy * dy) > 25) return;
  selectObjectAt(e.clientX, e.clientY, e);
});

renderer.domElement.addEventListener('pointercancel', () => {
  pointerSelectionStart = null;
});

renderer.domElement.addEventListener('click', (event) => {
  if (!pastePreviewMode) return;
  event.preventDefault();
  event.stopPropagation();
  commitPastePreviewPlacement({ selectPlaced: false });
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
  textPanelScrollActive = false;
  textPanelTouchCandidate = null;

  const touch = e.touches[0];
  if (!touch) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const targets = Array.from(managedObjects.values())
    .filter((obj) => obj.userData?.role === 'text-panel' && !isSkySphereThreeObject(obj));
  const hits = raycaster.intersectObjects(targets, true);

  if (hits.length > 0) {
    const hitObject = findTextPanelRoot(hits[0].object);
    if (hitObject && canScrollTextPanel(hitObject)) {
      textPanelTouchCandidate = {
        panel: hitObject,
        startX: touch.clientX,
        startY: touch.clientY,
        lastY: touch.clientY,
      };
    }
  }
}, { passive: false });

renderer.domElement.addEventListener('touchmove', (e) => {
  if (!textPanelTouchCandidate || textPanelScrollActive) {
    // Already in scroll mode or no candidate
    if (textPanelScrollActive && e.touches.length > 0) {
      const touch = e.touches[0];
      const deltaY = touch.clientY - textPanelTouchCandidate.lastY;
      textPanelTouchCandidate.lastY = touch.clientY;
      updateTextPanelScroll(textPanelTouchCandidate.panel.userData.objectId, -deltaY);
      e.preventDefault();
    }
    return;
  }

  touchMoved = true;

  if (e.touches.length > 0) {
    const touch = e.touches[0];
    const dx = touch.clientX - textPanelTouchCandidate.startX;
    const dy = touch.clientY - textPanelTouchCandidate.startY;

    const isVerticalDrag =
      Math.abs(dy) > SCROLL_DRAG_THRESHOLD_PX &&
      Math.abs(dy) > Math.abs(dx);

    if (isVerticalDrag) {
      textPanelScrollActive = true;
      textPanelTouchCandidate.lastY = touch.clientY;
      updateTextPanelScroll(textPanelTouchCandidate.panel.userData.objectId, -dy);
      e.preventDefault();
    }
  }
}, { passive: false });

function handleDoubleTap(clientX, clientY) {
  selectObjectAt(clientX, clientY);
}

renderer.domElement.addEventListener('touchend', (e) => {
  textPanelTouchCandidate = null;
  textPanelScrollActive = false;

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
      if (!touchMoved && (transformCtrl.object || selectedObjectIds.size > 0)) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((tapX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((tapY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const targets = Array.from(managedObjects.values())
          .filter(obj => !isSkySphereThreeObject(obj));
        const hits = raycaster.intersectObjects(targets, true);
        if (hits.length === 0) {
          clearSelection({ reason: 'selection-cleared-touch' });
        }
      }
    }, DOUBLE_TAP_DELAY + 50);
  }
}, { passive: false });

// ── Text Panel Scroll (wheel) ──────────────────────────────

function updateTextPanelScroll(objectId, deltaY) {
  const object = managedObjects.get(objectId);
  if (!object) return;

  const asset = object.userData?.asset;
  const metrics = object.userData?.textPanelMetrics;
  const resolvedText = object.userData?.resolvedText;

  if (!asset || !metrics) return;

  const currentScrollY = textPanelScrollState.get(objectId) ?? asset.scroll?.y ?? 0;
  const nextScrollY = clamp(currentScrollY + deltaY, 0, metrics.maxScrollY);

  if (nextScrollY === currentScrollY) return;

  textPanelScrollState.set(objectId, nextScrollY);

  // Rerender text panel with cached text + new scroll position
  const renderAsset = {
    ...asset,
    text: resolvedText || asset.text || '',
    scroll: { y: nextScrollY },
  };

  const result = renderTextPanelCanvas(renderAsset, { pixelsPerUnit: 512 });
  const canvas = result.canvas;

  const mesh = object.children.find((child) => child.isMesh);
  if (!mesh) return;

  const oldTexture = mesh.material.map;
  const newTexture = new THREE.CanvasTexture(canvas);
  newTexture.colorSpace = THREE.SRGBColorSpace;
  newTexture.magFilter = THREE.LinearFilter;
  newTexture.minFilter = THREE.LinearFilter;

  mesh.material.map = newTexture;
  mesh.material.needsUpdate = true;

  object.userData.textPanelMetrics = result.metrics;
  oldTexture?.dispose();
}

function handleTextPanelWheel(event) {
  // Only scroll text panels, not camera, if overflow
  if (transformCtrl.object) return; // Transform priority
  if (event.ctrlKey || event.metaKey) return; // Allow pinch-zoom

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const targets = Array.from(managedObjects.values())
    .filter((obj) => obj.userData?.role === 'text-panel' && !isSkySphereThreeObject(obj));
  const hits = raycaster.intersectObjects(targets, true);

  if (hits.length === 0) return;

  const hitObject = findTextPanelRoot(hits[0].object);
  if (!hitObject) return;
  if (!canScrollTextPanel(hitObject)) return;

  // Text panel is overflowing → prevent default & scroll
  event.preventDefault();
  event.stopPropagation();

  const deltaY = event.deltaY > 0 ? 40 : -40;
  const objectId = hitObject.userData.objectId;
  updateTextPanelScroll(objectId, deltaY);
}

renderer.domElement.addEventListener('wheel', handleTextPanelWheel, { passive: false });

// ── 削除ロジック（共通） ──────────────────────────────────

function cloneJsonSafe(value) {
  if (value == null) return null;

  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
  } catch {}

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}


function getCopyRotationForPayload(source) {
  return source.quaternion.toArray();
}

function buildCopyMetadata(sourceMetadata, asset, sourceObjectId) {
  const metadata = cloneJsonSafe(sourceMetadata) || {};

  const nextMetadata = {
    ...metadata,
    copiedFrom: sourceObjectId,
    copiedAt: Date.now(),
  };

  return nextMetadata;
}

function canDuplicateObject(object) {
  if (!object) return false;

  const userData = object.userData || {};
  if (userData._temporary) return false;
  if (userData._isLoadingOverlay) return false;
  if (userData._isLockOverlay) return false;
  if (userData.role === 'avatar') return false;
  if (userData.role === 'helper') return false;
  if (userData.role === 'lock-overlay') return false;
  if (userData.role === 'sky-sphere') return false;
  if (userData.metadata?.role === 'sky-sphere') return false;
  if (userData.isTransformHelper) return false;
  if (isSkySphereThreeObject(object)) return false;

  const objectId = userData.objectId;
  if (!objectId) return false;
  if (!managedObjects.has(objectId)) return false;

  return true;
}

function getDuplicateOffset() {
  const offset = new THREE.Vector3(0.35, 0, 0);

  if (camera) {
    offset.applyQuaternion(camera.quaternion);
    offset.y = 0;

    if (offset.lengthSq() > 1e-6) {
      return offset.normalize().multiplyScalar(0.35);
    }
  }

  return new THREE.Vector3(0.35, 0, 0.35);
}

function getClipboardPasteOffset(count = 1) {
  const step = 0.35;
  const distance = step * Math.max(1, count);
  const offset = new THREE.Vector3(distance, 0, distance);

  if (camera) {
    const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    cameraRight.y = 0;

    if (cameraRight.lengthSq() > 1e-6) {
      return cameraRight.normalize().multiplyScalar(distance);
    }
  }

  return offset;
}

function disposePastePreviewObject(root) {
  if (!root) return;
  root.traverse((obj) => {
    if (!obj?.isMesh || !obj.material) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of materials) {
      mat?.dispose?.();
    }
  });
}

function cleanupPastePreview() {
  pastePreviewMode = false;
  pastePreviewPlacement = null;

  if (pastePreviewObject) {
    scene.remove(pastePreviewObject);
    disposePastePreviewObject(pastePreviewObject);
    pastePreviewObject = null;
  }

  disposeStampPreviewGizmo();
}

function computeStampPreviewBoundsSize(sourceObject) {
  const fallback = new THREE.Vector3(1, 1, 1);
  if (!sourceObject) return fallback.clone();

  const box = new THREE.Box3().setFromObject(sourceObject);
  const size = new THREE.Vector3();
  box.getSize(size);

  const valid =
    Number.isFinite(size.x) &&
    Number.isFinite(size.y) &&
    Number.isFinite(size.z) &&
    size.lengthSq() > 0.000001;

  if (!valid) return fallback.clone();

  const minSize = 0.05;
  size.x = Math.max(size.x, minSize);
  size.y = Math.max(size.y, minSize);
  size.z = Math.max(size.z, minSize);

  return size;
}

function createStampPreviewGizmo(size) {
  const safeSize = size || new THREE.Vector3(1, 1, 1);
  const geometry = new THREE.BoxGeometry(safeSize.x, safeSize.y, safeSize.z);
  const edges = new THREE.EdgesGeometry(geometry);
  geometry.dispose();

  const material = new THREE.LineBasicMaterial({
    color: 0x66ccff,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });

  const gizmo = new THREE.LineSegments(edges, material);
  gizmo.name = 'scene-sync-stamp-preview-gizmo';
  gizmo.userData = {
    isSceneSyncHelper: true,
    isStampPreviewGizmo: true,
  };
  gizmo.raycast = () => {};
  gizmo.renderOrder = 9999;
  gizmo.frustumCulled = false;
  gizmo.matrixAutoUpdate = true;

  return gizmo;
}

function disposeStampPreviewGizmo() {
  const gizmo = stampPreviewGizmoState.object;
  if (!gizmo) return;

  if (gizmo.parent) gizmo.parent.remove(gizmo);
  gizmo.geometry?.dispose?.();
  gizmo.material?.dispose?.();

  stampPreviewGizmoState.object = null;
  stampPreviewGizmoState.sourceObjectId = null;
}

function ensureStampPreviewGizmo(sourceObjectId, sourceObject) {
  const size = computeStampPreviewBoundsSize(sourceObject);
  const needsRecreate =
    !stampPreviewGizmoState.object ||
    stampPreviewGizmoState.sourceObjectId !== sourceObjectId;

  if (needsRecreate) {
    disposeStampPreviewGizmo();
    stampPreviewGizmoState.object = createStampPreviewGizmo(size);
    stampPreviewGizmoState.sourceObjectId = sourceObjectId;
    stampPreviewGizmoState.size.copy(size);
    scene.add(stampPreviewGizmoState.object);
  }

  return stampPreviewGizmoState.object;
}

function updateStampPreviewGizmo({ sourceObjectId, sourceObject, position, quaternion }) {
  const gizmo = ensureStampPreviewGizmo(sourceObjectId, sourceObject);
  if (!gizmo) return;

  gizmo.visible = true;
  if (position) gizmo.position.copy(position);
  if (quaternion) gizmo.quaternion.copy(quaternion);

  // Box3.setFromObject(sourceObject) already includes object scale.
  // Do not apply clipboard scale again.
  gizmo.scale.set(1, 1, 1);

  gizmo.updateMatrixWorld(true);
}

function hideStampPreviewGizmo() {
  if (stampPreviewGizmoState.object) stampPreviewGizmoState.object.visible = false;
}

function makeObjectTransparentPreview(root) {
  root.traverse((obj) => {
    if (!obj?.isMesh || !obj.material) return;

    const original = obj.material;
    const materials = Array.isArray(original) ? original : [original];
    const previewMaterials = materials.map((mat) => {
      const cloned = mat.clone();
      cloned.transparent = true;
      cloned.opacity = Math.min(
        typeof cloned.opacity === 'number' ? cloned.opacity : 1,
        0.35
      );
      cloned.depthWrite = false;
      return cloned;
    });

    obj.material = Array.isArray(original) ? previewMaterials : previewMaterials[0];
  });
}

function disableObjectRaycast(root) {
  root.traverse((obj) => {
    obj.userData = {
      ...(obj.userData || {}),
      _temporary: true,
      role: 'paste-preview',
      isPastePreview: true,
    };
    if (obj.isMesh) {
      obj.raycast = () => {};
    }
  });
}

async function createPastePreviewObject(clip) {
  const source = managedObjects.get(clip?.sourceObjectId);
  if (!source) return null;

  const preview = source.clone(true);
  preview.userData = {
    ...(preview.userData || {}),
    role: 'paste-preview',
    _temporary: true,
    isPastePreview: true,
  };

  makeObjectTransparentPreview(preview);
  disableObjectRaycast(preview);
  return preview;
}

function getPointerPlacementFromEvent(event = null) {
  if (!event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
    return null;
  }
  if (dragDropManager?.getPlacementFromPointerEvent) {
    return dragDropManager.getPlacementFromPointerEvent(event);
  }
  return null;
}

function updatePastePreviewFromPointer(event = null) {
  if (!pastePreviewMode || !pastePreviewObject) return;
  const placement = getPointerPlacementFromEvent(event);
  if (!placement?.position) {
    hideStampPreviewGizmo();
    return;
  }

  const clip = sceneObjectClipboard;
  const positionArray = placement.position.toArray
    ? placement.position.toArray()
    : (Array.isArray(placement.position) ? placement.position : null);
  if (!positionArray) {
    hideStampPreviewGizmo();
    return;
  }

  pastePreviewPlacement = {
    position: positionArray,
    rotation: Array.isArray(clip?.rotation) ? clip.rotation : [0, 0, 0, 1],
    scale: Array.isArray(clip?.scale) ? clip.scale : [1, 1, 1],
    targetKind: placement.targetKind || null,
    surfaceKind: placement.surfaceKind || null,
    normalArray: placement.normalArray || null,
  };

  pastePreviewObject.position.fromArray(pastePreviewPlacement.position);
  pastePreviewObject.quaternion.fromArray(pastePreviewPlacement.rotation);
  pastePreviewObject.scale.fromArray(pastePreviewPlacement.scale);
  pastePreviewObject.updateMatrixWorld(true);
  pastePreviewObject.visible = true;

  const sourceObjectId = clip?.sourceObjectId;
  const sourceObject = sourceObjectId ? managedObjects.get(sourceObjectId) : null;
  const gizmoPosition = new THREE.Vector3().fromArray(pastePreviewPlacement.position);
  const gizmoQuaternion = new THREE.Quaternion().fromArray(pastePreviewPlacement.rotation);
  updateStampPreviewGizmo({
    sourceObjectId,
    sourceObject,
    position: gizmoPosition,
    quaternion: gizmoQuaternion,
  });
}

async function startPastePreviewMode() {
  if (!sceneObjectClipboard) {
    showToast?.('ペーストするオブジェクトがありません');
    return false;
  }

  cleanupPastePreview();

  pastePreviewObject = await createPastePreviewObject(sceneObjectClipboard);
  if (!pastePreviewObject) {
    showToast?.('プレビューを作成できませんでした');
    return false;
  }

  pastePreviewMode = true;
  scene.add(pastePreviewObject);

  const sourceObjectId = sceneObjectClipboard?.sourceObjectId;
  const sourceObject = sourceObjectId ? managedObjects.get(sourceObjectId) : null;
  const gizmo = ensureStampPreviewGizmo(sourceObjectId, sourceObject);
  gizmo.visible = false;

  if (lastPointerEventForPastePreview) {
    updatePastePreviewFromPointer(lastPointerEventForPastePreview);
  } else {
    pastePreviewObject.visible = false;
  }
  showToast?.('配置位置を選んでください。Ctrl/Cmd+V またはクリックで配置、Escで終了');
  return true;
}

function selectDuplicatedObjectWhenReady(objectId, attempt = 0) {
  const duplicated = managedObjects.get(objectId);
  if (duplicated) {
    selectManagedObject(duplicated);
    return;
  }

  if (attempt >= 80) return;
  setTimeout(() => selectDuplicatedObjectWhenReady(objectId, attempt + 1), 50);
}

function duplicateSelectedObject() {
  const source = transformCtrl.object;

  if (!canDuplicateObject(source)) {
    showToast?.('コピーできるオブジェクトを選択してください');
    return;
  }

  const sourceObjectId = source.userData.objectId;
  const newObjectId = generateObjectId('copy');
  const position = source.position.clone().add(getDuplicateOffset());
  const scale = source.scale.clone();
  const asset = cloneJsonSafe(source.userData?.asset || null);
  const sourceMetadata = cloneJsonSafe(source.userData?.metadata || null) || {};
  const rotation = getCopyRotationForPayload(source);
  const newMetadata = buildCopyMetadata(sourceMetadata, asset, sourceObjectId);
  const meshPath = asset?.meshPath || source.userData?.meshPath || null;
  const name = `${source.userData?.name || source.name || 'Object'} Copy`;

  const payload = {
    kind: 'scene-add',
    objectId: newObjectId,
    name,
    position: position.toArray(),
    rotation,
    scale: scale.toArray(),
    asset,
    meshPath,
    metadata: newMetadata,
  };

  addOrUpdateObject(newObjectId, payload, {
    source: 'local-copy',
  });

  presenceState.historyManager?.push(
    HistoryManager.createAddEntry(
      newObjectId,
      asset || {},
      payload.position,
      payload.rotation,
      payload.scale,
      name,
      meshPath
    )
  );

  console.debug('[scene-copy] duplicate payload asset', {
    objectId: newObjectId,
    meshPath,
    visualBasis: asset?.visualBasis,
    rotation,
  });
  console.debug('[scene-copy] root rotation copied as-is', {
    sourceObjectId,
    visualBasis: asset?.visualBasis,
    rotation,
  });

  broadcast(payload);
  notifySceneStateChanged('object-copy');
  selectDuplicatedObjectWhenReady(newObjectId);
  showToast?.('オブジェクトをコピーしました');
}

function copySelectedObjectToSceneClipboard() {
  const source = transformCtrl?.object || null;

  if (!canDuplicateObject(source)) {
    showToast?.('コピーできるオブジェクトを選択してください');
    return false;
  }

  const sourceObjectId = source.userData.objectId;
  const asset = cloneJsonSafe(source.userData?.asset || null);
  const sourceMetadata = cloneJsonSafe(source.userData?.metadata || null) || {};
  const metadata = buildCopyMetadata(sourceMetadata, asset, sourceObjectId);
  const rotation = getCopyRotationForPayload(source);

  sceneObjectClipboard = {
    schemaVersion: 1,
    copiedAt: Date.now(),
    sourceObjectId,
    name: source.userData?.name || source.name || 'Object',
    asset,
    meshPath: source.userData?.meshPath || source.userData?.asset?.meshPath || null,
    metadata,
    position: source.position.toArray(),
    rotation,
    scale: source.scale.toArray(),
  };
  sceneObjectPasteCount = 0;
  cleanupPastePreview();

  showToast?.('オブジェクトをコピーしました');
  console.debug('[scene-clipboard] copied object', {
    sourceObjectId,
    visualBasis: asset?.visualBasis,
    rotation,
    assetId: sceneObjectClipboard.asset?.assetId || null,
    meshPath: sceneObjectClipboard.meshPath || null,
  });

  return true;
}

function pasteSceneObjectClipboard() {
  if (!sceneObjectClipboard) {
    showToast?.('ペーストするオブジェクトがありません');
    return false;
  }

  const clip = sceneObjectClipboard;
  const newObjectId = generateObjectId('paste');
  sceneObjectPasteCount += 1;

  const basePosition = new THREE.Vector3().fromArray(
    Array.isArray(clip.position) ? clip.position : [0, 0, 0]
  );
  const position = basePosition.add(getClipboardPasteOffset(sceneObjectPasteCount));
  const rotation = Array.isArray(clip.rotation) ? clip.rotation : [0, 0, 0, 1];
  const scale = Array.isArray(clip.scale) ? clip.scale : [1, 1, 1];
  const asset = cloneJsonSafe(clip.asset);
  const metadata = cloneJsonSafe(clip.metadata) || {};
  const meshPath = clip.meshPath || asset?.meshPath || null;
  const name = `${clip.name || 'Object'} Copy`;

  const payload = {
    kind: 'scene-add',
    objectId: newObjectId,
    name,
    position: position.toArray(),
    rotation,
    scale,
    asset,
    meshPath,
    metadata: {
      ...metadata,
      copiedFrom: clip.sourceObjectId,
      pastedFromClipboard: true,
      pastedAt: Date.now(),
    },
  };

  addOrUpdateObject(newObjectId, payload, {
    source: 'local-clipboard-paste',
  });

  presenceState.historyManager?.push(
    HistoryManager.createAddEntry(
      newObjectId,
      asset || {},
      payload.position,
      payload.rotation,
      payload.scale,
      name,
      meshPath
    )
  );

  broadcast(payload);
  notifySceneStateChanged('clipboard-paste');
  selectDuplicatedObjectWhenReady(newObjectId);
  showToast?.('オブジェクトをペーストしました');
  console.debug('[scene-clipboard] pasted object', {
    sourceObjectId: clip.sourceObjectId,
    objectId: newObjectId,
    pasteCount: sceneObjectPasteCount,
    assetId: asset?.assetId || null,
    meshPath: payload.meshPath || null,
  });

  return true;
}

function commitPastePreviewPlacement({ selectPlaced = true } = {}) {
  if (!pastePreviewMode || !sceneObjectClipboard || !pastePreviewPlacement) {
    return pasteSceneObjectClipboard();
  }

  const clip = sceneObjectClipboard;
  const newObjectId = generateObjectId('paste');
  sceneObjectPasteCount += 1;

  const asset = cloneJsonSafe(clip.asset);
  const metadata = cloneJsonSafe(clip.metadata) || {};
  const meshPath = clip.meshPath || asset?.meshPath || null;
  const name = `${clip.name || 'Object'} Copy`;

  const payload = {
    kind: 'scene-add',
    objectId: newObjectId,
    name,
    position: pastePreviewPlacement.position,
    rotation: pastePreviewPlacement.rotation,
    scale: pastePreviewPlacement.scale,
    asset,
    meshPath,
    metadata: {
      ...metadata,
      copiedFrom: clip.sourceObjectId,
      pastedFromClipboard: true,
      pastedAt: Date.now(),
      pastePlacement: {
        targetKind: pastePreviewPlacement.targetKind || null,
        surfaceKind: pastePreviewPlacement.surfaceKind || null,
        normal: pastePreviewPlacement.normalArray || null,
      },
    },
  };

  addOrUpdateObject(newObjectId, payload, {
    source: 'local-clipboard-stamp',
  });

  presenceState.historyManager?.push(
    HistoryManager.createAddEntry(
      newObjectId,
      asset || {},
      payload.position,
      payload.rotation,
      payload.scale,
      name,
      meshPath
    )
  );

  broadcast(payload);
  notifySceneStateChanged('clipboard-stamp');
  if (selectPlaced) {
    selectDuplicatedObjectWhenReady(newObjectId);
  }
  showToast?.('配置しました');
  return true;
}

function shouldIgnoreSceneShortcut(event) {
  const target = event.target;
  if (!target) return false;

  const tagName = target.tagName?.toLowerCase?.();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }

  if (target.isContentEditable) return true;

  if (target.closest?.('[contenteditable="true"], .cm-editor, .monaco-editor')) {
    return true;
  }

  return false;
}

function deleteObjectById(objectId, options = {}) {
  const {
    broadcastDelete = true,
    pushHistory = true,
    notifyScene = true,
    updateSelection = true,
    ignoreLock = false,
  } = options;
  const attached = managedObjects.get(objectId);
  if (!attached) {
    selectedObjectIds.delete(objectId);
    removeSelectionHelper(objectId);
    if (updateSelection) {
      updateSelectionState({
        reason: 'selected-object-removed',
        broadcastUnlock: false,
        broadcastLock: false,
      });
    }
    return false;
  }

  if (transformCtrl.object === attached) {
    transformCtrl.detach();
  }

  if (!ignoreLock && locks.has(objectId)) {
    const lockInfo = locks.get(objectId);
    const lockOwnerId = lockInfo?.id;
    if (lockOwnerId && lockOwnerId !== presenceState.id) {
      showToast('他のユーザーが編集中です');
      return false;
    }

    if (broadcastDelete) {
      broadcastUnlockForObjectId(objectId);
    }
  }

  removeLockOverlay(objectId);
  removeLoadingOverlay(objectId);
  removeRecoveringOverlay(objectId);
  removeFailedOverlay(objectId);
  locks.delete(objectId);

  disposeObjectGlbAnimation(objectId);

  // 削除前にオブジェクト情報を保存
  const name = attached.userData.name || objectId;
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
  managedObjects.delete(objectId);
  removedObjectIds.add(objectId);
  selectedObjectIds.delete(objectId);
  removeSelectionHelper(objectId);

  if (pastePreviewMode && sceneObjectClipboard?.sourceObjectId === objectId) {
    cleanupPastePreview();
  }

  // 履歴に追加
  if (pushHistory) {
    presenceState.historyManager?.push(
      HistoryManager.createRemoveEntry(objectId, name, asset, position, rotation, scale)
    );
  }

  if (broadcastDelete) {
    broadcast({ kind: 'scene-remove', objectId });
  }
  if (updateSelection) {
    updateSelectionState({
      reason: 'selected-object-removed',
      broadcastUnlock: false,
      broadcastLock: false,
    });
  }
  if (notifyScene) {
    notifySceneStateChanged('selected-object-deleted');
  }
  updateEnvironmentMenuSkyboxControls();
  return true;
}

function deleteSelectedObjects() {
  cleanupMultiTransformPivot();

  const ids = Array.from(selectedObjectIds);

  if (ids.length === 0) {
    const singleObjectId = transformCtrl?.object?.userData?.objectId || null;
    if (singleObjectId) ids.push(singleObjectId);
  }

  if (ids.length === 0) return;

  let deletedCount = 0;
  ids.forEach((objectId) => {
    const deleted = deleteObjectById(objectId, {
      broadcastDelete: true,
      pushHistory: true,
      notifyScene: false,
      updateSelection: false,
    });
    if (deleted) deletedCount += 1;
  });

  updateSelectionState({
    reason: 'bulk-delete-updated',
    broadcastUnlock: false,
    broadcastLock: false,
  });
  if (deletedCount === 0) return;

  notifySceneStateChanged(deletedCount > 1 ? 'bulk-delete' : 'selected-object-deleted');
  showToast?.(`${deletedCount}件のオブジェクトを削除しました`);
}

// ── モバイルツールバー ──────────────────────────────────

const toolbar = document.getElementById('mobile-toolbar');
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnMove = document.getElementById('btn-move');
const btnRotate = document.getElementById('btn-rotate');
const btnScale = document.getElementById('btn-scale');
const btnCopy = document.getElementById('btn-copy');
const btnDelete = document.getElementById('btn-delete');
const btnDeselect = document.getElementById('btn-deselect');

function showToolbar() {
  if (!toolbar) return;

  if (!isSceneSyncMobileDevice()) {
    toolbar.style.display = 'none';
    return;
  }

  toolbar.style.display = 'flex';
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

function setTransformMode(mode) {
  if (selectedObjectIds.size > 1 && ['translate', 'rotate', 'scale'].includes(mode)) {
    startMultiTransformMode(mode);
    updateToolbarActive(mode);
    return;
  }

  cleanupMultiTransformPivot();
  transformCtrl.setMode(mode);
  updateToolbarActive(mode);
}

btnMove?.addEventListener('click', () => {
  setTransformMode('translate');
});

btnRotate?.addEventListener('click', () => {
  setTransformMode('rotate');
});

btnScale?.addEventListener('click', () => {
  setTransformMode('scale');
});

btnCopy?.addEventListener('click', () => {
  duplicateSelectedObject();
});

btnDeselect?.addEventListener('click', () => {
  clearSelection({ reason: 'selection-cleared-button' });
});

btnDelete?.addEventListener('click', () => {
  deleteSelectedObjects();
});

updateSelectionToolbar();

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
  if (shouldIgnoreSceneShortcut(e)) return;

  // ドラッグ中は Undo/Redo を無効化
  if (isDragging) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'y')) {
      e.preventDefault();
      return;
    }
  }

  const isMod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (isMod && !e.altKey && key === 'c') {
    if (selectedObjectIds.size !== 1) return;
    if (!transformCtrl?.object) return;

    if (copySelectedObjectToSceneClipboard()) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }

  if (isMod && !e.altKey && key === 'v') {
    if (!sceneObjectClipboard) return;

    e.preventDefault();
    e.stopPropagation();

    if (!pastePreviewMode) {
      startPastePreviewMode();
    } else {
      commitPastePreviewPlacement({ selectPlaced: false });
    }
    return;
  }

  // Undo: Ctrl+Z (Cmd+Z on Mac)
  if (isMod && key === 'z' && !e.shiftKey) {
    e.preventDefault();
    performUndo();
    return;
  }

  // Redo: Ctrl+Y or Ctrl+Shift+Z (Cmd+Shift+Z on Mac)
  if (isMod && (key === 'y' || (key === 'z' && e.shiftKey))) {
    e.preventDefault();
    performRedo();
    return;
  }

  switch (key) {
    case 'w': setTransformMode('translate'); break;
    case 'e': setTransformMode('rotate'); break;
    case 'r': setTransformMode('scale'); break;
    case 'escape':
      if (pastePreviewMode) {
        e.preventDefault();
        cleanupPastePreview();
        showToast?.('配置モードを終了しました');
        break;
      }
      if (transformCtrl.object) {
        const objectId = transformCtrl.object.userData?.objectId;
        if (objectId) {
          broadcast({
            kind: 'scene-unlock',
            objectId,
          });
        }
      }
      cleanupMultiTransformPivot();
      transformCtrl.detach();
      hideToolbar();
      break;
    case 'delete':
    case 'backspace': {
      e.preventDefault();
      deleteSelectedObjects();
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

  updateTransformTweens(time);
  updateRuntimeSelectionTransition();

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

  updateRecoveringOverlaysAnimation();

  for (const helper of selectionHelpers.values()) {
    helper.update?.();
  }

  const now = performance.now();
  updateObjectGlbAnimations(now);
  loomIntegration?.tickObjectGraphs?.(now);

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
const peersPanelEl = dom.peersPanel;
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
const sceneInspectorAnimationControlsEl = document.getElementById('scene-inspector-animation-controls');
const sceneInspectorAnimationMetaEl = document.getElementById('scene-inspector-animation-meta');
const sceneInspectorAnimationEnabledEl = document.getElementById('scene-inspector-animation-enabled');
const sceneInspectorAnimationClipEl = document.getElementById('scene-inspector-animation-clip');
const sceneInspectorAnimationSpeedEl = document.getElementById('scene-inspector-animation-speed');

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
  const nameParam = normalizeDisplayName(new URLSearchParams(location.search).get('name'));
  if (nameParam) return nameParam;

  const sceneSyncName = normalizeDisplayName(localStorage.getItem('sceneSync.displayName'));
  if (sceneSyncName) return sceneSyncName;

  const stored = normalizeDisplayName(localStorage.getItem('pipe.deviceName'));
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
let reconnectBlockedReason = null;
let saveRoomSnapshotTimer = null;
let restoreSnapshotTimer = null;
let isRestoringRoomSnapshot = false;
let sceneObjectClipboard = null;
let sceneObjectPasteCount = 0;
let pastePreviewMode = false;
let pastePreviewObject = null;
let pastePreviewPlacement = null;
const stampPreviewGizmoState = {
  object: null,
  sourceObjectId: null,
  size: new THREE.Vector3(1, 1, 1),
};
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
  getObjectRuntimeTime,
  isObjectBeingEdited: (objectId) => {
    if (!objectId) return false;

    if (selectedObjectIds.has(objectId)) return true;

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

function sendHelloIfConnected() {
  const ws = presenceState.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'hello',
      nickname: presenceState.nickname,
      device: navigator.userAgent.slice(0, 60),
      userId: presenceState.userId,
    }));
  }
}

function editNickname() {
  const next = prompt('表示名を入力してください', presenceState.nickname) || '';
  const cleaned = normalizeDisplayName(next);
  if (!cleaned || cleaned === presenceState.nickname) return;
  presenceState.nickname = cleaned;
  localStorage.setItem('pipe.deviceName', cleaned);
  localStorage.setItem('sceneSync.displayName', cleaned);
  updateNicknameLabel();
  updatePeersList();
  sendHelloIfConnected();
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
  cleanupPastePreview();
  clearSelectionHelpers();
  selectedObjectIds.clear();
  for (const tempObjectId of [...temporaryImagePreviews.keys()]) {
    removeTemporaryImagePreview(tempObjectId);
    removeLoadingOverlay(tempObjectId);
  }

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
  updateSelectionToolbar();
}

function reconnectPresence() {
  clearTimeout(reconnectTimer);
  clearTimeout(saveRoomSnapshotTimer);
  clearTimeout(restoreSnapshotTimer);
  clearTimeout(aiTransformTweenSnapshotTimer);
  saveRoomSnapshotTimer = null;
  restoreSnapshotTimer = null;
  aiTransformTweenSnapshotTimer = null;
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


function clearRoom() {
  activeRoomCode = null;
  const u = new URL(location.href);
  u.searchParams.delete('room');
  history.replaceState(null, '', u.toString());
  reconnectPresence();
  notifyConnectionStateChanged('room-cleared');
}

function handleRoomFullError(data) {
  reconnectBlockedReason = 'room_full';
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const ws = presenceState.ws;
  presenceState.ws = null;
  if (ws) {
    try { ws.close(); } catch {}
  }
  updateStatus(false, 'ルームが満員です');
  remoteAvatarManager.disposeAllRemoteAvatars();
  updatePeersList();
  notifyConnectionStateChanged('presence-closed');
  showRoomFullDialog();
}

function showRoomFullDialog() {
  const dialog = document.getElementById('room-full-dialog');
  if (dialog) {
    dialog.style.display = 'flex';
  }
}

function hideRoomFullDialog() {
  const dialog = document.getElementById('room-full-dialog');
  if (dialog) {
    dialog.style.display = 'none';
  }
}

function copyRoomUrl() {
  if (!activeRoomCode) return;
  navigator.clipboard.writeText(roomShareUrl(activeRoomCode))
    .then(() => showToast('URL をコピーしました'))
    .catch(() => showToast('コピーに失敗しました'));
}

function renderMobileRoomActions() {
  const container = document.getElementById('mobile-room-actions');
  if (!container) return;

  container.innerHTML = '';

  if (activeRoomCode) {
    const code = document.createElement('div');
    code.className = 'chip';
    code.textContent = `🏠 ${activeRoomCode}`;
    container.appendChild(code);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'chip primary';
    copyBtn.textContent = '共有URLをコピー';
    copyBtn.addEventListener('click', () => {
      copyRoomUrl();
      closeMobileRoomSheet();
    });
    container.appendChild(copyBtn);

    const leaveBtn = document.createElement('button');
    leaveBtn.type = 'button';
    leaveBtn.className = 'chip danger';
    leaveBtn.textContent = 'ルームを離脱';
    leaveBtn.addEventListener('click', () => {
      clearRoom();
      closeMobileRoomSheet();
    });
    container.appendChild(leaveBtn);

    return;
  }

  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'chip primary';
  createBtn.textContent = '新しいルームを作成';
  createBtn.addEventListener('click', () => {
    generateRoom();
    closeMobileRoomSheet();
  });
  container.appendChild(createBtn);
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
  }

  renderMobileRoomActions();
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
        scheduleMaybeRestoreRoomSnapshot('presence-welcome');
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
        if (!hasOtherParticipants()) {
          if (!sceneReceived) sceneReceived = true;
          scheduleMaybeRestoreRoomSnapshot('peers-updated');
        }
        break;
      }

      case 'handoff':
        handleHandoff(data);
        break;
      case 'error':
        if (data?.error === 'room_full') {
          handleRoomFullError(data);
          return;
        }
        showToast(data?.message || 'ファイルの読み込みに失敗しました。');
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

    // room_full の場合は自動再接続をしない
    if (reconnectBlockedReason === 'room_full') {
      return;
    }

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

function updateStatus(connected, customMessage) {
  if (connected) {
    const n = presenceState.peers.length;
    dotEl.className = 'dot on';
    statusEl.innerHTML = `<span class="dot on"></span>${escapeHtml(presenceState.nickname)} · ${escapeHtml(presenceState.room || '—')} · ${n} peer${n !== 1 ? 's' : ''}`;
  } else if (customMessage) {
    dotEl.className = 'dot off';
    statusEl.innerHTML = `<span class="dot off"></span>${escapeHtml(customMessage)}`;
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
    scheduleMaybeRestoreRoomSnapshot('scene-request-no-peers');
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

    if (obj.userData.runtime) {
      entry.runtime = {
        enabled: obj.userData.runtime.enabled ?? true,
        speed: obj.userData.runtime.speed ?? 1,
        selectedTime: obj.userData.runtime.selectedTime ?? 0,
      };
    }

    if (obj.userData.animationState || obj.userData.scenesync?.animationState) {
      entry.animation = structuredClone(
        obj.userData.animationState || obj.userData.scenesync.animationState
      );
    }

    objects[objectId] = entry;
  }

  const ws = presenceState.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    const payload = { kind: 'scene-state', envId: environmentManager.getCurrentEnvId(), objects };

    // BGM state を含める
    const bgmState = serializeSceneBgm();
    if (bgmState) {
      payload.bgm = bgmState;
    }

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

  // Handle Scene Sync asset recovery request
  if (payload.kind === 'scene-asset-request') {
    expiredGlbRecovery.handleSceneAssetRequest({ payload, from: data.from });
    return;
  }

  // Handle generic file transfer (for recovered GLB delivery)
  if (payload.kind === 'file') {
    const canAccept = expiredGlbRecovery.canAcceptFileHandoff({
      fromPeerId: data.from?.id,
      filename: payload.filename,
      size: payload.size,
      mime: payload.mime,
    });

    if (canAccept) {
      fileTransferAdapter.maybeHandleFileTransferHandoff({ payload, from: data.from }).catch(err => {
        console.warn('[FileTransferAdapter] Error in handoff:', err);
      });
    } else {
      console.log('[SceneSync] File handoff rejected by GLB recovery filter');
    }
    return;
  }

  if (!payload.kind) return;

  // 操作が自分またはAIが代理している場合、履歴に追加するか判定
  const isOwn = data.from.id === presenceState.id;
  const isOnBehalfOf = payload.onBehalfOf === presenceState.userId;
  const shouldTrackHistory = isOwn || isOnBehalfOf;

  if (
    payload.kind === 'scene-batch' ||
    payload.kind === 'scene-delta' ||
    payload.kind === 'scene-add' ||
    payload.kind === 'scene-remove'
  ) {
    console.debug('[handoff] scene mutation received', {
      kind: payload.kind,
      objectId: payload.objectId || null,
      fromId: data.from?.id || null,
      selfPeerId: presenceState.id || null,
      onBehalfOf: payload.onBehalfOf || null,
      selfUserId: presenceState.userId || null,
      isOwn,
      isOnBehalfOf,
      shouldTrackHistory,
    });
  }

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

      // BGM 状態を復元
      if ('bgm' in payload) {
        if (payload.bgm === null) {
          disposeSceneBgm();
        } else if (payload.bgm) {
          applySceneBgm(payload.bgm);
        }
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
      if (isOwn) {
        console.debug('[scene-delta] skipped own echo', {
          objectId: payload.objectId || null,
          fromId: data.from?.id || null,
          selfPeerId: presenceState.id || null,
          onBehalfOf: payload.onBehalfOf || null,
          selfUserId: presenceState.userId || null,
          isOnBehalfOf,
        });
        break;
      }
      const obj = managedObjects.get(payload.objectId);
      if (!obj) {
        console.warn('[scene-delta] target object not found', {
          objectId: payload.objectId || null,
          knownObjectIds: Array.from(managedObjects.keys()).slice(0, 20),
        });
        break;
      }
      const beforePos = obj.position.toArray();
      const beforeRot = obj.quaternion.toArray();
      const beforeScl = obj.scale.toArray();

      // Calculate target values for history (before animation starts)
      const targetPos = Array.isArray(payload.position)
        ? payload.position.slice()
        : beforePos;
      const targetRot = Array.isArray(payload.rotation)
        ? payload.rotation.slice()
        : beforeRot;
      const targetScl = Array.isArray(payload.scale)
        ? payload.scale.slice()
        : beforeScl;

      // Check if this should animate (AI/GPT-originated)
      const shouldAnimateTransform =
        Boolean(payload.onBehalfOf) ||
        Boolean(data.from?.id?.startsWith?.('api-'));

      // Apply non-transform updates immediately
      if (typeof payload.name === 'string') applyObjectName(obj, payload.name);
      if (typeof payload.visible === 'boolean') applyObjectVisibility(obj, payload.visible);
      if (payload.asset) {
        const newAssetType = payload.asset.type;
        if (newAssetType === 'image' || newAssetType === 'video' || newAssetType === 'text') {
          // Full re-render for content type changes (image/video/text)
          const beforeSnapshot = createContentReplaceSnapshot(obj, payload.objectId);
          const hasPayloadMetadata = Object.prototype.hasOwnProperty.call(payload, 'metadata');
          const mergedInfo = {
            objectId: payload.objectId,
            name: typeof payload.name === 'string' ? payload.name : (obj.userData?.name || payload.objectId),
            position: Array.isArray(payload.position) ? payload.position : obj.position.toArray(),
            rotation: Array.isArray(payload.rotation) ? payload.rotation : obj.quaternion.toArray(),
            scale: Array.isArray(payload.scale) ? payload.scale : obj.scale.toArray(),
            asset: payload.asset,
            metadata: hasPayloadMetadata
              ? cloneJsonSafe(payload.metadata)
              : obj.userData?.metadata,
          };
          addOrUpdateObject(payload.objectId, mergedInfo);

          if (shouldTrackHistory && isOnBehalfOf && beforeSnapshot) {
            const afterSnapshot = {
              objectId: payload.objectId,
              name: mergedInfo.name,
              position: mergedInfo.position,
              rotation: mergedInfo.rotation,
              scale: mergedInfo.scale,
              visible: mergedInfo.visible ?? true,
              asset: cloneJsonSafe(mergedInfo.asset),
              metadata: cloneJsonSafe(mergedInfo.metadata || null),
            };

            presenceState.historyManager?.push(
              HistoryManager.createContentReplaceEntry(
                payload.objectId,
                mergedInfo.name || payload.objectId,
                beforeSnapshot,
                afterSnapshot
              )
            );
          }

          notifySceneStateChanged('scene-delta-content-replace');
          break;
        }
        applyAssetDelta(obj, payload.asset);
      }
      if (payload.animation && typeof payload.animation === 'object') {
        applyObjectAnimationDelta(obj, payload.animation);
        console.debug('[scene-delta] animation applied', {
          objectId: payload.objectId,
          animation: payload.animation,
        });
      }

      // Handle transform updates (animated or immediate)
      if (shouldAnimateTransform && (
        Array.isArray(payload.position) ||
        Array.isArray(payload.rotation) ||
        Array.isArray(payload.scale)
      )) {
        const batchIndex = Number.isInteger(data.__batchIndex)
          ? data.__batchIndex
          : 0;
        animateObjectTransform(payload.objectId, obj, payload, {
          delay: batchIndex * AI_TRANSFORM_TWEEN_STAGGER_MS,
        });
        console.debug('[scene-delta] transform tween queued', {
          objectId: payload.objectId,
          targetPosition: payload.position || null,
          targetRotation: payload.rotation || null,
          targetScale: payload.scale || null,
        });
      } else {
        // Immediate application for non-AI updates
        if (payload.position) obj.position.fromArray(payload.position);
        if (payload.rotation) obj.quaternion.fromArray(payload.rotation);
        if (payload.scale) obj.scale.fromArray(payload.scale);
        console.debug('[scene-delta] applied', {
          objectId: payload.objectId,
          position: obj.position.toArray(),
          rotation: obj.quaternion.toArray(),
          scale: obj.scale.toArray(),
        });
      }

      if (shouldTrackHistory && isOnBehalfOf) {
        // Use target values for history (even when animated)
        const historyEntry = HistoryManager.createDeltaEntry(
          payload.objectId,
          obj.userData?.name || payload.objectId,
          beforePos,
          beforeRot,
          beforeScl,
          targetPos,
          targetRot,
          targetScl
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
      deleteObjectById(objectId, {
        broadcastDelete: false,
        pushHistory: false,
        notifyScene: false,
        ignoreLock: true,
      });
      // Loom object graph をクリーンアップ
      loomIntegration.clearObjectGraph(objectId);
      notifySceneStateChanged('scene-remove-handoff');
      updateEnvironmentMenuSkyboxControls();
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
        if (payload.asset) {
          model.userData.asset = structuredClone(payload.asset);
        }

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
        registerLoadedGlbAnimation(payload.objectId, model, 'scene-mesh');
        notifySceneStateChanged('scene-mesh-loaded');
      }, payload.asset).catch((err) => {
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
    case 'scene-bgm': {
      if (payload.bgm === null) {
        disposeSceneBgm();
      } else if (payload.bgm) {
        applySceneBgm(payload.bgm);
      }
      notifySceneStateChanged('scene-bgm-handoff');
      break;
    }
    case 'scene-avatar': {
      remoteAvatarManager.handleAvatarMessage(payload);
      break;
    }
    case 'scene-batch': {
      const batchOps = payload.ops ?? payload.actions;
      if (!Array.isArray(batchOps)) {
        console.warn('[scene-batch] invalid ops', payload);
        notifySceneStateChanged('scene-batch-handoff');
        break;
      }
      console.debug('[scene-batch] incoming', {
        opCount: batchOps.length,
        onBehalfOf: payload.onBehalfOf || null,
      });
      // TODO: refactor to apply all ops then notify/save once to avoid per-op overhead
      for (const [index, op] of batchOps.entries()) {
        if (!op || typeof op !== 'object') {
          console.warn('[scene-batch] skipped invalid op', { index, op });
          continue;
        }
        if (op.kind === 'scene-batch') {
          console.warn('[scene-batch] nested scene-batch is not supported', { index, op });
          continue;
        }
        if (!op.kind) {
          console.warn('[scene-batch] skipped unsupported op', op);
          continue;
        }
        const child = !op.onBehalfOf && payload.onBehalfOf
          ? { ...op, onBehalfOf: payload.onBehalfOf }
          : op;
        console.debug('[scene-batch] applying child op', {
          index,
          kind: child.kind || null,
          objectId: child.objectId || null,
          hasPosition: Array.isArray(child.position),
          hasRotation: Array.isArray(child.rotation),
          hasScale: Array.isArray(child.scale),
          onBehalfOf: child.onBehalfOf || null,
        });
        handleHandoff({ ...data, payload: child, __batchIndex: index });
      }
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
    let payload = null;
    try { payload = await res.json(); } catch {}
    throw new Error(payload?.message || 'ファイルの読み込みに失敗しました。');
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
  setupObjectGlbAnimation(objectId, model);
  selectManagedObject(model);
  notifySceneStateChanged('glb-uploaded-from-url');

  // 変換後 ArrayBuffer を優先（upload / broadcast / cache すべてに変換後を使う）
  const arrayBuffer = model.userData.normalizedGlbArrayBuffer
    ? model.userData.normalizedGlbArrayBuffer
    : await blob.arrayBuffer();

  // 正規化の結果をトーストで通知
  const metadata = model.userData?.scenesync?.glbMetadata;
  if (metadata?.normalized) {
    showToast('Sketchfab形式のマテリアルをScene Sync向けに変換しました');
  } else if (metadata?.normalizationSkipped) {
    showToast('このモデルはScene Syncで正しく表示できない可能性があるマテリアルを使用しています');
  }

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

function readVector3Array(value, fallback) {
  return Array.isArray(value) && value.length === 3 ? value : fallback;
}

function readQuaternionArray(value, fallback) {
  return Array.isArray(value) && value.length === 4 ? value : fallback;
}

function createSceneUrlImportContext(options = {}) {
  const {
    positionArray = [0, 1, 0],
    placementRotation = null,
    placementQuaternion = null,
    surfaceKind = null,
    normalArray = null,
    rawNormalArray = null,
    wallSurfaceOffset = 0,
    placementPosition = null,
    targetKind = 'scene',
    sourceContext = {},
    generateObjectIdOverride = null,
    nameOverride = null,
    rotationOverride = null,
    scaleOverride = null,
    extraImporterContext = {},
  } = options;

  const position = positionArray;
  const rotation = rotationOverride || [0, 0, 0, 1];
  const scale = scaleOverride || [1, 1, 1];

  return {
    addOrUpdateObject,
    broadcastSceneAdd: broadcast,
    applySceneBgm,
    broadcastSceneBgm: broadcast,
    showToast,
    generateObjectId: generateObjectIdOverride || ((prefix) => generateObjectId(prefix)),
    getSpawnTransform: () => ({
      position,
      rotation,
      scale,
    }),
    nameOverride,
    position,
    placementRotation,
    placementQuaternion,
    surfaceKind,
    normalArray,
    rawNormalArray,
    wallSurfaceOffset,
    placementPosition,
    textImporter: (text, filename, importerContext = {}) =>
      textImporterCallback(text, { toArray: () => position }, filename, {
        ...sourceContext,
        ...extraImporterContext,
        ...importerContext,
      }),
    THREE,
    GLTFLoader,
    targetKind,
    replaceSkyboxSphereFromBlob,
    /**
     * Spec/Gloss変換後GLBをpresence blobへアップロードしてasset cacheへも記録する。
     * URL import時に normalization.changed === true の場合に使う。
     * @param {ArrayBuffer} arrayBuffer - 変換後GLB
     * @param {string} name - 表示名
     * @returns {Promise<{ meshPath: string, assetId: string|null, size: number }>}
     */
    uploadGlbAsset: async (arrayBuffer, name) => {
      const uploadBlob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
      const meshPath = generateRandomPath();
      let assetId = null;

      try {
        assetId = await computeAssetId(arrayBuffer);
        await assetCache.putAsset({
          assetId,
          meshPath: null,
          blob: uploadBlob,
          source: 'url-normalized',
        });
      } catch {}

      const uploadRes = await fetch(`${BLOB_BASE}/${meshPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'model/gltf-binary' },
        body: arrayBuffer,
      });

      if (!uploadRes.ok) {
        let errPayload = null;
        try { errPayload = await uploadRes.json(); } catch {}
        throw new Error(errPayload?.message || `Upload failed: ${uploadRes.status}`);
      }

      if (assetId) {
        try { await assetCache.rememberMeshPathAlias(assetId, meshPath); } catch {}
      }

      return { meshPath, assetId, size: arrayBuffer.byteLength };
    },
    commitSceneAdd: (payload, options = {}) => {
      broadcast(payload);
      addOrUpdateObject(payload.objectId, payload, options);

      if (options.pushHistory !== false) {
        presenceState.historyManager?.push(
          HistoryManager.createSceneAddEntry(payload)
        );
      }
    },
  };
}

function createAiUrlImportContext(params = {}, context = {}) {
  const position = readVector3Array(params.position, [0, 0, 0]);
  const rotation = readQuaternionArray(params.rotation, [0, 0, 0, 1]);
  const scale = readVector3Array(params.scale, [1, 1, 1]);
  let customObjectIdUsed = false;

  return createSceneUrlImportContext({
    positionArray: position,
    placementRotation: Array.isArray(context.placementRotation) ? context.placementRotation : null,
    placementQuaternion: context.placementQuaternion || null,
    surfaceKind: context.surfaceKind || null,
    normalArray: context.normalArray || null,
    rawNormalArray: context.rawNormalArray || null,
    wallSurfaceOffset: context.wallSurfaceOffset ?? 0,
    placementPosition: context.placementPosition || null,
    targetKind: context?.targetKind || 'scene',
    sourceContext: context,
    generateObjectIdOverride: (prefix) => {
      if (!customObjectIdUsed && typeof params.objectId === 'string' && params.objectId.trim()) {
        customObjectIdUsed = true;
        return params.objectId.trim();
      }
      return generateObjectId(prefix);
    },
    nameOverride: (typeof params.name === 'string' && params.name.trim()) ? params.name.trim() : null,
    rotationOverride: rotation,
    scaleOverride: scale,
    extraImporterContext: {
      objectId: params.objectId,
      name: params.name,
      rotation,
      scale,
    },
  });
}

function assertAiUrlKind(url, allowedKinds, action) {
  const classified = classifyUrl(url);
  if (!allowedKinds.includes(classified.kind)) {
    throw new Error(`${action} requires a supported ${allowedKinds.join('/')} URL`);
  }
  return classified.url;
}

async function runAiUrlImport(action, params = {}, context = {}) {
  if (typeof params?.url !== 'string' || !params.url.trim()) {
    throw new Error(`${action} requires params.url`);
  }

  const normalizedUrl = assertAiUrlKind(params.url, context.allowedKinds || [], action);
  const importerContext = createAiUrlImportContext(params, context);
  const imported = await dispatchUrlImport(normalizedUrl, importerContext);

  return {
    ok: true,
    action,
    url: normalizedUrl,
    ...(imported || {}),
  };
}

function serializeSceneObjectForExternalUse(objectId, obj) {
  if (!obj) return null;

  if (obj.userData?.nonSerializable) return null;
  if (obj.userData?._temporary) return null;
  if (obj.userData?.role === 'multi-transform-pivot') return null;
  if (obj.userData?.role === 'paste-preview') return null;
  if (obj.userData?.role === 'placement-floor') return null;

  const result = {
    objectId,
    name: obj.userData?.name || obj.name || objectId,
    position: obj.position.toArray(),
    rotation: obj.quaternion.toArray(),
    scale: obj.scale.toArray(),
    asset: obj.userData?.asset || null,
    metadata: obj.userData?.metadata || null,
    meshPath: obj.userData?.meshPath || obj.userData?.asset?.meshPath || null,
  };

  const animation = serializeObjectAnimationState(obj);
  if (animation) {
    result.animation = animation;
  }

  const animationClips = serializeObjectAnimationClipSummariesForExternalUse(obj);
  if (animationClips.length > 0) {
    result.animationClips = animationClips;
  }

  return result;
}

function getCurrentSelectionPayload() {
  const selectedIds = Array.from(selectedObjectIds || []);
  const selectedObjects = [];
  const missingObjectIds = [];
  const skippedObjectIds = [];

  for (const objectId of selectedIds) {
    const obj = managedObjects.get(objectId);

    if (!obj) {
      missingObjectIds.push(objectId);
      continue;
    }

    const serialized = serializeSceneObjectForExternalUse(objectId, obj);

    if (!serialized) {
      skippedObjectIds.push(objectId);
      continue;
    }

    selectedObjects.push(serialized);
  }

  return {
    selectedObjectIds: selectedObjects.map((obj) => obj.objectId),
    selectedObjects,
    selectedCount: selectedObjects.length,
    missingObjectIds,
    skippedObjectIds,
  };
}

function resolveAiCommandObjectId(params = {}) {
  const explicit = typeof params.objectId === 'string' ? params.objectId.trim() : '';
  if (explicit) return explicit;

  if (!(selectedObjectIds instanceof Set) || selectedObjectIds.size !== 1) {
    return '';
  }

  const [selected] = Array.from(selectedObjectIds);
  return typeof selected === 'string' ? selected : '';
}

function setObjectAnimationClipByAiCommand(params = {}) {
  const objectId = resolveAiCommandObjectId(params);

  if (!objectId) {
    return {
      ok: false,
      error: 'objectId is required unless exactly one object is selected',
    };
  }

  const obj = managedObjects.get(objectId);
  if (!obj) {
    return {
      ok: false,
      error: `object not found: ${objectId}`,
    };
  }

  const resolution = resolveAnimationClipIndex(obj, params);
  if (!resolution.ok) {
    return {
      ok: false,
      error: resolution.error,
      candidates: resolution.candidates,
      clips: Array.isArray(resolution.clips)
        ? resolution.clips.map((clip, index) => {
            if (clip && typeof clip.index === 'number') return clip;
            return {
              index,
              name: clip?.name || `Animation ${index}`,
              duration: Number.isFinite(clip?.duration) ? clip.duration : null,
            };
          })
        : undefined,
    };
  }

  const current =
    obj.userData?.animationState ||
    obj.userData?.scenesync?.animationState ||
    {};

  const delta = {
    enabled: typeof params.enabled === 'boolean' ? params.enabled : true,
    clip: resolution.clipIndex,
    clipName: resolution.clipName,
    mode: params.mode === 'once' ? 'once' : 'loop',
  };

  if (params.speed !== undefined) {
    const speed = Number(params.speed);
    if (Number.isFinite(speed) && speed >= 0) {
      delta.speed = speed;
    }
  } else if (Number.isFinite(current.speed)) {
    delta.speed = current.speed;
  } else {
    delta.speed = 1;
  }

  const operation = {
    kind: 'scene-delta',
    objectId,
    animation: delta,
  };

  applyOperationToScene(operation);
  broadcast(operation);
  notifySceneStateChanged('ai-animation-clip-updated');
  notifySelectionChanged('ai-animation-clip-updated');

  return {
    ok: true,
    objectId,
    animation: {
      ...delta,
      clip: resolution.clipIndex,
      clipName: resolution.clipName,
    },
    matchedBy: resolution.matchedBy,
    availableClips: serializeObjectAnimationClipSummariesForExternalUse(obj),
  };
}

// ── AI Command: Media/Text Replace ───────────────────────────────────

function resolveReplaceTargetObjectId({ objectId, inputKind }) {
  if (objectId) {
    const target = managedObjects.get(objectId);
    if (!target) {
      throw new Error(`Object not found: ${objectId}`);
    }
    if (!canReplaceContent(target, inputKind)) {
      throw new Error(`Target object does not accept ${inputKind} content.`);
    }
    return objectId;
  }

  const selectedObjects = getSelectedObjects();
  if (selectedObjects.length === 0) {
    throw new Error('No target object. Select one replaceable object or provide objectId.');
  }
  if (selectedObjects.length > 1) {
    throw new Error('Select exactly one replaceable object.');
  }

  const selected = selectedObjects[0];
  if (!canReplaceContent(selected, inputKind)) {
    throw new Error(`Selected object does not accept ${inputKind} content.`);
  }

  return selected.userData.objectId;
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
      case 'addImageFromUrl':
        result = await runAiUrlImport(payload.action, payload.params, {
          allowedKinds: [URL_KIND.IMAGE],
        });
        break;
      case 'addVideoFromUrl':
        result = await runAiUrlImport(payload.action, payload.params, {
          allowedKinds: [URL_KIND.VIDEO, URL_KIND.VIDEO_HLS],
        });
        break;
      case 'addTextFromUrl':
        result = await runAiUrlImport(payload.action, payload.params, {
          allowedKinds: [URL_KIND.TEXT],
        });
        break;
      case 'setSkyboxFromImageUrl':
        result = await runAiUrlImport(payload.action, payload.params, {
          allowedKinds: [URL_KIND.IMAGE],
          targetKind: 'sky',
        });
        break;
      case 'getSelection':
        result = {
          ok: true,
          action: 'getSelection',
          ...getCurrentSelectionPayload(),
        };
        break;
      case 'setAnimationClip':
        result = setObjectAnimationClipByAiCommand(payload.params || {});
        break;
      case 'replaceMediaFromUrl': {
        const params = payload.params || {};
        const { url, mediaType, name } = params;

        if (!url) {
          result = { ok: false, error: 'url is required.' };
          break;
        }
        if (!mediaType || !['image', 'video'].includes(mediaType)) {
          result = { ok: false, error: 'mediaType must be "image" or "video".' };
          break;
        }

        try {
          const targetObjectId = resolveReplaceTargetObjectId({ objectId: params.objectId, inputKind: mediaType });
          await replaceObjectContent(targetObjectId, {
            kind: mediaType,
            source: 'url',
            url,
            name,
          });

          const targetObj = managedObjects.get(targetObjectId);
          result = {
            ok: true,
            action: 'replaceMediaFromUrl',
            objectId: targetObjectId,
            assetType: mediaType,
            url,
            ...(name ? { name } : {}),
          };
        } catch (e) {
          result = { ok: false, error: e.message };
        }
        break;
      }
      case 'replaceTextContent': {
        const params = payload.params || {};
        const { text, objectId } = params;

        if (text === undefined || text === null) {
          result = { ok: false, error: 'text is required.' };
          break;
        }

        try {
          const targetObjectId = resolveReplaceTargetObjectId({ objectId, inputKind: 'text' });
          await replaceObjectContent(targetObjectId, {
            kind: 'text',
            source: 'inline',
            text: String(text),
            fontFamily: params.fontFamily,
            fontSize: params.fontSize,
            fontWeight: params.fontWeight,
            fontStyle: params.fontStyle,
            color: params.color,
            backgroundColor: params.backgroundColor,
            align: params.align,
            name: params.name,
          });

          const targetObj = managedObjects.get(targetObjectId);
          const asset = targetObj?.userData?.asset || {};
          result = {
            ok: true,
            action: 'replaceTextContent',
            objectId: targetObjectId,
            assetType: 'text',
            textLength: String(text).length,
            ...(params.name ? { name: params.name } : {}),
          };
        } catch (e) {
          result = { ok: false, error: e.message };
        }
        break;
      }
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

function normalizeSceneAsset(asset, payload = {}) {
  const meshPath = payload.meshPath || asset?.meshPath;

  if (meshPath && (asset?.type === 'gltf' || asset?.type === 'glb')) {
    return {
      ...asset,
      type: 'mesh',
      source: asset.source || 'carrier',
      meshPath,
      mime: asset.mime || 'model/gltf-binary',
    };
  }

  if (!asset && meshPath) {
    return {
      type: 'mesh',
      source: 'carrier',
      meshPath,
      assetId: payload.assetId || null,
      mime: 'model/gltf-binary',
    };
  }

  return asset;
}

function cleanupPreviewForLoadedObject(options = {}) {
  if (options.previewObjectId) {
    removeTemporaryImagePreview(options.previewObjectId);
    removeLoadingOverlay(options.previewObjectId);
  }

  if (options.localReplacementObjectId) {
    clearLocalImageReplacementPreview(
      options.localReplacementObjectId,
      options.localReplacementPreviewToken || null
    );
  }
}

function addOrUpdateObject(objectId, info, options = {}) {
  removedObjectIds.delete(objectId);
  const existing = managedObjects.get(objectId);
  let asset = info.asset;
  asset = normalizeSceneAsset(asset, info);

  if (asset) {
    switch (asset.type) {
      case 'primitive':
        replaceManagedObject(objectId, buildPrimitiveObject(objectId, info, asset), info);
        return;
      case 'mesh':
        if (asset.source === 'url' && asset.url) {
          loadMeshObjectFromUrl(objectId, info, asset.url, existing, options.prebuiltGlbModel);
          return;
        }
        if (asset.meshPath) {
          loadMeshObject(objectId, info, asset.meshPath, existing, options);
          return;
        }
        break;
      case 'video':
        if (asset.url) {
          loadVideoObject(objectId, info, asset.url, existing, options.prebuiltVideoBundle, options);
          return;
        }
        break;
      case 'image':
        if (asset.url) {
          loadImageObject(objectId, info, asset.url, existing, options.prebuiltImageBundle, options);
          return;
        }
        break;
      case 'text':
        loadTextObject(objectId, info, asset, existing);
        return;
      default:
        console.warn(`unsupported asset type: ${asset.type}`);
        replaceManagedObject(objectId, buildUnsupportedAssetObject(objectId, info), info);
        return;
    }
  }

  if (info.meshPath) {
    loadMeshObject(objectId, info, info.meshPath, existing, options);
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

function loadMeshObject(objectId, info, meshPath, existing, options = {}) {
  removeFailedOverlay(objectId);
  removeRecoveringOverlay(objectId);
  addLoadingOverlay(objectId, info.name || objectId, info);
  const url = BLOB_BASE + '/' + meshPath;
  const skipFallbackOnFailure = options.skipFallbackOnFailure === true;
  const suppressSnapshotSaveOnFailure = options.suppressSnapshotSaveOnFailure === true;
  const initialPosition = info.position
    ? new THREE.Vector3().fromArray(info.position)
    : undefined;

  console.log('[SceneSync] load mesh', { objectId, meshPath });
  console.debug('[scene-glb-load] visualBasis input', {
    objectId,
    meshPath,
    visualBasis: info.asset?.visualBasis,
  });

  if (isGlbLoadDisabled()) {
    console.warn('[SceneSync] GLB load disabled by diagnostic flag, creating diagnostic placeholder');
    removeLoadingOverlay(objectId);
    const placeholder = buildGlbDiagnosticPlaceholder(objectId, info);
    applySceneTransform(placeholder, info);
    if (existing) {
      placeholder.position.copy(existing.position);
      placeholder.quaternion.copy(existing.quaternion);
      placeholder.scale.copy(existing.scale);
      if (transformCtrl.object === existing) transformCtrl.detach();
      scene.remove(existing);
    }
    scene.add(placeholder);
    replaceManagedObject(objectId, placeholder, info);
    cleanupPreviewForLoadedObject(options);
    return;
  }

  (async () => {
    try {
      const incomingAssetId = info.asset?.assetId || info.assetId || null;
      let cachedRecord = null;

      try {
        const cachedByAssetId = incomingAssetId
          ? await assetCache.getByAssetId(incomingAssetId)
          : null;
        const cachedByMeshPath = !cachedByAssetId && meshPath
          ? await assetCache.getByMeshPath(meshPath)
          : null;

        cachedRecord = cachedByAssetId || cachedByMeshPath || null;

        if (cachedRecord?.blob) {
          console.debug('[asset-cache] hit for scene-add mesh', {
            objectId,
            assetId: cachedRecord.assetId || incomingAssetId || null,
            meshPath: cachedRecord.meshPath || meshPath,
            source: cachedByAssetId ? 'indexeddb-asset-id' : 'indexeddb-mesh-path',
          });
          await loadGlbBlobForObject(objectId, cachedRecord.blob, {
            info,
            existing,
            meshPath,
            assetId: cachedRecord.assetId || incomingAssetId || null,
          });
          removeLoadingOverlay(objectId);
          cleanupPreviewForLoadedObject(options);
          return;
        }
      } catch (cacheErr) {
        console.warn('[asset-cache] lookup failed, falling back to network fetch:', cacheErr);
      }

      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 404) {
          console.warn('[SceneSync] Mesh blob expired (404):', meshPath);
          removeLoadingOverlay(objectId);

          const assetId = incomingAssetId;
          const expectedSize = null;
          let cachedBeforeRecovery = null;

          try {
            cachedBeforeRecovery = assetId
              ? await assetCache.getByAssetId(assetId)
              : await assetCache.getByMeshPath(meshPath);
          } catch (cacheErr) {
            console.warn('[asset-cache] recovery pre-check failed:', cacheErr);
          }

          if (cachedBeforeRecovery?.blob) {
            await loadGlbBlobForObject(objectId, cachedBeforeRecovery.blob, {
              info,
              existing,
              meshPath,
              assetId: cachedBeforeRecovery.assetId || assetId || null,
            });
            cleanupPreviewForLoadedObject(options);
            return;
          }

          addRecoveringOverlay(objectId, info);
          await expiredGlbRecovery.handleMissingGlb(
            objectId,
            meshPath,
            expectedSize,
            assetId,
            info
          );
          cleanupPreviewForLoadedObject(options);

          return;
        }
        throw new Error(`HTTP ${response.status} loading mesh`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      let loadCompleted = false;

      markCrashProbe('glb-load-start', {
        objectId,
        meshPath,
        sizeBytes: blob.size,
        source: 'network',
      });

      glbLoader.loadFromUrl(objectUrl, initialPosition, scene, async (model) => {
        try {
          markCrashProbe('glb-load-success', {
            objectId,
            meshPath,
          });
          markCrashProbe('glb-scene-attach-start', { objectId });

          removeLoadingOverlay(objectId);
          removeFailedOverlay(objectId);
          model.userData.objectId = objectId;
          model.userData.name = info.name;
          model.userData.meshPath = meshPath;
          model.userData.asset = cloneJsonSafe(info.asset || null);

          console.debug('[scene-glb-load] GLB loaded for mesh path', {
            objectId,
            meshPath,
            visualBasis: info.asset?.visualBasis,
          });

          if (info.runtime) {
            model.userData.runtime = {
              ...(model.userData.runtime || {}),
              ...info.runtime,
              startLocalTime: performance.now(),
            };
          }

          if (info.animation) {
            model.userData.animationState = {
              ...(model.userData.animationState || {}),
              ...info.animation,
            };

            model.userData.scenesync = {
              ...model.userData.scenesync,
              animationState: model.userData.animationState,
            };
          }

          if (existing) {
            model.position.copy(existing.position);
            model.quaternion.copy(existing.quaternion);
            model.scale.copy(existing.scale);
            if (transformCtrl.object === existing) transformCtrl.detach();
            scene.remove(existing);
          }

          if (removedObjectIds.has(objectId)) {
            cleanupPreviewForLoadedObject(options);
            return;
          }

          replaceManagedObject(objectId, model, info);
          cleanupPreviewForLoadedObject(options);

          try {
            let assetId = incomingAssetId;
            if (!assetId) {
              assetId = await computeAssetId(blob);
            }
            model.userData.assetId = assetId;

            await assetCache.putAsset({
              assetId,
              meshPath,
              blob,
              source: 'carrier',
            });
            console.log('[SceneSync] Cached mesh:', { objectId, assetId, meshPath });

            if (!info.asset?.assetId) {
              await assetCache.rememberMeshPathAlias(assetId, meshPath);
            }
          } catch (cacheErr) {
            console.warn('[SceneSync] Failed to cache mesh:', cacheErr);
          }

          markCrashProbe('glb-scene-attach-success', { objectId });
          clearCrashProbe('glb-object-ready');
        } finally {
          loadCompleted = true;
          URL.revokeObjectURL(objectUrl);
        }
      }, info.asset).catch((err) => {
        removeLoadingOverlay(objectId);
        console.warn('Failed to load mesh for', objectId, ':', err);
        if (removedObjectIds.has(objectId)) {
          cleanupPreviewForLoadedObject(options);
          loadCompleted = true;
          URL.revokeObjectURL(objectUrl);
          return;
        }
        if (!existing && !skipFallbackOnFailure) {
          replaceManagedObject(objectId, buildDefaultBoxObject(objectId, info, 0xff4444), info);
        } else if (!suppressSnapshotSaveOnFailure) {
          notifySceneStateChanged('mesh-load-failed');
        }
        cleanupPreviewForLoadedObject(options);
        loadCompleted = true;
        URL.revokeObjectURL(objectUrl);
      });
    } catch (err) {
      removeLoadingOverlay(objectId);
      console.warn('Failed to fetch mesh for', objectId, ':', err);
      if (removedObjectIds.has(objectId)) {
        cleanupPreviewForLoadedObject(options);
        return;
      }
      if (!existing && !skipFallbackOnFailure) {
        replaceManagedObject(objectId, buildDefaultBoxObject(objectId, info, 0xff4444), info);
      } else if (!suppressSnapshotSaveOnFailure) {
        notifySceneStateChanged('mesh-load-failed');
      }
      cleanupPreviewForLoadedObject(options);
    }
  })();
}

function loadVideoObject(objectId, info, videoUrl, existing, prebuilt = null, options = {}) {
  addLoadingOverlay(objectId, info.name || objectId, info);
  const promise = prebuilt
    ? Promise.resolve(prebuilt)
    : loadVideoTextureFromUrl(videoUrl, { THREE });

  promise.then((bundle) => {
    removeLoadingOverlay(objectId);
    const { group, material, texture } = createVideoPlaneGroup(bundle, THREE);
    group.userData.objectId = objectId;
    group.userData.name = info.name;
    group.userData.video = bundle.video;
    group.userData.assetType = 'video';
    if (info.asset) group.userData.asset = structuredClone(info.asset);

    group.userData.disposable = () => {
      bundle.video?.pause?.();
      bundle.video && (bundle.video.src = '');
      texture.dispose();
      material.dispose();
    };

    if (existing) {
      group.position.copy(existing.position);
      group.quaternion.copy(existing.quaternion);
      group.scale.copy(existing.scale);
      if (transformCtrl.object === existing) transformCtrl.detach();
      scene.remove(existing);
    }

    if (removedObjectIds.has(objectId)) {
      group.userData?.disposable?.();
      cleanupPreviewForLoadedObject(options);
      return;
    }

    replaceManagedObject(objectId, group, info);
    cleanupPreviewForLoadedObject(options);
  }).catch((err) => {
    removeLoadingOverlay(objectId);
    console.warn('Failed to load video for', objectId, ':', err);
    if (removedObjectIds.has(objectId)) {
      cleanupPreviewForLoadedObject(options);
      return;
    }
    if (!existing) {
      const failedInfo = { ...info, name: `${info.name || objectId} (動画読み込み失敗)` };
      replaceManagedObject(objectId, buildDefaultBoxObject(objectId, failedInfo, 0xff4444), failedInfo);
      cleanupPreviewForLoadedObject(options);
      return;
    }
    cleanupPreviewForLoadedObject(options);
    notifySceneStateChanged('video-load-failed');
  });
}

function loadImageObject(objectId, info, imageUrl, existing, prebuilt = null, options = {}) {
  addLoadingOverlay(objectId, info.name || objectId, info);

  const promise = prebuilt
    ? Promise.resolve(prebuilt)
    : (async () => {
        const { loadImageTextureFromUrl, planeSizeFromAspect } = await import('./loaders/url-importers/image.js');
        const bundle = await loadImageTextureFromUrl(imageUrl, { THREE });
        const { width, height } = planeSizeFromAspect(bundle.aspect);
        return { ...bundle, width, height };
      })();

  promise.then((bundle) => {
    removeLoadingOverlay(objectId);
    const { texture, width, height } = bundle;

    const geometry = new THREE.PlaneGeometry(width, height);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.01,
      depthWrite: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = height / 2;

    const group = new THREE.Group();
    group.add(mesh);

    group.userData.objectId = objectId;
    group.userData.name = info.name;
    group.userData.assetType = 'image';
    if (info.asset) group.userData.asset = structuredClone(info.asset);

    // Store for disposal
    group.userData.disposable = () => {
      texture.dispose();
      geometry.dispose();
      material.dispose();
    };

    if (existing) {
      group.position.copy(existing.position);
      group.quaternion.copy(existing.quaternion);
      group.scale.copy(existing.scale);
      if (transformCtrl.object === existing) transformCtrl.detach();
      scene.remove(existing);
    }

    if (removedObjectIds.has(objectId)) {
      group.userData?.disposable?.();
      cleanupPreviewForLoadedObject(options);
      return;
    }

    replaceManagedObject(objectId, group, info);
    cleanupPreviewForLoadedObject(options);
  }).catch((err) => {
    removeLoadingOverlay(objectId);
    console.warn('Failed to load image for', objectId, ':', err);
    if (removedObjectIds.has(objectId)) {
      cleanupPreviewForLoadedObject(options);
      return;
    }
    showToast({
      type: 'error',
      message: `画像の読み込みに失敗しました: ${err?.message || 'CORS エラーの可能性'}`,
    });
    const failedInfo = { ...info, name: `${info.name || objectId} (load failed)` };
    replaceManagedObject(objectId, buildDefaultBoxObject(objectId, failedInfo, 0xcc3333), failedInfo);
    cleanupPreviewForLoadedObject(options);
    notifySceneStateChanged('image-load-failed');
  });
}

// ── Text Panel v2 Scroll State ────────────────────────────────────
// Local scroll state (not synced to other clients)
const textPanelScrollState = new Map();
let textPanelTouchCandidate = null;
let textPanelScrollActive = false;
const SCROLL_DRAG_THRESHOLD_PX = 8;

function findTextPanelRoot(object) {
  let current = object;
  while (current) {
    if (current.userData?.role === 'text-panel') return current;
    current = current.parent;
  }
  return null;
}

function canScrollTextPanel(textPanel) {
  const metrics = textPanel?.userData?.textPanelMetrics;
  return metrics && metrics.maxScrollY > 0;
}

function loadTextObject(objectId, info, asset, existing) {
  const normalizedAsset = normalizeTextAsset(asset, info);

  const textPromise = (normalizedAsset.source === 'url' && normalizedAsset.url)
    ? fetch(normalizedAsset.url, { mode: 'cors' }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
    : Promise.resolve(normalizedAsset.text || '');

  textPromise.then((resolvedText) => {
    const renderAsset = {
      ...normalizedAsset,
      text: resolvedText,
      scroll: {
        ...normalizedAsset.scroll,
        y: textPanelScrollState.get(objectId) ?? normalizedAsset.scroll?.y ?? 0,
      },
    };

    const result = renderTextPanelCanvas(renderAsset, { pixelsPerUnit: 512 });
    const canvas = result.canvas;
    const metrics = result.metrics;

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;

    const layout = normalizedAsset.layout || DEFAULT_TEXT_LAYOUT;
    const panelWidth = layout.width;
    const panelHeight = layout.height;

    const geometry = new THREE.PlaneGeometry(panelWidth, panelHeight);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = panelHeight / 2;

    const group = new THREE.Group();
    group.add(mesh);

    group.userData.objectId = objectId;
    group.userData.name = info.name;
    group.userData.assetType = 'text';
    group.userData.role = 'text-panel';
    group.userData.asset = structuredClone(normalizedAsset);
    group.userData.textPanelMetrics = metrics;
    group.userData.resolvedText = resolvedText;
    group.userData.dropRaycastTarget = true;

    group.userData.disposable = () => {
      texture.dispose();
      geometry.dispose();
      material.dispose();
    };

    if (existing) {
      group.position.copy(existing.position);
      group.quaternion.copy(existing.quaternion);
      group.scale.copy(existing.scale);
      if (transformCtrl.object === existing) transformCtrl.detach();
    }

    if (removedObjectIds.has(objectId)) {
      group.userData?.disposable?.();
      return;
    }

    replaceManagedObject(objectId, group, info);
  }).catch((err) => {
    console.warn('Failed to load text object for', objectId, ':', err);
    if (removedObjectIds.has(objectId)) {
      return;
    }
    const failedInfo = { ...info, name: `${info.name || objectId} (text load failed)` };
    replaceManagedObject(objectId, buildDefaultBoxObject(objectId, failedInfo, 0x996633), failedInfo);
  });
}

function canReplaceContent(object, inputKind) {
  if (!object) return false;

  const assetType = object.userData?.asset?.type || object.userData?.assetType;
  const role = object.userData?.metadata?.role;
  const accepts = object.userData?.metadata?.accepts;

  if (Array.isArray(accepts)) {
    return accepts.includes(inputKind);
  }

  if (role === 'media-panel') {
    return inputKind === 'image' || inputKind === 'video';
  }

  if (assetType === 'image' || assetType === 'video') {
    return inputKind === 'image' || inputKind === 'video';
  }

  if (role === 'text-panel' || assetType === 'text') {
    return inputKind === 'text';
  }

  return false;
}

function getReplaceTarget(inputKind, hitObjectId = null) {
  if (hitObjectId) {
    const hitObj = managedObjects.get(hitObjectId);
    if (canReplaceContent(hitObj, inputKind)) return hitObj;
  }

  const selected = getSelectedObjects();
  if (selected.length === 1 && canReplaceContent(selected[0], inputKind)) {
    return selected[0];
  }

  return null;
}

function findPrimaryMediaMesh(root) {
  let found = null;
  root.traverse((child) => {
    if (found) return;
    if (child.isMesh && child.geometry) {
      found = child;
    }
  });
  return found;
}

async function showLocalImageReplacementPreview(objectId, file) {
  const target = managedObjects.get(objectId);
  if (!target) return null;

  clearLocalImageReplacementPreview(objectId);

  const token = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const objectUrl = URL.createObjectURL(file);

  const baseMesh = findPrimaryMediaMesh(target);
  if (!baseMesh) {
    URL.revokeObjectURL(objectUrl);
    return null;
  }

  let texture;
  try {
    texture = await new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(objectUrl, resolve, undefined, reject);
    });
  } catch (error) {
    console.warn('[image-import] failed to load replacement preview texture:', error);
    URL.revokeObjectURL(objectUrl);
    return null;
  }

  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
  });

  const overlay = new THREE.Mesh(baseMesh.geometry.clone(), material);
  overlay.position.copy(baseMesh.position);
  overlay.rotation.copy(baseMesh.rotation);
  overlay.scale.copy(baseMesh.scale);

  overlay.position.z += 0.002;
  overlay.renderOrder = (baseMesh.renderOrder || 0) + 1;

  overlay.userData.localReplacementPreview = true;
  overlay.userData.ignoreSceneExport = true;

  baseMesh.parent.add(overlay);

  const cleanup = () => {
    if (overlay.parent) overlay.parent.remove(overlay);
    overlay.geometry?.dispose?.();
    overlay.material?.map?.dispose?.();
    overlay.material?.dispose?.();
    URL.revokeObjectURL(objectUrl);
  };

  pendingMediaReplacementPreviews.set(objectId, {
    token,
    objectUrl,
    overlayObject: overlay,
    cleanup,
  });

  return { token, objectUrl };
}

function clearLocalImageReplacementPreview(objectId, token = null) {
  const preview = pendingMediaReplacementPreviews.get(objectId);
  if (!preview) return;

  if (token && preview.token !== token) return;

  try {
    preview.cleanup?.();
  } catch (error) {
    console.warn('[image-import] failed to cleanup local replacement preview:', error);
  }

  pendingMediaReplacementPreviews.delete(objectId);
}

function isCurrentLocalImageReplacementPreview(objectId, token) {
  return pendingMediaReplacementPreviews.get(objectId)?.token === token;
}

function createContentReplaceSnapshot(obj, fallbackObjectId = null) {
  if (!obj) return null;

  const objectId = obj.userData?.objectId || fallbackObjectId;

  return {
    objectId,
    name: obj.userData?.name || obj.name || objectId,
    position: obj.position.toArray(),
    rotation: obj.quaternion.toArray(),
    scale: obj.scale.toArray(),
    visible: obj.visible !== false,
    asset: cloneJsonSafe(obj.userData?.asset || null),
    metadata: cloneJsonSafe(obj.userData?.metadata || null),
  };
}

async function replaceObjectContent(objectId, input, options = {}) {
  const existing = managedObjects.get(objectId);
  if (!existing) return;

  const beforeSnapshot = createContentReplaceSnapshot(existing, objectId);

  const existingMeta = existing.userData?.metadata || {};
  let newAsset;
  let metaRole, metaAccepts, metaFit;

  if (input.kind === 'image' || input.kind === 'video') {
    newAsset = {
      type: input.kind,
      source: input.source || 'url',
      url: input.url,
      ...(input.mime ? { mime: input.mime } : {}),
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      ...(input.assetId ? { assetId: input.assetId } : {}),
    };
    metaRole = existingMeta.role || 'media-panel';
    metaAccepts = existingMeta.accepts || ['image', 'video'];
    metaFit = existingMeta.fit || 'contain';
  } else if (input.kind === 'text') {
    const existingAsset = existing.userData?.asset || {};

    const nextFormat =
      input.format ||
      (input.source === 'url' &&
      typeof input.url === 'string' &&
      /\.(md|markdown)(?:$|[?#])/i.test(input.url)
        ? 'markdown'
        : existingAsset.format || 'plain');

    newAsset = {
      type: 'text',
      source: input.source || existingAsset.source || 'inline',
      ...(input.url ? { url: input.url } : existingAsset.url ? { url: existingAsset.url } : {}),
      ...(input.text !== undefined ? { text: input.text } : existingAsset.text ? { text: existingAsset.text } : {}),
      format: nextFormat,
      fontFamily: input.fontFamily || existingAsset.fontFamily || 'system-sans',
      fontSize: input.fontSize || existingAsset.fontSize || 32,
      fontWeight: input.fontWeight || existingAsset.fontWeight || 'normal',
      fontStyle: input.fontStyle || existingAsset.fontStyle || 'normal',
      color: input.color || existingAsset.color || '#ffffff',
      backgroundColor: input.backgroundColor || existingAsset.backgroundColor || 'rgba(0,0,0,0.65)',
      align: input.align || existingAsset.align || 'left',
      layout: existingAsset.layout || { ...DEFAULT_TEXT_LAYOUT },
      scroll: existingAsset.scroll || { ...DEFAULT_TEXT_SCROLL },
    };
    metaRole = existingMeta.role || 'text-panel';
    metaAccepts = existingMeta.accepts || ['text'];
  } else {
    return;
  }

  const newMetadata = {
    ...existingMeta,
    role: metaRole,
    accepts: metaAccepts,
    ...(metaFit !== undefined ? { fit: metaFit } : {}),
  };

  const nextName =
    typeof input.name === 'string' && input.name.trim()
      ? input.name.trim()
      : existing.userData?.name || objectId;

  const deltaPayload = {
    kind: 'scene-delta',
    objectId,
    ...(input.name ? { name: nextName } : {}),
    asset: newAsset,
    metadata: newMetadata,
  };

  broadcast(deltaPayload);

  const mergedInfo = {
    objectId,
    name: nextName,
    position: existing.position.toArray(),
    rotation: existing.quaternion.toArray(),
    scale: existing.scale.toArray(),
    visible: existing.visible !== false,
    asset: newAsset,
    metadata: newMetadata,
  };
  addOrUpdateObject(objectId, mergedInfo, { ...options, pushHistory: false });

  if (beforeSnapshot && options.pushHistory !== false) {
    const afterSnapshot = {
      objectId,
      name: nextName,
      position: existing.position.toArray(),
      rotation: existing.quaternion.toArray(),
      scale: existing.scale.toArray(),
      visible: existing.visible !== false,
      asset: cloneJsonSafe(newAsset),
      metadata: cloneJsonSafe(newMetadata),
    };

    presenceState.historyManager?.push(
      HistoryManager.createContentReplaceEntry(
        objectId,
        nextName,
        beforeSnapshot,
        afterSnapshot
      )
    );
  }

  showToast(input.kind === 'text' ? 'テキストを差し替えました' : 'メディアを差し替えました');
}

function disposeMaterial(material) {
  if (!material) return;
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value && value.isTexture) {
      value.dispose();
    }
  }
  material.dispose();
}

function loadMeshObjectFromUrl(objectId, info, glbUrl, existing, prebuilt = null) {
  addLoadingOverlay(objectId, info.name || objectId, info);

  const promise = prebuilt
    ? Promise.resolve({ model: prebuilt })
    : (async () => {
        const { loadGlbFromUrl } = await import('./loaders/url-importers/glb.js');
        return await loadGlbFromUrl(glbUrl, { THREE, GLTFLoader });
      })();

  promise.then(({ model }) => {
    removeLoadingOverlay(objectId);
    model.userData.objectId = objectId;
    model.userData.name = info.name;
    model.userData.assetType = 'mesh';
    if (info.asset) model.userData.asset = structuredClone(info.asset);

    // disposable: GLB はテクスチャや material を内包するため scene graph を traverse して dispose
    model.userData.disposable = () => {
      model.traverse((child) => {
        if (child.isMesh) {
          child.geometry?.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => disposeMaterial(m));
          } else if (child.material) {
            disposeMaterial(child.material);
          }
        }
      });
    };

    if (existing) {
      model.position.copy(existing.position);
      model.quaternion.copy(existing.quaternion);
      model.scale.copy(existing.scale);
      if (transformCtrl.object === existing) transformCtrl.detach();
      scene.remove(existing);
    } else {
      // GLB は内部に元のシーン座標を持つため、payload の transform で上書きする
      // (video/image は plane 構築時に position.y を直接設定するためここでは不要)
      applyTransform(model, info);
    }

    replaceManagedObject(objectId, model, info);
  }).catch((err) => {
    removeLoadingOverlay(objectId);
    console.warn('Failed to load GLB URL for', objectId, ':', err);
    showToast({
      type: 'error',
      message: `GLB の読み込みに失敗しました: ${err?.message || 'CORS/サイズ/形式エラーの可能性'}`,
    });
    const failedInfo = { ...info, name: `${info.name || objectId} (load failed)` };
    replaceManagedObject(objectId, buildDefaultBoxObject(objectId, failedInfo, 0xcc3333), failedInfo);
    notifySceneStateChanged('glb-url-load-failed');
  });
}

function replaceManagedObject(objectId, nextObject, info) {
  const current = managedObjects.get(objectId);
  if (current) {
    if (transformCtrl.object === current) transformCtrl.detach();
    // Call disposable if it exists (for textures, geometries, materials)
    if (current.userData?.disposable) {
      current.userData.disposable();
    }
    scene.remove(current);
  }

  console.debug('[scene-add] incoming transform', {
    objectId,
    position: info?.position || null,
    rotation: info?.rotation || info?.quaternion || null,
    scale: info?.scale || null,
    asset: info?.asset || null,
    meshPath: info?.meshPath || null,
  });

  nextObject.userData.objectId = objectId;
  nextObject.userData.metadata = info.metadata;
  applyObjectName(nextObject, info.name);
  applySceneTransform(nextObject, info);
  applyObjectVisibility(nextObject, info.visible);

  if (info.runtime) {
    nextObject.userData.runtime = {
      ...(nextObject.userData.runtime || {}),
      ...info.runtime,
      startLocalTime: performance.now(),
    };
  }

  if (info.animation) {
    nextObject.userData.animationState = {
      ...(nextObject.userData.animationState || {}),
      ...info.animation,
    };

    nextObject.userData.scenesync = {
      ...nextObject.userData.scenesync,
      animationState: nextObject.userData.animationState,
    };
  }

  scene.add(nextObject);
  managedObjects.set(objectId, nextObject);

  setupObjectGlbAnimation(objectId, nextObject);

  console.debug('[scene-add] applied transform', {
    objectId: nextObject.userData?.objectId || null,
    position: nextObject.position.toArray(),
    rotation: nextObject.quaternion.toArray(),
    scale: nextObject.scale.toArray(),
  });
  if (selectedObjectIds.has(objectId)) {
    updateSelectionState({
      reason: 'managed-object-replaced-selection',
      broadcastUnlock: false,
      broadcastLock: false,
    });
  }
  notifySceneStateChanged('managed-object-replaced');
  updateEnvironmentMenuSkyboxControls();
}

function buildDefaultBoxObject(objectId, info, color = 0x4488ff) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color });
  const object = new THREE.Mesh(geometry, material);
  object.userData.objectId = objectId;
  applyObjectName(object, info.name);
  return object;
}

function buildGlbDiagnosticPlaceholder(objectId, info) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0xffaa00 });
  const placeholder = new THREE.Mesh(geometry, material);
  placeholder.userData.objectId = objectId;
  placeholder.userData.name = info.name || objectId;
  placeholder.userData.asset = cloneJsonSafe(info.asset || null);
  placeholder.userData.meshPath = info.meshPath || info.asset?.meshPath || null;
  placeholder.userData.metadata = {
    ...(cloneJsonSafe(info.metadata || null) || {}),
    glbLoadSkippedForDiagnostic: true,
  };
  applyObjectName(placeholder, info.name);
  return placeholder;
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

function applySceneTransform(obj, info = {}) {
  if (!obj) return;

  if (Array.isArray(info.position) && info.position.length >= 3) {
    obj.position.fromArray(info.position);
  }

  if (Array.isArray(info.rotation) && info.rotation.length >= 4) {
    obj.quaternion.fromArray(info.rotation);
  } else if (Array.isArray(info.quaternion) && info.quaternion.length >= 4) {
    obj.quaternion.fromArray(info.quaternion);
  }

  if (Array.isArray(info.scale) && info.scale.length >= 3) {
    obj.scale.fromArray(info.scale);
  }

  obj.updateMatrixWorld(true);
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

// ── BGM handling ────────────────────────────────────────

function clamp01(v) {
  return Math.max(0, Math.min(1, typeof v === 'number' ? v : 1));
}

function applySceneBgm(bgm, options = {}) {
  disposeSceneBgm();

  if (!bgm || !bgm.url) {
    updateBgmControls();
    return;
  }

  const audio = new Audio();
  audio.src = bgm.url;
  audio.loop = bgm.loop !== false;
  audio.volume = clamp01(bgm.volume ?? 1);
  audio.preload = 'auto';

  sceneBgmState.audio = audio;
  sceneBgmState.current = {
    version: bgm.version ?? 1,
    url: bgm.url,
    name: bgm.name ?? 'bgm',
    loop: bgm.loop !== false,
    volume: clamp01(bgm.volume ?? 1),
    playback: bgm.playback ?? { mode: 'local-loop' },
  };

  audio.play().catch((err) => {
    console.warn('[BGM] autoplay blocked:', err?.message);
    sceneBgmState.autoplayBlocked = true;
    showBgmUnlockUI();
  });

  updateBgmControls();
}

function disposeSceneBgm() {
  if (sceneBgmState.audio) {
    sceneBgmState.audio.pause();
    sceneBgmState.audio.src = '';
    sceneBgmState.audio.load?.();
    sceneBgmState.audio = null;
  }
  sceneBgmState.current = null;
  sceneBgmState.autoplayBlocked = false;
  hideBgmUnlockUI();
  updateBgmControls();
}

function serializeSceneBgm() {
  if (!sceneBgmState.current) return null;
  return structuredClone(sceneBgmState.current);
}

function showBgmUnlockUI() {
  const btn = dom.bgmUnlockButton;
  if (!btn) return;
  btn.style.display = 'block';
  btn.onclick = () => {
    if (sceneBgmState.audio) {
      sceneBgmState.audio.play().then(() => {
        sceneBgmState.autoplayBlocked = false;
        hideBgmUnlockUI();
      }).catch(() => {
        showToast?.({
          type: 'error',
          message: '音声を再生できません',
        });
      });
    }
  };
}

function hideBgmUnlockUI() {
  const btn = dom.bgmUnlockButton;
  if (btn) btn.style.display = 'none';
}

function updateBgmControls() {
  const clearButton = dom.clearBgmButton;
  if (!clearButton) return;
  clearButton.style.display = sceneBgmState.current ? 'block' : 'none';
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
      deleteObjectById(operation.objectId, {
        broadcastDelete: false,
        pushHistory: false,
        notifyScene: false,
        ignoreLock: true,
      });
      // Loom object graph をクリーンアップ
      loomIntegration.clearObjectGraph(operation.objectId);
      notifySceneStateChanged('undo-redo-scene-remove');
      updateEnvironmentMenuSkyboxControls();
      break;
    }
    case 'scene-delta': {
      const obj = managedObjects.get(operation.objectId);
      if (obj) {
        const isContentAsset =
          operation.asset &&
          ['image', 'video', 'text'].includes(operation.asset.type);

        if (isContentAsset) {
          const hasMetadata = Object.prototype.hasOwnProperty.call(operation, 'metadata');
          const mergedInfo = {
            objectId: operation.objectId,
            name: typeof operation.name === 'string'
              ? operation.name
              : (obj.userData?.name || operation.objectId),
            position: Array.isArray(operation.position)
              ? operation.position
              : obj.position.toArray(),
            rotation: Array.isArray(operation.rotation)
              ? operation.rotation
              : obj.quaternion.toArray(),
            scale: Array.isArray(operation.scale)
              ? operation.scale
              : obj.scale.toArray(),
            visible: typeof operation.visible === 'boolean'
              ? operation.visible
              : obj.visible !== false,
            asset: cloneJsonSafe(operation.asset),
            metadata: hasMetadata
              ? cloneJsonSafe(operation.metadata)
              : cloneJsonSafe(obj.userData?.metadata || null),
          };

          addOrUpdateObject(operation.objectId, mergedInfo, {
            source: 'undo-redo-content-replace',
            pushHistory: false,
          });

          notifySceneStateChanged('undo-redo-content-replace');
          break;
        }

        if (typeof operation.name === 'string') applyObjectName(obj, operation.name);
        applyTransform(obj, operation);
        if (typeof operation.visible === 'boolean') applyObjectVisibility(obj, operation.visible);
        if (operation.asset) {
          applyAssetDelta(obj, operation.asset);
        }
        if (operation.animation && typeof operation.animation === 'object') {
          applyObjectAnimationDelta(obj, operation.animation);
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
      const batchOps = operation.ops ?? operation.actions;
      if (!Array.isArray(batchOps)) break;
      for (const action of batchOps) {
        if (!action || action.kind === 'scene-batch') continue;
        applyOperationToScene(action);
      }
      notifySceneStateChanged('undo-redo-scene-batch');
      break;
    }
    case 'scene-bgm': {
      applySceneBgm(operation.bgm ?? null);
      notifySceneStateChanged('scene-bgm-applied');
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

function sendHandoff({ targetId, payload }) {
  const ws = presenceState.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'handoff', targetId, payload }));
}

// ── Asset modules initialization ────────────────────────

const assetCache = createSceneAssetCache();
const roomSnapshotCache = createRoomSnapshotCache();

const fileTransferAdapter = createSceneSyncFileTransferAdapter({
  presenceState,
  sendHandoff,
  showToast,
});

function getObjectById(objectId) {
  return managedObjects.get(objectId) || null;
}

async function loadGlbBlobForObject(objectId, blob, options = {}) {
  const obj = managedObjects.get(objectId);
  const info = options.info || null;
  if (!obj && !info) {
    console.warn('[SceneSync] Object not found for loading recovered GLB:', objectId);
    return;
  }

  if (isGlbLoadDisabled()) {
    console.warn('[SceneSync] GLB blob load disabled by diagnostic flag, keeping placeholder', {
      objectId,
      meshPath: options.meshPath,
      sizeBytes: blob?.size || null,
    });
    if (info && !obj) {
      const placeholder = buildGlbDiagnosticPlaceholder(objectId, info);
      applySceneTransform(placeholder, info);
      scene.add(placeholder);
      replaceManagedObject(objectId, placeholder, info);
    }
    return;
  }

  const url = URL.createObjectURL(blob);
  try {
    markCrashProbe('glb-load-start', {
      objectId,
      meshPath: options.meshPath,
      sizeBytes: blob.size,
      source: 'cache',
    });

    const gltf = await new GLTFLoader().loadAsync(url);
    markCrashProbe('glb-load-success', {
      objectId,
      meshPath: options.meshPath,
    });
    markCrashProbe('glb-scene-attach-start', { objectId });

    // Apply visual-only correction for Unity-authored GLBs
    const asset = obj?.userData?.asset || info?.asset || null;
    const isUnityBasis = asset?.visualBasis === "unity";
    console.debug('[glb-loader] visualBasis correction', {
      objectId,
      visualBasis: asset?.visualBasis,
      applyUnityBasisCorrection: isUnityBasis,
    });
    if (isUnityBasis) {
      gltf.scene.rotation.y = Math.PI;
    }

    const wrapper = new THREE.Group();
    wrapper.add(gltf.scene);
    wrapper.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(wrapper);
    const size = box.getSize(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);

    if (maxDimension > 10) {
      wrapper.scale.setScalar(10 / maxDimension);
      wrapper.updateMatrixWorld(true);
    }

    if (obj) {
      wrapper.position.copy(obj.position);
      wrapper.quaternion.copy(obj.quaternion);
      wrapper.scale.copy(obj.scale);
    } else {
      applySceneTransform(wrapper, info);
    }

    wrapper.userData.objectId = objectId;
    wrapper.userData.name = obj?.userData?.name || info?.name || objectId;
    wrapper.userData.meshPath = obj?.userData?.meshPath || options.meshPath || info?.meshPath || null;
    wrapper.userData.asset = obj?.userData?.asset
      ? structuredClone(obj.userData.asset)
      : (info?.asset ? structuredClone(info.asset) : null);
    if (options.assetId) wrapper.userData.assetId = options.assetId;

    const animations = Array.isArray(gltf.animations) ? gltf.animations : [];
    const animationState = animations.length > 0
      ? {
          enabled: true,
          clip: 0,
          mode: 'loop',
          speed: 1,
        }
      : null;

    wrapper.userData.scenesync = {
      ...wrapper.userData.scenesync,
      animations,
      animationState,
    };

    if (info?.runtime) {
      wrapper.userData.runtime = {
        ...(wrapper.userData.runtime || {}),
        ...info.runtime,
        startLocalTime: performance.now(),
      };
    }

    if (info?.animation) {
      wrapper.userData.animationState = {
        ...(animationState || {}),
        ...info.animation,
      };

      wrapper.userData.scenesync = {
        ...wrapper.userData.scenesync,
        animationState: wrapper.userData.animationState,
      };
    }

    applyObjectName(wrapper, wrapper.userData.name);
    applyObjectVisibility(wrapper, info?.visible);

    if (obj) {
      if (transformCtrl.object === obj) transformCtrl.detach();
      scene.remove(obj);
    }
    scene.add(wrapper);
    registerLoadedGlbAnimation(objectId, wrapper, 'glb-blob-loaded');
    notifySceneStateChanged('glb-blob-loaded');
    markCrashProbe('glb-scene-attach-success', { objectId });
    clearCrashProbe('glb-object-ready');
  } finally {
    URL.revokeObjectURL(url);
  }
}

const expiredGlbRecovery = createExpiredGlbRecovery({
  assetCache,
  fileTransfer: fileTransferAdapter,
  presenceState,
  sendHandoff,
  loadGlbBlobForObject,
});

fileTransferAdapter.onFileReceived((event) => {
  expiredGlbRecovery.handleReceivedFile(event);
});

expiredGlbRecovery.onRecoverySuccess(({ objectId, requestId }) => {
  console.log('[SceneSync] Recovery succeeded:', { objectId, requestId });
  removeRecoveringOverlay(objectId);
  removeFailedOverlay(objectId);
});

expiredGlbRecovery.onRecoveryFailed(({ objectId, requestId, reason, info }) => {
  console.log('[SceneSync] Recovery failed:', { objectId, requestId, reason });
  removeRecoveringOverlay(objectId);
  addFailedOverlay(objectId, info);
});

// ── 公開 API（scene.js 内から利用） ──────────────────────

export { scene, camera, renderer, managedObjects, broadcast, presenceState };

function generateRandomPath() {
  return Math.random().toString(36).slice(2, 10);
}

async function uploadAndBroadcast(objectId, name, model, arrayBuffer) {
  const uploadBlob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
  const meshPath = generateRandomPath();
  let actualMeshPath = null;
  let assetId = null;

  try {
    try {
      assetId = await computeAssetId(arrayBuffer);
      model.userData.assetId = assetId;
      await assetCache.putAsset({
        assetId,
        meshPath: null,
        blob: uploadBlob,
        source: 'local-file',
      });
    } catch (cacheErr) {
      console.warn('[SceneSync] Failed to pre-cache uploaded mesh:', cacheErr);
    }

    try {
      const uploadResponse = await fetch(BLOB_BASE + '/' + meshPath, {
        method: 'POST',
        headers: { 'Content-Type': 'model/gltf-binary' },
        body: arrayBuffer,
      });
      if (!uploadResponse.ok) {
        let payload = null;
        try { payload = await uploadResponse.json(); } catch {}
        throw new Error(payload?.message || 'ファイルの読み込みに失敗しました。');
      }
      actualMeshPath = meshPath;
      model.userData.meshPath = meshPath;

      try {
        if (!assetId) {
          assetId = await computeAssetId(arrayBuffer);
          model.userData.assetId = assetId;
        }
        await assetCache.rememberMeshPathAlias(assetId, actualMeshPath);
        console.log('[SceneSync] Remembered uploaded mesh alias:', { objectId, assetId, meshPath: actualMeshPath });
      } catch (cacheErr) {
        console.warn('[SceneSync] Failed to cache uploaded mesh:', cacheErr);
      }
    } catch (err) {
      console.warn('POST failed:', err);
      showToast('GLB アップロード失敗: ' + err.message);
      return;
    }

    // Use canonical asset metadata for creator and broadcast
    const asset = {
      type: 'mesh',
      source: 'carrier',
      assetId: assetId || null,
      meshPath: actualMeshPath,
      size: uploadBlob.size,
      mime: 'model/gltf-binary',
      originalName: name || null,
    };
    model.userData.asset = { ...asset };
    model.userData.meshPath = actualMeshPath;

    console.log('[SceneSync] broadcast scene-add', { objectId, meshPath: actualMeshPath, assetId });

    const sceneAddPayload = {
      kind: 'scene-add',
      objectId,
      name,
      position: model.position.toArray(),
      rotation: model.quaternion.toArray(),
      scale: model.scale.toArray(),
      asset: { ...asset },
      meshPath: actualMeshPath,
    };

    presenceState.historyManager.push(
      HistoryManager.createSceneAddEntry(sceneAddPayload)
    );
    notifySceneStateChanged('object-uploaded');

    broadcast(sceneAddPayload);
  } finally {
    removeLoadingOverlay(objectId);
  }
}

function generateBlobId() {
  const raw = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  return raw.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 24);
}

async function uploadCarrierGlb(arrayBuffer) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = generateBlobId();
    const res = await fetch(`${BLOB_BASE}/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'model/gltf-binary' },
      body: arrayBuffer,
    });
    if (res.status === 201 || res.status === 200) return id;
    if (res.status !== 409) {
      let payload = null;
      try { payload = await res.json(); } catch {}
      throw new Error(payload?.message || 'ファイルの読み込みに失敗しました。');
    }
  }
  throw new Error('blob id collision - unable to generate unique ID');
}

// Skybox管理のためのヘルパー関数

function applySceneActionLocally(action, options = {}) {
  if (!action) return;

  if (action.kind === 'scene-add') {
    addOrUpdateObject(action.objectId, action, options);
    return;
  }

  if (action.kind === 'scene-remove') {
    deleteObjectById(action.objectId, {
      broadcastDelete: false,
      pushHistory: false,
      notifyScene: false,
    });
    loomIntegration.clearObjectGraph(action.objectId);
    updateEnvironmentMenuSkyboxControls();
    notifySceneStateChanged('local-scene-remove');
    return;
  }

  if (action.kind === 'scene-batch') {
    for (const child of action.actions || []) {
      const childOptions = child.kind === 'scene-add' ? options : {};
      applySceneActionLocally(child, childOptions);
    }
    return;
  }
}

async function createSkyboxSpherePayloadFromBlob(blob, sourceName = 'skybox', context = {}) {
  const safeName = sourceName || 'skybox';
  let optimizationInfo = null;
  const existingMetadata = (context.metadata && typeof context.metadata === 'object')
    ? context.metadata
    : {};
  const logContext = {
    tempObjectId: context.tempObjectId,
    fileName: context.fileName || safeName,
    fileSize: context.fileSize,
    targetKind: context.targetKind || 'sky',
  };

  const buildStart = performance.now();
  console.debug('[image-import] build glb start', logContext);

  const result = await buildImageSkySphereGlb(blob, {
    THREE,
    GLTFExporter,
    radius: 50,
    widthSegments: 64,
    heightSegments: 32,
    maxPixel: 4096,
    onOptimized: (info) => {
      optimizationInfo = info;
    },
  });
  console.debug('[image-import] build glb complete', {
    ...logContext,
    ms: Math.round(performance.now() - buildStart),
  });
  console.debug('[image-import] optimized', {
    ...logContext,
    originalWidth: optimizationInfo?.originalWidth,
    originalHeight: optimizationInfo?.originalHeight,
    textureWidth: optimizationInfo?.textureWidth,
    textureHeight: optimizationInfo?.textureHeight,
    resized: optimizationInfo?.resized,
    optimizeMs: optimizationInfo?.durationMs,
  });

  const uploadStart = performance.now();
  console.debug('[image-import] upload start', logContext);
  const meshPath = await uploadCarrierGlb(result.arrayBuffer);
  console.debug('[image-import] upload complete', {
    ...logContext,
    ms: Math.round(performance.now() - uploadStart),
    meshPath,
  });
  const objectId = `sky-${meshPath.slice(0, 8)}`;

  const payload = {
    kind: 'scene-add',
    objectId,
    name: `sky: ${safeName}`.slice(0, 80),
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    asset: {
      type: 'mesh',
      source: 'generated-skybox',
      meshPath,
    },
    meshPath,
    metadata: {
      ...existingMetadata,
      role: 'sky-sphere',
      generatedFrom: 'image',
      sourceName: safeName,
      image: {
        originalWidth: optimizationInfo?.originalWidth,
        originalHeight: optimizationInfo?.originalHeight,
        textureWidth: optimizationInfo?.textureWidth ?? result.width,
        textureHeight: optimizationInfo?.textureHeight ?? result.height,
        originalBytes: optimizationInfo?.originalBytes ?? blob?.size ?? null,
        maxPixel: optimizationInfo?.maxPixel ?? result.maxPixel,
        optimized: !!(optimizationInfo?.resized ?? result.optimized),
      },
    },
  };

  return payload;
}

function createReplaceSkyboxBatchEntry(oldSkyboxPayloads, newSkyboxPayload) {
  const removeOldActions = oldSkyboxPayloads.map(payload => ({
    kind: 'scene-remove',
    objectId: payload.objectId,
  }));

  const forwardActions = [
    ...removeOldActions,
    newSkyboxPayload,
  ];

  const backwardActions = [
    ...oldSkyboxPayloads,
    {
      kind: 'scene-remove',
      objectId: newSkyboxPayload.objectId,
    },
  ];

  return HistoryManager.createBatchEntry(
    forwardActions,
    backwardActions,
    'Replaced Skybox'
  );
}

async function replaceSkyboxSphereFromBlob(blob, sourceName = 'skybox', context = {}) {
  const oldSkyboxPayloads = getSkySpherePayloads();
  const newSkyboxPayload = await createSkyboxSpherePayloadFromBlob(blob, sourceName, context);

  const batchEntry = createReplaceSkyboxBatchEntry(
    oldSkyboxPayloads,
    newSkyboxPayload
  );

  // ローカルに適用
  applySceneActionLocally(batchEntry.forward, { previewObjectId: context.tempObjectId });

  // リモートに同期
  broadcast(batchEntry.forward);

  // Undoに登録
  presenceState.historyManager.push(batchEntry);

  updateEnvironmentMenuSkyboxControls();
  notifySceneStateChanged('skybox-replaced');

  showToast(
    oldSkyboxPayloads.length > 0
      ? 'Skyboxを置き換えました'
      : 'Skyboxを追加しました'
  );

  return {
    objectId: newSkyboxPayload.objectId,
    payload: newSkyboxPayload,
  };
}

function getOptimizedImageOutputFormat(file) {
  const inputType = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();

  const isJpeg =
    inputType === 'image/jpeg' ||
    inputType === 'image/jpg' ||
    /\.(jpe?g)$/.test(name);

  if (isJpeg) {
    return {
      mime: 'image/jpeg',
      extension: '.jpg',
      quality: 0.92,
    };
  }

  const isPngOrWebp =
    inputType === 'image/png' ||
    inputType === 'image/webp' ||
    /\.(png|webp)$/.test(name);

  if (isPngOrWebp) {
    return {
      mime: 'image/png',
      extension: '.png',
      quality: undefined,
    };
  }

  return {
    mime: 'image/png',
    extension: '.png',
    quality: undefined,
  };
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('canvas.toBlob failed'));
        }
      },
      mime,
      quality,
    );
  });
}

async function replaceImageFileOptimistically(objectId, file, context = {}) {
  const preview = await showLocalImageReplacementPreview(objectId, file);

  try {
    // Optimize and upload
    const optimized = await createImageCanvasForScene(file, {
      maxPixel: 2048,
      label: file.name,
    });

    const outputFormat = getOptimizedImageOutputFormat(file);
    const imageBlob = await canvasToBlob(
      optimized.canvas,
      outputFormat.mime,
      outputFormat.quality,
    );

    const uploadedUrl = await uploadBlobToStore(imageBlob, outputFormat.mime, outputFormat.extension);

    // Check if this preview is still current
    if (preview && !isCurrentLocalImageReplacementPreview(objectId, preview.token)) {
      console.debug('[image-import] stale image replacement ignored', { objectId });
      return { objectId, stale: true };
    }

    await replaceObjectContent(
      objectId,
      {
        kind: 'image',
        source: 'blob',
        url: uploadedUrl.url,
        mime: outputFormat.mime,
        width: optimized.textureWidth,
        height: optimized.textureHeight,
        name: file.name,
      },
      preview
        ? {
            localReplacementObjectId: objectId,
            localReplacementPreviewToken: preview.token,
          }
        : {}
    );

    return {
      objectId,
      url: uploadedUrl.url,
    };
  } catch (error) {
    if (preview) {
      clearLocalImageReplacementPreview(objectId, preview.token);
    }

    const replacementError = new Error(
      error?.message || '画像の差し替えに失敗しました'
    );
    replacementError.original = error;
    throw replacementError;
  }
}

async function imageImporterCallback(file, position, context = {}) {
  if (file.size > ABSOLUTE_IMAGE_FILE_LIMIT_BYTES) {
    throw new Error('この画像は非常に大きいため処理できません');
  }

  const { targetKind = 'scene', tempObjectId, replaceTargetObjectId } = context;
  const isSkyTarget = targetKind === 'sky';
  const existingMetadata = (context.metadata && typeof context.metadata === 'object')
    ? context.metadata
    : {};
  const t0 = performance.now();
  const logContext = {
    tempObjectId,
    fileName: file.name,
    fileSize: file.size,
    targetKind,
  };

  console.debug('[image-import] start', logContext);

  let temporaryPreviewHandedOffToFinalLoader = false;

  try {
    if (isSkyTarget) {
      const result = await replaceSkyboxSphereFromBlob(file, file.name || 'skybox', {
        ...logContext,
      });
      temporaryPreviewHandedOffToFinalLoader = true;
      console.debug('[image-import] final object added', {
        ...logContext,
        objectId: result?.objectId,
      });
      return result;
    }

    // Determine replacement target early
    const effectiveReplaceTargetId = replaceTargetObjectId || null;
    const effectiveReplaceTarget = effectiveReplaceTargetId
      ? managedObjects.get(effectiveReplaceTargetId)
      : getReplaceTarget('image', context.hitObjectId || null);

    if (effectiveReplaceTarget) {
      if (tempObjectId) {
        // DragDropManager could not determine replacement target upfront, so a new-addition
        // temporary preview was created. Clean it up now before proceeding with replacement.
        console.debug('[image-import] cleanup unexpected temporary preview before replacement', {
          ...logContext,
          targetId: effectiveReplaceTarget.userData.objectId,
          tempObjectId,
        });
        removeTemporaryImagePreview(tempObjectId);
        removeLoadingOverlay(tempObjectId);
      }

      const targetId = effectiveReplaceTarget.userData.objectId;
      console.debug('[image-import] replacing existing object (optimistic)', {
        ...logContext,
        targetId,
      });
      try {
        const result = await replaceImageFileOptimistically(targetId, file, context);
        // Do NOT set temporaryPreviewHandedOffToFinalLoader = true here.
        // Replacement uses localReplacementPreview, not the new-addition temporary preview.
        console.debug('[image-import] optimistic replacement complete', {
          ...logContext,
          targetId,
          result,
        });
        return result;
      } catch (error) {
        console.warn('[image-import] optimistic replacement failed', {
          ...logContext,
          targetId,
          error,
        });
        throw error;
      }
    }

    // Optimize image and upload as raw blob (not GLB) - for new additions
    const optimizeStart = performance.now();
    console.debug('[image-import] optimize start', logContext);
    const optimized = await createImageCanvasForScene(file, { maxPixel: 2048, label: file.name });
    console.debug('[image-import] optimize complete', {
      ...logContext,
      ms: Math.round(performance.now() - optimizeStart),
      originalWidth: optimized.originalWidth,
      originalHeight: optimized.originalHeight,
      textureWidth: optimized.textureWidth,
      textureHeight: optimized.textureHeight,
      resized: optimized.resized,
    });

    const outputFormat = getOptimizedImageOutputFormat(file);
    const imageBlob = await canvasToBlob(
      optimized.canvas,
      outputFormat.mime,
      outputFormat.quality,
    );

    // TODO: presence blobs have a server-side TTL; long-lived rooms may see broken image URLs.
    // Future: cache the blob in IndexedDB and re-upload on session reconnect if the URL 404s.
    const uploadStart = performance.now();
    console.debug('[image-import] upload start', logContext);
    const uploaded = await uploadBlobToStore(imageBlob, outputFormat.mime, outputFormat.extension);
    console.debug('[image-import] upload complete', {
      ...logContext,
      ms: Math.round(performance.now() - uploadStart),
      url: uploaded.url,
    });

    const positionArray = (position && typeof position.toArray === 'function')
      ? position.toArray()
      : [0, 1, 0];
    const placementQuaternion = Array.isArray(context.placementRotation)
      ? new THREE.Quaternion().fromArray(context.placementRotation)
      : context.placementQuaternion || null;
    const rotation = placementQuaternion
      ? placementQuaternion.toArray()
      : [0, 0, 0, 1];

    const newAsset = {
      type: 'image',
      source: 'blob',
      url: uploaded.url,
      mime: outputFormat.mime,
      width: optimized.textureWidth,
      height: optimized.textureHeight,
    };

    const objectId = generateObjectId('img');
    const displayName = `image: ${file.name}`.slice(0, 60);

    const payload = {
      kind: 'scene-add',
      objectId,
      name: displayName,
      position: positionArray,
      rotation,
      scale: [1, 1, 1],
      asset: newAsset,
      metadata: {
        ...existingMetadata,
        role: 'media-panel',
        accepts: ['image', 'video'],
        fit: 'contain',
        image: {
          originalWidth: optimized.originalWidth,
          originalHeight: optimized.originalHeight,
          textureWidth: optimized.textureWidth,
          textureHeight: optimized.textureHeight,
          originalBytes: file.size,
          maxPixel: 2048,
          optimized: optimized.resized,
        },
        placement: {
          surfaceKind: context.surfaceKind || 'unknown',
          normal: context.normalArray || null,
        },
      },
    };

    broadcast(payload);
    addOrUpdateObject(objectId, payload, { previewObjectId: tempObjectId });
    presenceState.historyManager?.push(
      HistoryManager.createSceneAddEntry(payload)
    );
    temporaryPreviewHandedOffToFinalLoader = true;
    console.debug('[image-import] final object added', {
      ...logContext,
      objectId,
    });
    return { objectId, payload };
  } catch (error) {
    console.warn('[image-import] failed', {
      ...logContext,
      error,
      totalMs: Math.round(performance.now() - t0),
    });
    throw error;
  } finally {
    if (tempObjectId && !temporaryPreviewHandedOffToFinalLoader) {
      removeTemporaryImagePreview(tempObjectId);
      removeLoadingOverlay(tempObjectId);
    }
    console.debug('[image-import] complete', {
      ...logContext,
      totalMs: Math.round(performance.now() - t0),
    });
  }
}

async function textImporterCallback(text, position, filename = 'text.md', context = {}) {
  const existingMetadata = (context.metadata && typeof context.metadata === 'object')
    ? context.metadata
    : {};

  const positionArray = (position && typeof position.toArray === 'function')
    ? position.toArray()
    : [0, 1, 0];
  const placementQuaternion = Array.isArray(context.placementRotation)
    ? new THREE.Quaternion().fromArray(context.placementRotation)
    : context.placementQuaternion || null;
  const rotation = placementQuaternion
    ? placementQuaternion.toArray()
    : readQuaternionArray(context.rotation, [0, 0, 0, 1]);
  const scale = readVector3Array(context.scale, [1, 1, 1]);

  const newAsset = {
    type: 'text',
    source: 'inline',
    text,
    format: /\.(md|markdown)$/i.test(filename) ? 'markdown' : 'plain',
    fontFamily: 'system-sans',
    fontSize: 32,
    fontWeight: 'normal',
    fontStyle: 'normal',
    color: '#ffffff',
    backgroundColor: 'rgba(0,0,0,0.65)',
    align: 'left',
    layout: { ...DEFAULT_TEXT_LAYOUT },
    scroll: { ...DEFAULT_TEXT_SCROLL },
  };

  // Check for replace target
  const replaceTarget = getReplaceTarget('text', context.hitObjectId);
  if (replaceTarget) {
    const targetId = replaceTarget.userData.objectId;
    await replaceObjectContent(targetId, {
      kind: 'text',
      source: 'inline',
      text,
      format: newAsset.format,
    });
    return { objectId: targetId };
  }

  const objectId = (typeof context.objectId === 'string' && context.objectId.trim())
    ? context.objectId.trim()
    : generateObjectId('txt');
  const displayName = (typeof context.name === 'string' && context.name.trim())
    ? context.name.trim().slice(0, 60)
    : `text: ${filename}`.slice(0, 60);

  const payload = {
    kind: 'scene-add',
    objectId,
    name: displayName,
    position: positionArray,
    rotation,
    scale,
    asset: newAsset,
    metadata: {
      ...existingMetadata,
      role: 'text-panel',
      accepts: ['text'],
      placement: {
        surfaceKind: context.surfaceKind || 'unknown',
        normal: context.normalArray || null,
      },
    },
  };

  broadcast(payload);
  addOrUpdateObject(objectId, payload);
  presenceState.historyManager?.push(
    HistoryManager.createSceneAddEntry(payload)
  );

  return { objectId, payload };
}

function generateObjectId(prefix) {
  const raw = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const id = raw.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 16);
  return `${prefix}-${id}`;
}

async function urlImporterCallback(url, position, context = {}) {
  const resolved = resolveDroppedUrl(url);

  for (const note of resolved.notes || []) {
    showToast(note);
  }

  for (const warning of resolved.warnings || []) {
    showToast(warning);
  }

  const positionArray = (position && typeof position.toArray === 'function')
    ? position.toArray()
    : [0, 1, 0];

  // Classify and normalize URL (e.g., GitHub blob -> raw)
  const classified = classifyUrl(resolved.resolvedUrl);
  const normalizedUrl = classified.url || resolved.resolvedUrl;
  const urlKind = classified.kind;

  // Skybox intent takes priority for image URLs when looking up.
  const isImageUrl = urlKind === URL_KIND.IMAGE;
  const urlSkybox =
    isImageUrl &&
    context.upness !== undefined &&
    context.upness > SKY_DROP_UPNESS_THRESHOLD;

  // Auto-replace detection (not for skybox targets)
  if (!urlSkybox) {
    let inputKind = null;
    if (urlKind === URL_KIND.IMAGE) inputKind = 'image';
    else if (urlKind === URL_KIND.VIDEO || urlKind === URL_KIND.VIDEO_HLS) inputKind = 'video';
    else if (urlKind === URL_KIND.TEXT) inputKind = 'text';

    if (inputKind) {
      const replaceTarget = getReplaceTarget(inputKind, context.hitObjectId);
      if (replaceTarget) {
        await replaceObjectContent(replaceTarget.userData.objectId, {
          kind: inputKind,
          source: 'url',
          url: normalizedUrl,
          ...(inputKind === 'text' && /\.(md|markdown)(?:$|[?#])/i.test(normalizedUrl)
            ? { format: 'markdown' }
            : {}),
        });
        return;
      }
    }
  }

  const effectiveTargetKind = urlSkybox ? 'sky' : (context?.targetKind || 'scene');
  const effectiveSurfaceKind = urlSkybox ? 'skybox' : (context.surfaceKind || null);
  const effectivePlacementRotation = urlSkybox ? null : (context.placementRotation || null);
  const effectivePlacementQuaternion = urlSkybox ? null : (context.placementQuaternion || null);

  const ctx = createSceneUrlImportContext({
    positionArray,
    placementRotation: effectivePlacementRotation,
    placementQuaternion: effectivePlacementQuaternion,
    surfaceKind: effectiveSurfaceKind,
    normalArray: context.normalArray || null,
    rawNormalArray: context.rawNormalArray || null,
    wallSurfaceOffset: context.wallSurfaceOffset ?? 0,
    placementPosition: context.placementPosition || null,
    targetKind: effectiveTargetKind,
    sourceContext: context,
  });

  await dispatchUrlImport(normalizedUrl, ctx);
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
  THREE,
  getRaycastTargets: () => Array.from(managedObjects.values())
    .filter(obj => obj.userData?.dropRaycastTarget && obj.visible !== false),
  getPlacementTargets: () => {
    const targets = [];
    for (const obj of managedObjects.values()) {
      if (!isSkySphereThreeObject(obj) && obj.visible !== false) {
        targets.push(obj);
      }
    }
    scene.traverse((obj) => {
      if (obj.userData?.isPlacementTarget
        && obj.visible !== false
        && obj.userData?.role !== 'multi-transform-pivot'
        && !obj.userData?._temporary
        && !isPastePreviewUserData(obj.userData)) {
        targets.push(obj);
      }
    });
    return targets;
  },
  getReplaceTargetForContent: (inputKind, context = {}) => {
    if (context.targetKind === 'sky') return null;

    const target = getReplaceTarget(inputKind, context.hitObjectId || null);
    return target?.userData?.objectId || null;
  },
  onLoadStart: async ({
    objectId,
    file,
    position,
    source,
    targetKind,
    placementQuaternion,
    placementRotation,
  }) => {
    if (!objectId) return;
    const label = source === 'image'
      ? targetKind === 'sky'
        ? 'Skybox画像を準備中…'
        : '画像を準備中…'
      : file?.name || '読み込み中…';

    addLoadingOverlay(objectId, label, { position: position?.toArray?.() });

    if (source === 'image') {
      showTemporaryImagePreview(objectId, file, position, {
        targetKind,
        placementQuaternion,
        placementRotation,
      });
    }
  },
  onLoadEnd: async ({ objectId, source }) => {
    if (!objectId) return;
    removeLoadingOverlay(objectId);
    // Image preview cleanup is intentionally skipped here.
    // It is handed off to loadMeshObject() via options.previewObjectId
    // and must happen only after the final GLB object has been displayed.
  },
  onLoaded: async (model, file) => {
    managedObjects.set(model.userData.objectId, model);
    setupObjectGlbAnimation(model.userData.objectId, model);
    selectManagedObject(model);
    notifySelectionChanged('drag-drop-object-selected');

    // 正規化の結果をトーストで通知
    const metadata = model.userData?.scenesync?.glbMetadata;
    if (metadata?.normalized) {
      showToast('Sketchfab形式のマテリアルをScene Sync向けに変換しました');
    } else if (metadata?.normalizationSkipped) {
      showToast('このモデルはScene Syncで正しく表示できない可能性があるマテリアルを使用しています');
    }

    // 変換後 ArrayBuffer を優先（upload / broadcast / cache すべてに変換後を使う）
    const arrayBuffer = model.userData.normalizedGlbArrayBuffer
      ? model.userData.normalizedGlbArrayBuffer
      : await file.arrayBuffer();

    await uploadAndBroadcast(
      model.userData.objectId,
      file.name,
      model,
      arrayBuffer
    );
  },
  imageImporter: imageImporterCallback,
  textImporter: textImporterCallback,
  urlImporter: urlImporterCallback,
});

window.__sceneSyncDebug = {
  ...(window.__sceneSyncDebug || {}),
  dragDropManager,
  getSelection: getCurrentSelectionPayload,
  getActiveTransformTweenCount: () => activeTransformTweens.size,
};

function isMobileUi() {
  return isSceneSyncMobileDevice();
}

function isDevUiEnabled() {
  return new URLSearchParams(location.search).get('dev') === '1';
}

function openSheet(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = false;
}

function closeSheet(id) {
  blurActiveEditableElement();
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = true;
}

function openMobileActionSheet() {
  openSheet('mobile-action-sheet');
}

function closeMobileActionSheet() {
  closeSheet('mobile-action-sheet');
}

function openMobileRoomSheet() {
  renderMobileRoomActions();
  openSheet('mobile-room-sheet');
}

function closeMobileRoomSheet() {
  closeSheet('mobile-room-sheet');
}

dom.addBtn?.addEventListener('click', (event) => {
  if (!isMobileUi()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openMobileActionSheet();
}, true);

// ── クリップボード貼り付け ────────────────────────────────────────────

function getDefaultImportPosition() {
  const rect = renderer.domElement.getBoundingClientRect();
  return dragDropManager.coordinateTransformer.screenToWorld(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
    renderer.domElement
  );
}

function getCenterRayPlacementContext() {
  const rect = renderer.domElement.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;

  return dragDropManager.getPlacementFromClientPoint?.(clientX, clientY)
    || getDefaultImportPosition();
}

function getClipboardPlacementContext() {
  return isSceneSyncMobileDevice()
    ? getCenterRayPlacementContext()
    : getDefaultImportPosition();
}

const clipboardImportManager = new ClipboardImportManager({
  container: document,
  getDefaultPosition: getClipboardPlacementContext,
  showToast,
  isEditingTarget: (target) => {
    const el = target instanceof Element ? target : null;
    if (!el) return false;

    if (el.closest('input, textarea, select, [contenteditable="true"]')) return true;
    if (el.closest('.cm-editor, .monaco-editor')) return true;
    if (el.closest('#scene-json-editor, #selected-object-json-editor, #dsl-editor')) return true;

    return false;
  },
  handleFile: (file, placement) => dragDropManager.handleFile(file, placement),
  handleUrl: (url, position, placement) => urlImporterCallback(url, position, placement),
  handleText: (text, position, filename, placement) => textImporterCallback(text, position, filename, placement),
});

// ── クリップボード貼り付けUI のイベントバインディング ─────────────────

const pasteBtn = document.getElementById('paste-btn');
const pasteSheet = document.getElementById('paste-sheet');
const clipboardPasteTarget = document.getElementById('clipboard-paste-target');
const pasteSheetClose = document.getElementById('paste-sheet-close');
const mobileActionSheetCloseBtn = document.getElementById('mobile-action-sheet-close');
const mobileAddImageBtn = document.getElementById('mobile-add-image-btn');
const mobileAddGlbBtn = document.getElementById('mobile-add-glb-btn');
const mobilePasteBtn = document.getElementById('mobile-paste-btn');
const mobileRoomOpenBtn = document.getElementById('mobile-room-open-btn');
const mobileRoomSheetCloseBtn = document.getElementById('mobile-room-sheet-close');
const mobileEnvOpenBtn = document.getElementById('mobile-env-open-btn');
const mobileEnvSheetCloseBtn = document.getElementById('mobile-env-sheet-close');
const mobileEnvSelect = document.getElementById('mobile-env-select');
const mobileSetSkyboxBtn = document.getElementById('mobile-set-skybox-btn');
const mobileDeleteSkyboxBtn = document.getElementById('mobile-delete-skybox-btn');
const mobileLinkOpenBtn = document.getElementById('mobile-link-open-btn');
const mobileHelpBtn = document.getElementById('mobile-help-btn');
const mobileDevOpenBtn = document.getElementById('mobile-dev-open-btn');

function closePasteSheet() {
  blurActiveEditableElement();
  if (pasteSheet) {
    pasteSheet.setAttribute('hidden', '');
  }
  if (clipboardPasteTarget) {
    clipboardPasteTarget.textContent = '';
  }
}

function openPasteSheet() {
  if (!pasteSheet) return;
  pasteSheet.removeAttribute('hidden');
  requestAnimationFrame(() => {
    clipboardPasteTarget?.focus?.();
  });
}

async function pasteFromClipboardAtDefaultPosition() {
  showToast('クリップボードを読み込みます…');
  const result = await clipboardImportManager.pasteFromNavigatorClipboard(getClipboardPlacementContext())
    .catch((error) => {
      console.warn('[clipboard] navigator clipboard paste failed:', error);
      return null;
    });

  if (result) {
    return result;
  }

  showToast('クリップボードを読み取れません');
  return null;
}

pasteBtn?.addEventListener('click', () => {
  pasteFromClipboardAtDefaultPosition().catch((error) => {
    console.warn('[paste] failed:', error);
  });
});
mobileActionSheetCloseBtn?.addEventListener('click', closeMobileActionSheet);
mobileAddImageBtn?.addEventListener('click', () => {
  closeMobileActionSheet();
  dom.mobileImageInput?.click();
});
mobileAddGlbBtn?.addEventListener('click', () => {
  closeMobileActionSheet();
  dom.mobileGlbInput?.click();
});
mobilePasteBtn?.addEventListener('click', () => {
  closeMobileActionSheet();
  pasteFromClipboardAtDefaultPosition().catch((error) => {
    console.warn('[mobile-paste] failed:', error);
  });
});
dom.mobileImageInput?.addEventListener('change', (event) => {
  const input = event.target;
  const file = input?.files?.[0];

  if (file) {
    dragDropManager.handleFile(file, getCenterRayPlacementContext()).catch((error) => {
      console.warn('[mobile-image-input] failed to add image:', error);
      showToast(error?.message || '画像の追加に失敗しました');
    });
  }

  if (input) {
    input.value = '';
  }
});
dom.mobileGlbInput?.addEventListener('change', (event) => {
  const input = event.target;
  const file = input?.files?.[0];

  if (file) {
    dragDropManager.handleFile(file, getCenterRayPlacementContext()).catch((error) => {
      console.warn('[mobile-glb-input] failed to add GLB:', error);
      showToast(error?.message || '3Dモデルの追加に失敗しました');
    });
  }

  if (input) {
    input.value = '';
  }
});
const mobileSkyboxImageInput = document.getElementById('mobile-skybox-image-input');
mobileSkyboxImageInput?.addEventListener('change', async (event) => {
  const input = event.target;
  const file = input?.files?.[0];
  let tempObjectId = null;

  try {
    if (file) {
      tempObjectId = generateTemporaryImageObjectId();
      const position = getDefaultImportPosition();

      addLoadingOverlay(tempObjectId, 'Skybox画像を準備中…', {
        position: position?.toArray?.(),
      });

      showTemporaryImagePreview(tempObjectId, file, position, {
        targetKind: 'sky',
        placementQuaternion: null,
        placementRotation: null,
      });

      await imageImporterCallback(file, position, {
        targetKind: 'sky',
        surfaceKind: 'skybox',
        upness: 1,
        tempObjectId,
        metadata: {
          source: 'mobile-background-sheet',
        },
      });

      closeSheet('mobile-env-sheet');
    }
  } catch (error) {
    console.warn('[mobile-skybox-input] failed to set skybox:', error);
    showToast(error?.message || '背景画像の設定に失敗しました');
    if (tempObjectId) {
      removeTemporaryImagePreview(tempObjectId);
      removeLoadingOverlay(tempObjectId);
    }
  } finally {
    if (input) {
      input.value = '';
    }
  }
});
mobileRoomOpenBtn?.addEventListener('click', () => {
  closeMobileActionSheet();
  openMobileRoomSheet();
});
mobileRoomSheetCloseBtn?.addEventListener('click', closeMobileRoomSheet);
mobileEnvOpenBtn?.addEventListener('click', () => {
  if (mobileEnvSelect && dom.envSelect) {
    mobileEnvSelect.value = dom.envSelect.value;
  }
  closeMobileActionSheet();
  openSheet('mobile-env-sheet');
});
mobileEnvSheetCloseBtn?.addEventListener('click', () => {
  closeSheet('mobile-env-sheet');
});
mobileSetSkyboxBtn?.addEventListener('click', () => {
  mobileSkyboxImageInput?.click();
});
mobileDeleteSkyboxBtn?.addEventListener('click', () => {
  const removed = removeSkyboxSpheres();
  if (removed) {
    closeSheet('mobile-env-sheet');
  }
});
mobileLinkOpenBtn?.addEventListener('click', () => {
  closeMobileActionSheet();
  linkBtn?.click();
});
mobileHelpBtn?.addEventListener('click', () => {
  closeMobileActionSheet();
  openHelpDialog();
});
mobileDevOpenBtn?.addEventListener('click', () => {
  closeMobileActionSheet();
  sceneInspectorToggleBtn?.click();
});

document.querySelectorAll('[data-mobile-sheet-close]').forEach((el) => {
  el.addEventListener('click', () => {
    const target = el.dataset.mobileSheetClose;
    if (target === 'action') closeMobileActionSheet();
    if (target === 'room') closeMobileRoomSheet();
    if (target === 'env') closeSheet('mobile-env-sheet');
  });
});

mobileEnvSelect?.addEventListener('change', () => {
  if (!dom.envSelect) return;
  dom.envSelect.value = mobileEnvSelect.value;
  dom.envSelect.dispatchEvent(new Event('change', { bubbles: true }));
});

if (pasteSheetClose && pasteSheet) {
  pasteSheetClose.addEventListener('click', () => {
    closePasteSheet();
  });
}

if (pasteSheet) {
  pasteSheet.addEventListener('click', (e) => {
    if (e.target === pasteSheet) {
      closePasteSheet();
    }
  });
}

// #clipboard-paste-target に専用の paste handler
if (clipboardPasteTarget) {
  clipboardPasteTarget.addEventListener('paste', async (event) => {
    const handled = await clipboardImportManager.handlePasteEvent(event, {
      force: true,
      position: getClipboardPlacementContext(),
    });

    if (handled) {
      closePasteSheet();
    }
  });
}

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

const roomFullDialog = document.getElementById('room-full-dialog');
const btnRoomFullRetry = document.getElementById('btn-room-full-retry');
const btnRoomFullNew = document.getElementById('btn-room-full-new');

let pairingCountdown = null;
let pairingExpireTime = null;
let pairingAutoCloseTimer = null;

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function clearPairingCountdown() {
  if (pairingCountdown) clearInterval(pairingCountdown);
  pairingCountdown = null;
  pairingExpireTime = null;
}

function clearPairingAutoCloseTimer() {
  if (!pairingAutoCloseTimer) return;
  clearTimeout(pairingAutoCloseTimer);
  pairingAutoCloseTimer = null;
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

function scheduleClosePairingDialogAfterLinked() {
  clearPairingAutoCloseTimer();

  pairingAutoCloseTimer = window.setTimeout(() => {
    pairingAutoCloseTimer = null;
    if (pairingDialog) {
      pairingDialog.style.display = 'none';
    }
  }, 2000);
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

function renderSceneInspectorAnimationControls(selectedObject) {
  const objectId = selectedObject?.objectId;
  const objectSnapshot = selectedObject?.objectSnapshot;
  const clips = objectSnapshot?.animationClips || [];
  const animation = objectSnapshot?.animation || null;

  const hasAnimation = !!objectId && Array.isArray(clips) && clips.length > 0 && animation;

  if (sceneInspectorAnimationControlsEl) {
    sceneInspectorAnimationControlsEl.hidden = !hasAnimation;
  }
  if (!hasAnimation) return;

  if (sceneInspectorAnimationMetaEl) {
    sceneInspectorAnimationMetaEl.textContent = `${clips.length} clip(s)`;
  }

  if (sceneInspectorAnimationEnabledEl) {
    sceneInspectorAnimationEnabledEl.checked = animation.enabled !== false;
  }

  if (sceneInspectorAnimationSpeedEl) {
    sceneInspectorAnimationSpeedEl.value = String(Number.isFinite(animation.speed) ? animation.speed : 1);
  }

  if (sceneInspectorAnimationClipEl) {
    const currentValue = String(animation.clip || 0);
    sceneInspectorAnimationClipEl.innerHTML = '';

    for (const clip of clips) {
      const option = document.createElement('option');
      option.value = String(clip.index);
      const durationLabel = Number.isFinite(clip.duration)
        ? ` (${clip.duration.toFixed(2)}s)`
        : '';
      option.textContent = `${clip.index}: ${clip.name || `Animation ${clip.index}`}${durationLabel}`;
      sceneInspectorAnimationClipEl.appendChild(option);
    }

    sceneInspectorAnimationClipEl.value = currentValue;
  }
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

  renderSceneInspectorAnimationControls(selectedObject);

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
  const focused = focusTextInputIfSafe(sceneInspectorEditorEl);
  if (focused) {
    sceneInspectorEditorEl?.setSelectionRange(0, 0);
  }
}

function exitSceneInspectorEditMode() {
  blurActiveEditableElement();
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
  const focused = focusTextInputIfSafe(sceneInspectorObjectEditorEl);
  if (focused) {
    sceneInspectorObjectEditorEl?.setSelectionRange(0, 0);
  }
}

function exitSceneInspectorObjectEditMode() {
  blurActiveEditableElement();
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

    const animationState = getObjectAnimationState(obj);
    if (animationState) {
      entry.animation = animationState;
      entry.animationClips = getObjectAnimationClipSummaries(obj);
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

function safeCloneJson(value) {
  if (value == null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function isSnapshotExcludedObject(objectId, object) {
  if (!object) return true;
  if (objectId === 'sample-cube') return true;

  const userData = object.userData || {};
  if (userData._temporary) return true;
  if (userData._isLockOverlay) return true;
  if (userData.role === 'avatar') return true;
  if (userData.role === 'helper') return true;
  if (userData.isTransformHelper) return true;

  return false;
}

function hasSnapshotRestorableObjects() {
  for (const [objectId, object] of managedObjects.entries()) {
    if (!isSnapshotExcludedObject(objectId, object)) return true;
  }
  return false;
}

function createCurrentSceneSnapshot() {
  const objects = [];

  for (const [objectId, object] of managedObjects.entries()) {
    if (isSnapshotExcludedObject(objectId, object)) continue;

    const asset = safeCloneJson(object.userData?.asset || null);
    const metadata = safeCloneJson(object.userData?.metadata || null);
    const animation = serializeObjectAnimationState(object);

    const entry = {
      objectId,
      name: object.userData?.name || object.name || objectId,
      position: object.position.toArray(),
      rotation: object.quaternion.toArray(),
      scale: object.scale.toArray(),
      visible: object.visible !== false,
      asset,
      meshPath: object.userData?.meshPath || asset?.meshPath || null,
      metadata,
    };

    if (animation) {
      entry.animation = animation;
    }

    objects.push(entry);
  }

  return {
    schemaVersion: 1,
    savedAt: Date.now(),
    envId: environmentManager.getCurrentEnvId?.() || dom.envSelect?.value || null,
    objects,
  };
}

function getCurrentRoomId() {
  return activeRoomCode || presenceState?.room || null;
}

function scheduleSaveRoomSnapshot(reason = 'unknown') {
  const roomId = getCurrentRoomId();
  if (!roomId) return;

  if (isRestoringRoomSnapshot && !hasSnapshotRestorableObjects()) {
    console.debug('[scene-snapshot] skip save during restore before objects are ready', {
      roomId,
      reason,
    });
    return;
  }

  clearTimeout(saveRoomSnapshotTimer);
  saveRoomSnapshotTimer = setTimeout(() => {
    saveRoomSnapshotTimer = null;
    saveCurrentRoomSnapshot(reason, roomId).catch((err) => {
      console.warn('[scene-snapshot] save failed:', err);
    });
  }, 500);
}

async function saveCurrentRoomSnapshot(reason = 'unknown', explicitRoomId = null) {
  const roomId = explicitRoomId || getCurrentRoomId();
  if (!roomId) return;

  const snapshot = createCurrentSceneSnapshot();
  await roomSnapshotCache.saveSnapshot(roomId, snapshot);

  console.debug('[scene-snapshot] saved', {
    roomId,
    objectCount: snapshot.objects.length,
    reason,
    savedAt: snapshot.savedAt,
  });
}

function hasOtherParticipants() {
  return presenceState.peers.some(peer => peer.id !== presenceState.id);
}

function scheduleMaybeRestoreRoomSnapshot(reason = 'unknown') {
  clearTimeout(restoreSnapshotTimer);
  restoreSnapshotTimer = setTimeout(() => {
    restoreSnapshotTimer = null;
    maybeRestoreRoomSnapshot(reason).catch((err) => {
      console.warn('[scene-snapshot] restore failed:', err);
    });
  }, 1200);
}

async function maybeRestoreRoomSnapshot(reason = 'unknown') {
  const roomId = getCurrentRoomId();
  if (!roomId) return;

  if (isSnapshotRestoreDisabled()) {
    console.warn('[SceneSync] room snapshot restore disabled by ?noRestore=1');
    return;
  }

  if (hasSnapshotRestorableObjects()) {
    console.debug('[scene-snapshot] skip restore: scene already has objects', {
      roomId,
      objectCount: managedObjects.size,
      reason,
    });
    return;
  }

  if (hasOtherParticipants()) {
    console.debug('[scene-snapshot] skip restore: other participants exist', {
      roomId,
      reason,
    });
    return;
  }

  if (!sceneReceived) {
    console.debug('[scene-snapshot] skip restore: scene state still pending', {
      roomId,
      reason,
    });
    return;
  }

  const record = await roomSnapshotCache.getSnapshot(roomId);
  const snapshot = record?.snapshot;
  if (!snapshot?.objects?.length) {
    console.debug('[scene-snapshot] no snapshot to restore', { roomId, reason });
    return;
  }

  console.info('[scene-snapshot] restoring local snapshot', {
    roomId,
    objectCount: snapshot.objects.length,
    savedAt: record.savedAt,
    reason,
  });

  await applyRoomSnapshot(snapshot, {
    roomId,
    source: 'indexeddb-room-snapshot',
  });
}

async function applyRoomSnapshot(snapshot, options = {}) {
  let restored = 0;
  let failed = 0;

  isRestoringRoomSnapshot = true;

  try {
    if (snapshot.envId) {
      if (dom.envSelect) dom.envSelect.value = snapshot.envId;
      if (mobileEnvSelect) mobileEnvSelect.value = snapshot.envId;
      environmentManager.loadEnvironment(snapshot.envId, {
        source: options.source || 'indexeddb-room-snapshot',
        broadcastChange: false,
      });
    }

    for (const entry of snapshot.objects || []) {
      try {
        restoreSnapshotObject(entry, options);
        restored++;
      } catch (err) {
        failed++;
        console.warn('[scene-snapshot] object restore failed', {
          objectId: entry?.objectId,
          name: entry?.name,
          err,
        });
      }
    }
  } finally {
    isRestoringRoomSnapshot = false;
  }

  console.info('[scene-snapshot] restore complete', {
    restored,
    failed,
  });

  if (restored > 0) {
    showToast?.(`前回のシーンの復元を開始しました（${restored}件）`);
    if (hasSnapshotRestorableObjects()) {
      notifySceneStateChanged('snapshot-restore');
    }
  }
}

function restoreSnapshotObject(entry, options = {}) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('invalid snapshot object');
  }

  const asset = safeCloneJson(entry.asset || null);
  const metadata = safeCloneJson(entry.metadata || null) || {};
  const meshPath = entry.meshPath || asset?.meshPath || null;
  const objectId = entry.objectId && !managedObjects.has(entry.objectId)
    ? entry.objectId
    : generateObjectId('restore');

  const payload = {
    kind: 'scene-add',
    objectId,
    name: entry.name || 'Restored Object',
    position: Array.isArray(entry.position) ? entry.position : [0, 0, 0],
    rotation: Array.isArray(entry.rotation) ? entry.rotation : [0, 0, 0, 1],
    scale: Array.isArray(entry.scale) ? entry.scale : [1, 1, 1],
    visible: typeof entry.visible === 'boolean' ? entry.visible : true,
    asset,
    meshPath,
    metadata: {
      ...metadata,
      restoredFromSnapshot: true,
      restoredAt: Date.now(),
      restoreSource: options.source || 'indexeddb-room-snapshot',
    },
  };

  if (entry.animation && typeof entry.animation === 'object') {
    payload.animation = safeCloneJson(entry.animation);
  }

  addOrUpdateObject(objectId, payload, {
    skipFallbackOnFailure: true,
    suppressSnapshotSaveOnFailure: true,
  });
}

function broadcastSelectedObjectAnimationDelta(delta) {
  const snapshot = buildSceneInspectorSnapshot();
  const { objectId, objectSnapshot } = buildSelectedObjectInspectorContext(snapshot);
  if (!objectId || !objectSnapshot) {
    showToast('オブジェクトを選択してください');
    return;
  }

  const obj = managedObjects.get(objectId);
  if (!obj) return;

  const clips = obj.userData?.scenesync?.animations;
  if (!Array.isArray(clips) || clips.length === 0) {
    showToast('選択中オブジェクトに animation clip がありません');
    return;
  }

  const operation = {
    kind: 'scene-delta',
    objectId,
    animation: delta,
  };

  applyOperationToScene(operation);
  broadcast(operation);
  notifySceneStateChanged('scene-inspector-animation-updated');
  notifySelectionChanged('scene-inspector-animation-updated');
}

function notifySceneStateChanged(reason) {
  notifyInspectorStateChanged(`scene:${reason}`);
  syncSceneUiState();
  scheduleSaveRoomSnapshot(reason);
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

function showPairingDialogLinked(expiresAtMs, { autoClose = false } = {}) {
  btnCancelPairing.textContent = '閉じる';
  btnCancelPairing.style.display = 'inline-block';
  btnRevokeLink.style.display = 'inline-block';
  pairingStepCode.style.display = 'none';
  pairingStepLinked.style.display = 'block';

  const autoCloseNote = document.getElementById('pairing-auto-close-note');
  if (autoCloseNote) {
    autoCloseNote.style.display = autoClose ? 'block' : 'none';
  }

  pairingDialog.style.display = 'flex';

  if (autoClose) {
    clearPairingCountdown();
    scheduleClosePairingDialogAfterLinked();
  }
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
  clearPairingCountdown();
  clearPairingAutoCloseTimer();
  pairingDialog.style.display = 'none';
}

async function revokeLink() {
  try {
    clearPairingAutoCloseTimer();
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

function updateMobileDevVisibility() {
  if (!mobileDevOpenBtn) return;
  mobileDevOpenBtn.hidden = !isDevUiEnabled();
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
function setMobilePeersOpen(open) {
  peersPanelEl?.classList.toggle('mobile-open', open);
  statusEl?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

statusEl?.addEventListener('click', () => {
  if (!isMobileUi()) return;
  const next = !peersPanelEl?.classList.contains('mobile-open');
  setMobilePeersOpen(Boolean(next));
});

document.addEventListener('click', (event) => {
  if (!isMobileUi()) return;
  if (!peersPanelEl?.classList.contains('mobile-open')) return;

  const target = event.target;
  if (!(target instanceof Node)) return;
  if (peersPanelEl.contains(target)) return;
  if (statusEl?.contains(target)) return;

  setMobilePeersOpen(false);
});
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

sceneInspectorAnimationEnabledEl?.addEventListener('change', () => {
  broadcastSelectedObjectAnimationDelta({
    enabled: !!sceneInspectorAnimationEnabledEl.checked,
  });
});

sceneInspectorAnimationClipEl?.addEventListener('change', () => {
  broadcastSelectedObjectAnimationDelta({
    clip: Number.parseInt(sceneInspectorAnimationClipEl.value, 10),
    mode: 'loop',
  });
});

sceneInspectorAnimationSpeedEl?.addEventListener('change', () => {
  broadcastSelectedObjectAnimationDelta({
    speed: Number(sceneInspectorAnimationSpeedEl.value),
  });
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

  if (!presenceState.linkManager.isLinked()) {
    clearPairingAutoCloseTimer();
    return;
  }

  const dialogOpen = pairingDialog?.style.display === 'flex';
  const wasWaitingForCode = pairingStepCode?.style.display !== 'none';

  if (dialogOpen && wasWaitingForCode) {
    showPairingDialogLinked(presenceState.linkManager.expiresAt, { autoClose: true });
  }
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
updateMobileDevVisibility();
if (mobileEnvSelect && dom.envSelect) {
  mobileEnvSelect.value = dom.envSelect.value;
}

// ── ウェルカムダイアログ ──────────────────────────────

const welcomeDialog = createWelcomeDialog({
  onStartInRoom: (displayName) => {
    const normalized = normalizeDisplayName(displayName);
    presenceState.nickname = normalized;
    localStorage.setItem('sceneSync.displayName', normalized);
    localStorage.setItem('sceneSync.welcomeSeen', 'true');
    updateNicknameLabel();
    updatePeersList();
    sendHelloIfConnected();
  },
  onCreateNewRoom: (displayName) => {
    const normalized = normalizeDisplayName(displayName);
    presenceState.nickname = normalized;
    localStorage.setItem('sceneSync.displayName', normalized);
    localStorage.setItem('sceneSync.welcomeSeen', 'true');
    updateNicknameLabel();
    generateRoom();
  },
});

function shouldShowWelcome() {
  const welcomeSeen = localStorage.getItem('sceneSync.welcomeSeen') === 'true';
  const displayName = normalizeDisplayName(localStorage.getItem('sceneSync.displayName'));
  return !welcomeSeen || !displayName;
}

function initializeWelcome() {
  if (shouldShowWelcome()) {
    const savedDisplayName = localStorage.getItem('sceneSync.displayName') || '';
    const explicitRoomCode = sanitizeRoomCode(new URLSearchParams(location.search).get('room'));
    welcomeDialog.open('first-run', savedDisplayName, {
      roomCode: explicitRoomCode || '',
    });
  }
}

function openHelpDialog() {
  const savedDisplayName = localStorage.getItem('sceneSync.displayName') || '';
  welcomeDialog.open('help', savedDisplayName);
}

// ── ルーム満員ダイアログ ──────────────────────────────

roomFullDialog?.addEventListener('click', (event) => {
  if (event.target === roomFullDialog) {
    // ダイアログの背景をクリックしても何もしない（ユーザーは選択を強要される）
  }
});

btnRoomFullRetry?.addEventListener('click', () => {
  reconnectBlockedReason = null;
  hideRoomFullDialog();
  connectPresence();
});

btnRoomFullNew?.addEventListener('click', () => {
  reconnectBlockedReason = null;
  hideRoomFullDialog();
  generateRoom();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && roomFullDialog?.style.display === 'flex') {
    // room_full の場合 Escape キーで閉じられない
  }
});

// ── 起動 ─────────────────────────────────────────────────

reportPreviousCrashProbe();
logDiagnosticFlags();

nicknameChip?.addEventListener('click', editNickname);
document.getElementById('help-btn')?.addEventListener('click', openHelpDialog);
updateNicknameLabel();
renderRoomSection();
syncSceneUiState();
initializeWelcome();
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
// ── Export ────────────────────────────────────────────────

async function triggerExport() {
  showToast('Exporting...');

  try {
    const behaviorState = loomIntegration?.exportState?.() ?? null;
    const { missingAssets } = await buildExportPackage({
      managedObjects,
      bgmState: serializeSceneBgm(),
      envId: environmentManager.getCurrentEnvId(),
      blobBase: BLOB_BASE,
      envOrigin: location.origin,
      assetCache,
      behaviorState,
    });

    if (missingAssets.length > 0) {
      showToast('Exported with missing assets', 4000);
    } else {
      showToast('Exported');
    }
  } catch (err) {
    console.error('[Export] failed:', err);
    showToast('Export failed');
  }
}

const exportBtn = document.getElementById('export-btn');
exportBtn?.addEventListener('click', triggerExport);

const mobileExportBtn = document.getElementById('mobile-export-btn');
mobileExportBtn?.addEventListener('click', () => {
  closeMobileActionSheet();
  triggerExport();
});

environmentManager.loadEnvironment('outdoor_day', {
  source: 'init',
  broadcastChange: false,
});
