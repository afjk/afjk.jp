import { mountSceneSyncShell } from '../shells/shell-bootstrap.js';

let sceneSyncShellMountPromise = null;

export function mountSceneSyncShellFromDom() {
  if (!sceneSyncShellMountPromise) {
    sceneSyncShellMountPromise = mountSceneSyncShell().catch((error) => {
      console.warn('[SceneSyncShell] failed to mount shell:', error);
      return null;
    });
  }
  return sceneSyncShellMountPromise;
}

export function getSceneSyncDom() {
  mountSceneSyncShellFromDom();

  return {
    envSelect: document.getElementById('env-select'),
    xrButtonContainer: document.getElementById('xr-button-container'),
    addBtn: document.getElementById('add-btn'),
    xrToggleBtn: document.getElementById('xr-toggle-btn'),
    xrCalibrateBtn: document.getElementById('xr-calibrate-btn'),
    toast: document.getElementById('toast'),
    mobileToolbar: document.getElementById('mobile-toolbar'),
    btnMove: document.getElementById('btn-move'),
    btnRotate: document.getElementById('btn-rotate'),
    btnScale: document.getElementById('btn-scale'),
    btnCopy: document.getElementById('btn-copy'),
    btnDelete: document.getElementById('btn-delete'),
    btnDeselect: document.getElementById('btn-deselect'),
    status: document.getElementById('status'),
    nicknameLabel: document.getElementById('nickname-label'),
    nicknameChip: document.getElementById('nickname-chip'),
    roomSection: document.getElementById('room-section'),
    peersPanel: document.getElementById('peers-panel'),
    peersList: document.getElementById('peers-list'),
    fileInput: document.getElementById('file-input'),
    mobileImageInput: document.getElementById('mobile-image-input'),
    mobileGlbInput: document.getElementById('mobile-glb-input'),
    dropOverlay: document.getElementById('drop-overlay'),
    deleteSkyboxBtn: document.getElementById('delete-skybox-btn'),
    bgmUnlockButton: document.getElementById('bgm-unlock-button'),
    clearBgmButton: document.getElementById('clear-bgm-btn'),
  };
}
