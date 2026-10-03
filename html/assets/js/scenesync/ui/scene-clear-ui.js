export function createSceneClearUi({ THREE, scene, request, cancel, now = Date.now }) {
  const style = document.createElement('style');
  style.textContent = `
    #scene-clear-button{position:fixed;right:12px;bottom:calc(80px + env(safe-area-inset-bottom));z-index:85;border:1px solid #57617a;border-radius:12px;background:#172033ed;color:#fff;padding:10px 14px;font:13px system-ui;min-height:44px}
    #scene-clear-notice{position:fixed;left:50%;top:calc(70px + env(safe-area-inset-top));transform:translateX(-50%);z-index:12000;width:min(360px,calc(100vw - 24px));box-sizing:border-box;background:#172033;color:#fff;border:1px solid #8e9bb5;border-radius:16px;padding:18px;box-shadow:0 8px 36px #0008;font:15px/1.6 system-ui}
    #scene-clear-notice[hidden]{display:none}#scene-clear-notice p{margin:0 0 12px;overflow-wrap:anywhere}#scene-clear-notice button{min-height:44px;padding:9px 18px;border:0;border-radius:10px;font:inherit;margin-right:8px;background:#e8edf8;color:#172033}
    body.scenesync-xr #scene-clear-button{display:none}
  `;
  document.head.append(style);
  const button = document.createElement('button');
  button.id = 'scene-clear-button'; button.textContent = 'シーンをクリア';
  button.disabled = true; button.addEventListener('click', () => request());
  const notice = document.createElement('section');
  notice.id = 'scene-clear-notice'; notice.hidden = true; notice.setAttribute('role', 'status');
  const text = document.createElement('p');
  const actions = document.createElement('div');
  notice.append(text, actions); document.body.append(button, notice);
  let pending = null, restore = null, offset = 0, lastLabel = '';
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 384;
  const texture = new THREE.CanvasTexture(canvas);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.3, .49), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
  panel.renderOrder = 10000; panel.visible = false; panel.name = 'scene-clear-xr-notice';
  panel.userData.nonSerializable = true; scene.add(panel);
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion();
  function action(label, handler, id) {
    const b = document.createElement('button'); b.textContent = label; b.dataset.sceneAction = id;
    b.addEventListener('click', handler); actions.append(b);
  }
  function cancelPending() { if (pending) cancel(pending.requestId); }
  function finishRestore(answer) {
    const resolve = restore; restore = null;
    notice.hidden = !pending; actions.replaceChildren(); resolve?.(answer);
  }
  function render() {
    if (!pending) return;
    const seconds = Math.max(0, Math.ceil((pending.deadline - (now() + offset)) / 1000));
    const label = `${pending.actorName} がシーンをクリアします（${seconds}秒）`;
    if (label !== lastLabel) {
      text.textContent = label;
      lastLabel = label;
      const g = canvas.getContext('2d'); g.clearRect(0, 0, 1024, 384);
      g.fillStyle = '#172033'; g.fillRect(0, 0, 1024, 384);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = '42px sans-serif';
      g.fillText(`${pending.actorName}`.slice(0, 22), 512, 85);
      g.fillText(`シーンをクリアします（${seconds}秒）`, 512, 165);
      g.fillStyle = '#dce8ff'; g.font = '38px sans-serif';
      g.fillText('トリガー / ピンチでキャンセル', 512, 285); texture.needsUpdate = true;
    }
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (pending) { event.preventDefault(); event.stopImmediatePropagation(); cancelPending(); }
    else if (restore) finishRestore(false);
  }, true);
  return {
    setReady(ready) { button.disabled = !ready || !!pending; },
    setPending(next, serverTime) {
      if (restore && next) finishRestore(false);
      pending = next; lastLabel = ''; offset = Number.isFinite(serverTime) ? serverTime - now() : offset;
      if (!restore) { notice.hidden = !next; actions.replaceChildren(); }
      if (next) { action('キャンセル', cancelPending, 'cancel-clear'); render(); }
    },
    askRestore() {
      finishRestore(false); notice.hidden = false; text.textContent = '前回のシーンを復元しますか？';
      return new Promise(resolve => {
        restore = resolve;
        action('復元する', () => finishRestore(true), 'restore-yes');
        action('復元しない', () => finishRestore(false), 'restore-no');
      });
    },
    cancelRestore() { if (restore) finishRestore(false); },
    consumeXrSelect() { if (!pending) return false; cancelPending(); return true; },
    updateXr(camera, active) {
      render(); panel.visible = !!pending && active;
      if (!panel.visible) return;
      camera.getWorldPosition(position); camera.getWorldQuaternion(quaternion);
      panel.position.set(0, .1, -1.6).applyQuaternion(quaternion).add(position);
      panel.quaternion.copy(quaternion);
    },
  };
}
