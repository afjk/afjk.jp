import { createSceneSyncShellRuntimeManager } from '../shells/shell-bootstrap.js';

let sceneSyncShellRuntimePromise = null;
let sceneSyncShellRuntime = null;

function removeRetiredPayloadTesterLink() {
  const link = document.querySelector('#scene-inspector-panel a[href="/scenesync/dev-tool/"]');
  link?.remove();
}

export function mountSceneSyncShellFromDom(core = {}) {
  removeRetiredPayloadTesterLink();

  if (!sceneSyncShellRuntimePromise) {
    sceneSyncShellRuntimePromise = createSceneSyncShellRuntimeManager(core)
      .then((runtime) => {
        sceneSyncShellRuntime = runtime;

        if (typeof window !== 'undefined') {
          window.sceneSyncShell = {
            async switchTo(shellId, options) {
              return runtime.switchShell(shellId, options);
            },
            current() {
              return runtime.getCurrentShellId();
            },
            list() {
              return runtime.listShellIds();
            },
          };
        }

        return runtime;
      })
      .catch((error) => {
        console.warn('[SceneSyncShell] failed to mount shell runtime:', error);
        return null;
      });
  }
  return sceneSyncShellRuntimePromise;
}

export function getSceneSyncShellRuntime() {
  return sceneSyncShellRuntime;
}

export function getSceneSyncDom() {
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
