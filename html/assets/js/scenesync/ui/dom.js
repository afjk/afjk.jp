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
    btnDelete: document.getElementById('btn-delete'),
    btnDeselect: document.getElementById('btn-deselect'),
    status: document.getElementById('status'),
    nicknameLabel: document.getElementById('nickname-label'),
    nicknameChip: document.getElementById('nickname-chip'),
    roomSection: document.getElementById('room-section'),
    peersList: document.getElementById('peers-list'),
    fileInput: document.getElementById('file-input'),
    dropOverlay: document.getElementById('drop-overlay'),
  };
}
