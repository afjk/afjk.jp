// ── scene.js ─────────────────────────────────────────────
// Three.js ビューア + presence-server 接続
// ─────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// ── Three.js 基本セットアップ ────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x222222);

const camera = new THREE.PerspectiveCamera(
  60, innerWidth / innerHeight, 0.1, 1000
);
camera.position.set(5, 5, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

renderer.xr.enabled = true;
try {
  renderer.xr.setReferenceSpaceType('local-floor');
} catch (e) {
  console.warn('[XR] setReferenceSpaceType failed:', e);
}

const pmremGenerator = new THREE.PMREMGenerator(renderer);

// ライト（IBL 補助として残す）
scene.add(new THREE.AmbientLight(0xffffff, 0.3));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
dirLight.position.set(5, 10, 7);
scene.add(dirLight);

// グリッド（HDRI 背景でも視認できるよう明るめに）
scene.add(new THREE.GridHelper(20, 20, 0x888888, 0x666666));

// ── IBL 環境光 ───────────────────────────────────────────

let currentEnvId = 'outdoor_day';
const envSelect = document.getElementById('env-select');

function loadEnvironment(envId) {
  const url = '/assets/hdri/' + envId + '.hdr';
  new RGBELoader().load(url, (texture) => {
    const envMap = pmremGenerator.fromEquirectangular(texture).texture;
    scene.environment = envMap;
    scene.background = envMap;
    texture.dispose();
    currentEnvId = envId;
    updateEnvSelector();
  });
}

function updateEnvSelector() {
  if (envSelect) envSelect.value = currentEnvId;
}

envSelect?.addEventListener('change', (e) => {
  const envId = e.target.value;
  loadEnvironment(envId);
  broadcast({ kind: 'scene-env', envId });
});

// glB ローダー
const gltfLoader = new GLTFLoader();
const BLOB_BASE = location.hostname === 'localhost'
  ? 'http://localhost:8787/blob'
  : 'https://afjk.jp/presence/blob';

// ── WebXR ボタンセットアップ ────────────────────────────────
const xrButtonContainer = document.getElementById('xr-button-container');
const xrAddBtn = document.getElementById('add-btn');

// XR セッションへ入るためのモード状態
let xrCurrentMode = null;       // 'immersive-vr' | 'immersive-ar' | null
let xrPendingMode = null;       // 切り替え予約

if ('xr' in navigator && xrButtonContainer) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) return;
    const btn = VRButton.createButton(renderer);
    // ラベルを日本語化
    relabelXrButton(btn, 'VRで入る', 'VRを終了');
    btn.style.position = 'static';
    btn.style.transform = 'none';
    btn.style.left = 'auto';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    xrButtonContainer.appendChild(btn);
    xrAddBtn?.classList.add('xr-available');
  }).catch(() => {});

  navigator.xr.isSessionSupported('immersive-ar').then((ok) => {
    if (!ok) return;
    const btn = ARButton.createButton(renderer, {
      optionalFeatures: ['local-floor', 'hit-test', 'dom-overlay'],
      domOverlay: { root: document.body },
    });
    // ラベルを日本語化
    relabelXrButton(btn, 'MRで入る', 'MRを終了');
    btn.style.position = 'static';
    btn.style.transform = 'none';
    btn.style.left = 'auto';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    xrButtonContainer.appendChild(btn);
    xrAddBtn?.classList.add('xr-available');
  }).catch(() => {});
}

// VRButton / ARButton のテキストを書き換える
function relabelXrButton(btn, enterLabel, exitLabel) {
  const apply = () => {
    const t = btn.textContent || '';
    if (t.startsWith('ENTER') || t.includes('AR') || t.includes('VR')) {
      if (t.toUpperCase().includes('EXIT') || t.toUpperCase().includes('STOP')) {
        btn.textContent = exitLabel;
      } else if (t.toUpperCase().includes('ENTER')) {
        btn.textContent = enterLabel;
      }
    }
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(btn, { childList: true, characterData: true, subtree: true });
}

// ── XR コントローラー ──────────────────────────────────────
const xrState = {
  active: false,
  mode: null,
  // 各コントローラーごとの掴み状態（インデックス 0/1）
  grabbers: [
    { active: false, object: null,
      grabOffsetLocal: new THREE.Vector3(),
      initialObjectQuat: new THREE.Quaternion(),
      initialControllerYaw: 0 },
    { active: false, object: null,
      grabOffsetLocal: new THREE.Vector3(),
      initialObjectQuat: new THREE.Quaternion(),
      initialControllerYaw: 0 },
  ],
  // 両手掴み状態
  twoHand: {
    active: false,
    object: null,
    initialDistance: 1,
    initialDirYaw: 0,
    initialObjectScale: new THREE.Vector3(1, 1, 1),
    initialObjectQuat: new THREE.Quaternion(),
    initialOffsetFromMidpoint: new THREE.Vector3(),
  },
  twoHandedFreeRotation: false,  // true: 6DoF, false: Y軸ロック
  lastSent: 0,
  lockOwnedByMe: new Set(),      // lock 発行済み objectId
  // AR床補正
  floor: {
    referenceSpace: null,           // 元の reference space
    offsetSpace: null,              // オフセット適用後の reference space
    estimatedFloorY: null,          // 推定床Y（カメラ空間内、負の値）
    hitTestSource: null,            // viewer XRHitTestSource（フォールバック）
    viewerSpace: null,              // viewer reference space
    controllerHitTestSources: new Map(), // コントローラー別 XRHitTestSource
    reticle: null,                  // レチクル mesh
    lastHitPose: null,              // 直近のヒット位置・姿勢
    lastHitY: null,                 // 直近のヒット位置Y座標
    stableHitCount: 0,              // 連続ヒット回数（床高さ確定用）
    floorConfirmed: false,          // 床高さが安定確定したか
    calibrating: false,             // 床合わせモード中か
  },
  controllers: [],
};

// クォータニオンから Y軸回転（ヨー）成分のみを抽出する
function extractYaw(quat) {
  const x = quat.x, y = quat.y, z = quat.z, w = quat.w;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x));
}

const SCALE_MIN_RATIO = 0.05;
const SCALE_MAX_RATIO = 50;
const XR_INITIAL_HEAD_HEIGHT = 1.3;

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
    ? { optionalFeatures: ['local-floor', 'hit-test', 'dom-overlay'], domOverlay: { root: document.body } }
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

// ── AR hit-test レチクル ─────────────────────────────────
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
  return reticle;
}

xrState.floor.reticle = createReticle();
scene.add(xrState.floor.reticle);

const xrTmpMatrix = new THREE.Matrix4();
const xrRaycaster = new THREE.Raycaster();

function onXrSelectStart(ctrl) {
  // 床合わせモード中ならトリガーで床確定
  if (xrState.floor.calibrating) {
    confirmFloorCalibration();
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
      broadcastObjectDelta(obj);
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

function broadcastObjectDelta(obj) {
  if (!obj?.userData?.objectId) return;
  const wp = new THREE.Vector3();
  const wq = new THREE.Quaternion();
  const ws = new THREE.Vector3();
  obj.getWorldPosition(wp);
  obj.getWorldQuaternion(wq);
  obj.getWorldScale(ws);

  const pos = wp.toArray();
  if (!isFinite(pos[0]) || !isFinite(pos[1]) || !isFinite(pos[2])) return;

  broadcast({
    kind: 'scene-delta',
    objectId: obj.userData.objectId,
    position: pos,
    rotation: [wq.x, wq.y, wq.z, wq.w],
    scale: ws.toArray(),
  });
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
      broadcastObjectDelta(xrState.twoHand.object);
      sentIds.add(id);
    }
  } else {
    for (const grabber of xrState.grabbers) {
      if (!grabber.active || !grabber.object) continue;
      const id = grabber.object.userData?.objectId;
      if (id && !sentIds.has(id)) {
        broadcastObjectDelta(grabber.object);
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

// ── XR 床補正関数 ─────────────────────────────────────

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

// 床合わせモード中にトリガーが押された時の処理
function confirmFloorCalibration() {
  if (!xrState.floor.calibrating) return false;
  if (xrState.floor.lastHitY === null) {
    showToast('床を指してください');
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

  updateXrCalibrationButton();
  return true;
}

// 床合わせモードを再開
function startFloorCalibration() {
  if (xrState.mode !== 'immersive-ar') {
    showToast('床合わせはMRモードでのみ使用できます');
    return;
  }
  xrState.floor.calibrating = true;
  xrState.floor.floorConfirmed = false;
  showToast('床を指してトリガーを押してください');
  updateXrCalibrationButton();
}

function updateXrCalibrationButton() {
  const btn = document.getElementById('xr-calibrate-btn');
  if (!btn) return;

  // MRセッション中かつ床合わせモードでない時のみ表示
  if (xrState.active && xrState.mode === 'immersive-ar' && !xrState.floor.calibrating) {
    btn.style.display = 'inline-flex';
    btn.onclick = startFloorCalibration;
  } else {
    btn.style.display = 'none';
  }
}

// ── XR セッション開始/終了 ─────────────────────────────
let xrSavedBackground = null;

renderer.xr.addEventListener('sessionstart', async () => {
  xrState.active = true;
  const session = renderer.xr.getSession();
  // requestXrSession 経由で開始した場合は xrCurrentMode が設定済み
  // それ以外（VRButton/ARButton 直接クリック）は blendMode で推定
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

  // AR の場合は背景を透過
  if (xrState.mode === 'immersive-ar') {
    xrSavedBackground = scene.background;
    scene.background = null;
  }

  // dom-overlay 用トグルボタンの表示制御
  const xrToggleBtn = document.getElementById('xr-toggle-btn');
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

  // ── 床補正と hit-test 初期化 ──
  xrState.floor.estimatedFloorY = null;
  xrState.floor.stableHitCount = 0;
  xrState.floor.floorConfirmed = false;
  xrState.floor.lastHitPose = null;
  xrState.floor.hitTestSource = null;
  xrState.floor.viewerSpace = null;

  // 元の reference space を保存
  xrState.floor.referenceSpace = renderer.xr.getReferenceSpace();

  // 起動時は仮の頭の高さで初期化
  applyFloorOffset(XR_INITIAL_HEAD_HEIGHT);

  // MR/AR の場合は床合わせモードを自動開始
  if (xrState.mode === 'immersive-ar') {
    xrState.floor.calibrating = true;
    xrState.floor.floorConfirmed = false;
    showToast('床を指してトリガーを押してください');
  } else {
    // VR では床合わせ不要
    xrState.floor.calibrating = false;
  }

  // hit-test source を作成（AR/MRのみ）
  if (xrState.mode === 'immersive-ar') {
    // viewer（頭方向）フォールバック用
    try {
      xrState.floor.viewerSpace = await session.requestReferenceSpace('viewer');
      xrState.floor.hitTestSource = await session.requestHitTestSource({
        space: xrState.floor.viewerSpace,
      });
    } catch (e) {
      console.warn('[XR] viewer hit-test not available:', e);
    }

    // コントローラーが追加されたらその targetRaySpace でも hit-test を作成
    xrState.floor.controllerHitTestSources.clear();
    session.addEventListener('inputsourceschange', ({ added, removed }) => {
      for (const source of removed) {
        const src = xrState.floor.controllerHitTestSources.get(source);
        if (src) { try { src.cancel(); } catch {} xrState.floor.controllerHitTestSources.delete(source); }
      }
      for (const source of added) {
        if (!source.targetRaySpace) continue;
        session.requestHitTestSource({ space: source.targetRaySpace })
          .then(src => {
            xrState.floor.controllerHitTestSources.set(source, src);
            console.log('[XR] controller hit-test source created:', source.handedness);
          })
          .catch(() => {});
      }
    });
  }

  // 床合わせボタンの表示更新
  updateXrCalibrationButton();

  console.log('[XR] session started:', {
    mode: xrState.mode,
    calibrating: xrState.floor.calibrating,
    hitTestSource: !!xrState.floor.hitTestSource,
  });
});

renderer.xr.addEventListener('sessionend', () => {
  // トグルボタンと床合わせボタンを隠す
  const xrToggleBtn = document.getElementById('xr-toggle-btn');
  if (xrToggleBtn) xrToggleBtn.style.display = 'none';
  const xrCalibrateBtn = document.getElementById('xr-calibrate-btn');
  if (xrCalibrateBtn) xrCalibrateBtn.style.display = 'none';

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
      broadcastObjectDelta(obj);
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
    } else if (currentEnvId) {
      loadEnvironment(currentEnvId);
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

  // 床補正 / hit-test のクリーンアップ
  xrState.floor.reticle.visible = false;
  if (xrState.floor.hitTestSource) {
    try { xrState.floor.hitTestSource.cancel(); } catch {}
    xrState.floor.hitTestSource = null;
  }
  for (const src of xrState.floor.controllerHitTestSources.values()) {
    try { src.cancel(); } catch {}
  }
  xrState.floor.controllerHitTestSources.clear();
  xrState.floor.calibrating = false;
  xrState.floor.viewerSpace = null;
  xrState.floor.referenceSpace = null;
  xrState.floor.offsetSpace = null;
  xrState.floor.estimatedFloorY = null;
  xrState.floor.lastHitPose = null;
  xrState.floor.stableHitCount = 0;
  xrState.floor.floorConfirmed = false;
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

transformCtrl.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  isDragging = e.value;

  if (isDragging) {
    dragIntervalId = setInterval(() => {
      sendSelectedDelta();
    }, 50);
  } else {
    clearInterval(dragIntervalId);
    dragIntervalId = null;
    sendSelectedDelta();
  }
});

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

// ── アバター管理 ──────────────────────────────────────
// peerId → { group, head, left, right, label, targetHead, targetLeft, targetRight, lastSeen, mode, nickname, ... }
const remoteAvatars = new Map();
const AVATAR_PALETTE = [0xff6b6b, 0xfeca57, 0x48dbfb, 0x1dd1a1, 0x5f27cd, 0xff9ff3, 0x54a0ff, 0xee5253];

function colorFromPeerId(peerId) {
  let h = 0;
  for (let i = 0; i < peerId.length; i++) {
    h = (h * 31 + peerId.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

function makeNicknameSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 32px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.fillText(text || '', canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.4, 0.1, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function ensureRemoteAvatar(peerId, nickname) {
  let av = remoteAvatars.get(peerId);
  if (av) {
    if (nickname && av.nickname !== nickname) {
      av.nickname = nickname;
      av.head.remove(av.label);
      av.label.material.map.dispose();
      av.label.material.dispose();
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
  eyeR.position.set( 0.035, 0.02, -0.105);
  head.add(eyeL, eyeR);

  const label = makeNicknameSprite(nickname || peerId.slice(0, 6));
  label.position.set(0, 0.22, 0);
  head.add(label);

  const group = new THREE.Group();
  group.name = `avatar:${peerId}`;
  group.add(head, left, right);
  scene.add(group);

  av = {
    group, head, left, right, label,
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

function disposeRemoteAvatar(peerId) {
  const av = remoteAvatars.get(peerId);
  if (!av) return;
  scene.remove(av.group);
  av.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
  remoteAvatars.delete(peerId);
}

function disposeAllRemoteAvatars() {
  for (const peerId of Array.from(remoteAvatars.keys())) {
    disposeRemoteAvatar(peerId);
  }
}

// objectId → wireframe mesh
const lockOverlays = new Map();

// ── トースト通知 ────────────────────────────────────────

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
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
    broadcast({ kind: 'scene-remove', objectId: deleteId });
  }
}

// ── モバイルツールバー ──────────────────────────────────

const toolbar = document.getElementById('mobile-toolbar');
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
});

btnDelete?.addEventListener('click', () => {
  deleteSelectedObject();
});

// ── キーボードショートカット ──────────────────────────────

window.addEventListener('keydown', (e) => {
  // テキスト入力中は無視
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

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

// ── AR hit-test 毎フレーム更新 ─────────────────────────
function updateXrHitTest(frame) {
  const reticle = xrState.floor.reticle;
  if (!reticle) return;

  // 床合わせモード中でなければレチクルを隠す
  if (!xrState.floor.calibrating) {
    reticle.visible = false;
    xrState.floor.lastHitY = null;
    return;
  }

  if (!frame) {
    reticle.visible = false;
    return;
  }

  const refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) {
    reticle.visible = false;
    return;
  }

  // コントローラーの targetRaySpace によるヒットテストを優先
  let hitPose = null;
  for (const [, src] of xrState.floor.controllerHitTestSources) {
    const results = frame.getHitTestResults(src);
    if (results.length > 0) {
      const p = results[0].getPose(refSpace);
      if (p) { hitPose = p; break; }
    }
  }

  if (!hitPose) {
    reticle.visible = false;
    return;
  }

  // レチクル位置・姿勢を更新
  reticle.matrix.fromArray(hitPose.transform.matrix);
  reticle.visible = true;

  // ヒットY座標を保存（confirmFloorCalibration で使用）
  xrState.floor.lastHitPose = hitPose;
  xrState.floor.lastHitY = hitPose.transform.position.y;

  // デバッグ: 頻度を抑えてログ出力
  if (Math.random() < 0.02) {
    console.log('[XR] hit:', xrState.floor.lastHitY);
  }
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
  updateRemoteAvatars(time);

  renderer.render(scene, camera);
});

// ── Presence 接続 ────────────────────────────────────────

const statusEl = document.getElementById('status');
const dotEl = statusEl.querySelector('.dot');
const nicknameLabel = document.getElementById('nickname-label');
const nicknameChip = document.getElementById('nickname-chip');
const roomSectionEl = document.getElementById('room-section');

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

const presenceState = {
  ws: null,
  id: null,
  room: null,
  nickname: loadInitialNickname(),
  peers: [],
};

let activeRoomCode = sanitizeRoomCode(new URLSearchParams(location.search).get('room'));
let sceneReceived = false;
let sceneRequestTimer = null;
let sceneRequestAttempt = 0;
let reconnectTimer = null;

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
        for (const peerId of remoteAvatars.keys()) {
          if (!peerIds.has(peerId)) disposeRemoteAvatar(peerId);
        }
        updatePeersList();
        // 初回 peers 受信時にシーンリクエスト
        if (isFirstPeers && !sceneReceived) {
          requestSceneFromPeer();
        }
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
    disposeAllRemoteAvatars();
    updatePeersList();
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
    ws.send(JSON.stringify({
      type: 'handoff',
      targetId: from.id,
      payload: { kind: 'scene-state', envId: currentEnvId, objects },
    }));
  }
}

// ── Handoff 受信（Scene Sync 用） ────────────────────────

function handleSceneAvatar(payload, from) {
  if (!payload || !payload.peerId) return;
  if (payload.peerId === presenceState.id) return;
  if (!payload.head || !Array.isArray(payload.head.p) || !Array.isArray(payload.head.q)) return;

  const av = ensureRemoteAvatar(payload.peerId, payload.nickname);
  av.lastSeen = performance.now();
  av.mode = payload.mode || 'vr';

  av.targetHead.p.set(payload.head.p[0], payload.head.p[1], payload.head.p[2]);
  av.targetHead.q.set(payload.head.q[0], payload.head.q[1], payload.head.q[2], payload.head.q[3]);
  av.targetHead.set = true;

  const applyHand = (target, src) => {
    if (src && src.active && Array.isArray(src.p) && Array.isArray(src.q)) {
      target.p.set(src.p[0], src.p[1], src.p[2]);
      target.q.set(src.q[0], src.q[1], src.q[2], src.q[3]);
      target.set = true;
      return true;
    }
    return false;
  };

  av.leftActive = applyHand(av.targetLeft, payload.left);
  av.rightActive = applyHand(av.targetRight, payload.right);

  if (av.mode === 'desktop') {
    av.leftActive = false;
    av.rightActive = false;
  }
}

function updateRemoteAvatars(nowMs) {
  const lerpAlpha = 0.25;

  for (const [peerId, av] of remoteAvatars) {
    if (performance.now() - av.lastSeen > AVATAR_TIMEOUT_MS) {
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

function handleHandoff(data) {
  const payload = data.payload;
  if (!payload || !payload.kind) return;

  switch (payload.kind) {
    case 'scene-state': {
      sceneReceived = true;
      clearTimeout(sceneRequestTimer);
      if (payload.envId) {
        loadEnvironment(payload.envId);
      }
      const objects = payload.objects || {};
      for (const [objectId, info] of Object.entries(objects)) {
        addOrUpdateObject(objectId, info);
      }
      break;
    }
    case 'scene-request': {
      respondToSceneRequest(data.from);
      break;
    }
    case 'scene-delta': {
      if (data.from.id === presenceState.id) break; // 自分の echo は無視
      const obj = managedObjects.get(payload.objectId);
      if (!obj) break;
      if (payload.position) obj.position.fromArray(payload.position);
      if (payload.rotation) obj.quaternion.fromArray(payload.rotation);
      if (payload.scale) obj.scale.fromArray(payload.scale);
      break;
    }
    case 'scene-add': {
      addOrUpdateObject(payload.objectId, payload);
      break;
    }
    case 'scene-remove': {
      const objectId = payload.objectId;
      removeLockOverlay(objectId);
      locks.delete(objectId);
      const obj = managedObjects.get(objectId);
      if (obj) {
        if (transformCtrl.object === obj) { transformCtrl.detach(); hideToolbar(); }
        scene.remove(obj);
        managedObjects.delete(objectId);
      }
      break;
    }
    case 'scene-mesh': {
      const obj = managedObjects.get(payload.objectId);
      const url = BLOB_BASE + '/' + payload.meshPath;
      const loadingName = obj?.userData?.name || payload.meshPath;
      const loadingInfo = obj ? {
        position: obj.position.toArray(),
        rotation: obj.quaternion.toArray(),
        scale: obj.scale.toArray(),
      } : null;
      addLoadingOverlay(payload.objectId, loadingName, loadingInfo);
      gltfLoader.load(url, (gltf) => {
        removeLoadingOverlay(payload.objectId);
        const model = new THREE.Group();
        model.userData.objectId = payload.objectId;
        model.userData.meshPath = payload.meshPath;
        attachImportedGlb(model, gltf);

        if (obj) {
          // 位置・回転・スケールを引き継ぐ
          model.position.copy(obj.position);
          model.quaternion.copy(obj.quaternion);
          model.scale.copy(obj.scale);
          if (transformCtrl.object === obj) transformCtrl.detach();
          scene.remove(obj);
        }
        scene.add(model);
        managedObjects.set(payload.objectId, model);
      }, undefined, (err) => {
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
        }
      });
      break;
    }
    case 'scene-lock': {
      locks.set(payload.objectId, data.from);
      addLockOverlay(payload.objectId, data.from);
      updatePeersList();
      break;
    }
    case 'scene-unlock': {
      locks.delete(payload.objectId);
      removeLockOverlay(payload.objectId);
      updatePeersList();
      break;
    }
    case 'scene-env': {
      if (payload.envId) {
        loadEnvironment(payload.envId);
      }
      break;
    }
    case 'scene-avatar': {
      handleSceneAvatar(payload, data.from);
      break;
    }
    default:
      break;
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

  existing.userData.name = info.name;
  applyTransform(existing, info);
}

function loadMeshObject(objectId, info, meshPath, existing) {
  addLoadingOverlay(objectId, info.name || objectId, info);
  const url = BLOB_BASE + '/' + meshPath;
  gltfLoader.load(url, (gltf) => {
    removeLoadingOverlay(objectId);

    const model = new THREE.Group();
    model.userData.objectId = objectId;
    model.userData.name = info.name;
    model.userData.meshPath = meshPath;
    if (info.asset) model.userData.asset = structuredClone(info.asset);
    attachImportedGlb(model, gltf);

    replaceManagedObject(objectId, model, info);
  }, undefined, (err) => {
    removeLoadingOverlay(objectId);
    console.warn('Failed to load mesh for', objectId, ':', err);
    if (!existing) {
      replaceManagedObject(objectId, buildDefaultBoxObject(objectId, info, 0xff4444), info);
    }
  });
}

function replaceManagedObject(objectId, nextObject, info) {
  const current = managedObjects.get(objectId);
  if (current) {
    if (transformCtrl.object === current) transformCtrl.detach();
    scene.remove(current);
  }

  nextObject.userData.objectId = objectId;
  nextObject.userData.name = info.name;
  applyTransform(nextObject, info);
  scene.add(nextObject);
  managedObjects.set(objectId, nextObject);
}

function buildDefaultBoxObject(objectId, info, color = 0x4488ff) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color });
  const object = new THREE.Mesh(geometry, material);
  object.userData.objectId = objectId;
  object.userData.name = info.name;
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
  object.userData.name = info.name;
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
  group.userData.name = info.name;
  if (info.asset) group.userData.asset = structuredClone(info.asset);
  return group;
}

function applyTransform(obj, info) {
  if (info.position) obj.position.fromArray(info.position);
  if (info.rotation) obj.quaternion.fromArray(info.rotation);
  if (info.scale) obj.scale.fromArray(info.scale);
}

function attachImportedGlb(wrapper, gltf) {
  // glB 経路だけ handedness 補正と wire の Z 反転が重なり、
  // 見た目が Y 軸 180° ずれるため、読み込み基底に補正を入れる。
  gltf.scene.rotateY(Math.PI);
  wrapper.add(gltf.scene);
}

// ── broadcast 送信ヘルパー（次 Step 以降で使用） ─────────

function broadcast(payload) {
  const ws = presenceState.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'broadcast', payload }));
}

// ── 公開 API（scene.js 内から利用） ──────────────────────

export { scene, camera, renderer, managedObjects, broadcast, presenceState };

// ── ファイル追加 UI ──────────────────────────────────────

const addBtn = document.getElementById('add-btn');
const fileInput = document.getElementById('file-input');
const dropOverlay = document.getElementById('drop-overlay');

addBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleAddMeshFile(file);
  fileInput.value = '';
});

let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.add('active');
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.remove('active');
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('active');
  const file = e.dataTransfer.files[0];
  if (file && (file.name.endsWith('.glb') || file.name.endsWith('.gltf'))) {
    handleAddMeshFile(file);
  }
});

function generateObjectId() {
  return 'web-' + Math.random().toString(36).slice(2, 10);
}

function generateRandomPath() {
  return Math.random().toString(36).slice(2, 10);
}

async function handleAddMeshFile(file) {
  const objectId = generateObjectId();

  // カメラ前方 5m を配置予定位置として先にローディング表示
  const placeDir = new THREE.Vector3();
  camera.getWorldDirection(placeDir);
  const placePos = new THREE.Vector3()
    .copy(camera.position)
    .addScaledVector(placeDir, 5);
  placePos.y = 0;
  addLoadingOverlay(objectId, file.name, { position: placePos.toArray() });

  const arrayBuffer = await file.arrayBuffer();

  const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
  const blobUrl = URL.createObjectURL(blob);

  gltfLoader.load(blobUrl, async (gltf) => {
    removeLoadingOverlay(objectId);
    const model = new THREE.Group();
    model.userData.objectId = objectId;
    model.userData.name = file.name;
    attachImportedGlb(model, gltf);

    // center offset は行わない（glB の原点をそのまま使用）
    // Unity 側との座標整合性を保つため

    model.position.copy(placePos);

    scene.add(model);
    managedObjects.set(objectId, model);
    selectManagedObject(model);

    URL.revokeObjectURL(blobUrl);

    // 元ファイルをそのままアップロード（受信側で中心合わせを行う）
    uploadAndBroadcast(
      objectId,
      file.name,
      model,
      arrayBuffer
    );
  }, undefined, (err) => {
    removeLoadingOverlay(objectId);
    console.error('Failed to load glB:', err);
    URL.revokeObjectURL(blobUrl);
  });
}

async function uploadAndBroadcast(objectId, name, model, arrayBuffer) {
  // blob store に POST（1回だけ）
  const meshPath = generateRandomPath();
  try {
    await fetch(BLOB_BASE + '/' + meshPath, {
      method: 'POST',
      headers: { 'Content-Type': 'model/gltf-binary' },
      body: arrayBuffer,
    });
  } catch (err) {
    console.warn('POST failed:', err);
    broadcast({
      kind: 'scene-add',
      objectId,
      name,
      position: model.position.toArray(),
      rotation: model.quaternion.toArray(),
      scale: model.scale.toArray(),
      meshPath: null,
    });
    return;
  }

  // meshPath をオブジェクトに保存（respondToSceneRequest で再利用）
  model.userData.meshPath = meshPath;

  broadcast({
    kind: 'scene-add',
    objectId,
    name,
    position: model.position.toArray(),
    rotation: model.quaternion.toArray(),
    scale: model.scale.toArray(),
    meshPath,
  });
}

// ── 3面ビュー撮影 ────────────────────────────────────────


// ── 起動 ─────────────────────────────────────────────────

nicknameChip?.addEventListener('click', editNickname);
updateNicknameLabel();
renderRoomSection();
connectPresence();
loadEnvironment('outdoor_day');
