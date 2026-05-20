export function detectSceneSyncDeviceMode() {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const maxTouchPoints = navigator.maxTouchPoints || 0;

  const isIPhoneOrIPod = /iPhone|iPod/.test(ua);
  const isIPad =
    /iPad/.test(ua) ||
    (platform === 'MacIntel' && maxTouchPoints > 1 && /Safari/.test(ua));

  const isAndroid = /Android/.test(ua);
  const isMobileUa = /Mobi/.test(ua);
  const isTabletUa = /Tablet/.test(ua);

  if (isIPhoneOrIPod || isIPad || isAndroid || isMobileUa || isTabletUa) {
    return 'mobile';
  }

  return 'desktop';
}

export function applySceneSyncDeviceMode(root = document.body) {
  const deviceMode = detectSceneSyncDeviceMode();

  root.dataset.sceneSyncDevice = deviceMode;
  root.classList.toggle('scene-sync-device-mobile', deviceMode === 'mobile');
  root.classList.toggle('scene-sync-device-desktop', deviceMode === 'desktop');

  console.info('[SceneSync] device mode', {
    deviceMode,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    width: window.innerWidth,
    height: window.innerHeight,
    hoverNone: window.matchMedia?.('(hover: none)').matches ?? null,
    pointerCoarse: window.matchMedia?.('(pointer: coarse)').matches ?? null,
  });

  return deviceMode;
}

export function isSceneSyncMobileDevice() {
  return document.body?.dataset?.sceneSyncDevice === 'mobile';
}
