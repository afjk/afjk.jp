import { VRButton } from 'three/addons/webxr/VRButton.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';

export function setupXrButtons(ctx) {
  const {
    renderer,
    dom,
  } = ctx;

  const xrButtonContainer = dom?.xrButtonContainer;
  const xrAddBtn = dom?.addBtn;

  if (!('xr' in navigator) || !xrButtonContainer) {
    return;
  }

  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) return;

    const btn = VRButton.createButton(renderer);
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

export function relabelXrButton(btn, enterLabel, exitLabel) {
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
