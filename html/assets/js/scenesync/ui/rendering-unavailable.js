import { getNotificationRegion } from './notification-layout.js';

export function showRenderingUnavailableNotice() {
  if (document.getElementById('scene-rendering-unavailable')) return;
  const notice = document.createElement('section');
  notice.id = 'scene-rendering-unavailable';
  notice.setAttribute('role', 'status');
  notice.style.cssText = 'padding:12px;border:1px solid #8e9bb5;border-radius:12px;background:#172033;color:#fff;font:14px/1.5 system-ui';
  notice.textContent = '3D描画を利用できないため、状態のみのモードで動作しています。入室・シーン同期・状態の編集は継続できます。画像取得・XR・画面上での配置は利用できません。描画を再試行するにはページを再読み込みしてください。';
  getNotificationRegion().append(notice);
  // Keep dropping a file onto the unavailable viewport from navigating away
  // from the room. Text editing and the state editor retain native paste.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
