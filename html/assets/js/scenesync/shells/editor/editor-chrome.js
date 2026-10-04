// Editor chrome の DOM 反映を一手に担うモジュール。
// core は状態（getEditorState）と通知（onStateChange）のみを提供し、
// #mobile-toolbar / #history-toolbar の実際の DOM 更新と
// undo/redo のクリック配線はここ（editor shell 側）で行う。
// desktop / mobile どちらの layout からも mount して共有する。

function addListener(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

export function createEditorChrome(core) {
  const els = {
    toolbar: document.getElementById('mobile-toolbar'),
    btnMove: document.getElementById('btn-move'),
    btnRotate: document.getElementById('btn-rotate'),
    btnScale: document.getElementById('btn-scale'),
    btnFocus: document.getElementById('btn-focus'),
    btnCopy: document.getElementById('btn-copy'),
    btnDelete: document.getElementById('btn-delete'),
    btnUndo: document.getElementById('btn-undo'),
    btnRedo: document.getElementById('btn-redo'),
    sceneMenu: document.getElementById('editor-scene-menu'),
    roomSettings: document.getElementById('editor-room-open-btn'),
    exportScene: document.getElementById('export-btn'),
    aiLink: document.getElementById('link-btn'),
    help: document.getElementById('help-btn'),
    mobileDev: document.getElementById('mobile-dev-open-btn'),
    clearScene: document.getElementById('editor-scene-clear'),
  };

  const disposers = [];
  let removeStateListener = null;

  function render() {
    const s = core?.getEditorState?.() || {};

    // #mobile-toolbar 表示/非表示
    if (els.toolbar) {
      els.toolbar.style.display = s.toolbarVisible ? 'flex' : 'none';
    }

    // transform ツールの active
    for (const b of [els.btnMove, els.btnRotate, els.btnScale]) b?.classList.remove('active');
    const activeBtn = { translate: els.btnMove, rotate: els.btnRotate, scale: els.btnScale }[s.transformMode];
    activeBtn?.classList.add('active');

    // 選択数に応じた活性/非活性
    const count = s.selectedCount || 0;
    if (els.btnMove) els.btnMove.disabled = count === 0;
    if (els.btnRotate) els.btnRotate.disabled = count === 0;
    if (els.btnScale) els.btnScale.disabled = count === 0;
    if (els.btnFocus) els.btnFocus.disabled = count === 0;
    if (els.btnCopy) els.btnCopy.disabled = count !== 1;
    if (els.btnDelete) els.btnDelete.disabled = count === 0;

    // undo / redo
    if (els.btnUndo) els.btnUndo.disabled = !s.canUndo;
    if (els.btnRedo) els.btnRedo.disabled = !s.canRedo;
    if (els.clearScene) els.clearScene.disabled = !s.canClearScene;
  }

  function closeSceneMenu() { if (els.sceneMenu) els.sceneMenu.open = false; }

  function fitSceneMenu() {
    if (!els.sceneMenu?.open) return;
    const panel = els.sceneMenu.querySelector('.editor-scene-menu-panel');
    if (panel) panel.style.maxHeight = `${Math.max(80, window.innerHeight - panel.getBoundingClientRect().top - 12)}px`;
  }

  function menuAction(command) {
    return () => {
      closeSceneMenu();
      core?.commands?.[command]?.();
    };
  }

  return {
    mount() {
      disposers.push(
        addListener(els.btnUndo, 'click', () => core?.commands?.undo?.()),
        addListener(els.btnRedo, 'click', () => core?.commands?.redo?.()),
        addListener(els.roomSettings, 'click', menuAction('openRoomSettings')),
        addListener(els.exportScene, 'click', menuAction('exportScene')),
        addListener(els.aiLink, 'click', menuAction('startAiLink')),
        addListener(els.help, 'click', menuAction('openHelp')),
        addListener(els.mobileDev, 'click', menuAction('toggleSceneInspector')),
        addListener(els.clearScene, 'click', menuAction('requestSceneClear')),
        addListener(els.sceneMenu, 'toggle', fitSceneMenu),
        addListener(window, 'resize', fitSceneMenu),
        addListener(document, 'scene-sync-notice-layout', fitSceneMenu),
        addListener(document, 'pointerdown', event => {
          if (!els.sceneMenu?.contains(event.target)) closeSceneMenu();
        }, true),
        addListener(document, 'keydown', event => {
          if (event.key === 'Escape' && els.sceneMenu?.open) {
            closeSceneMenu();
            els.sceneMenu.querySelector('summary')?.focus();
          }
        })
      );
      removeStateListener = core?.onStateChange?.(render) || null;
      render();
    },
    unmount() {
      closeSceneMenu();
      core?.commands?.closeMenuSheets?.();
      if (els.clearScene) els.clearScene.disabled = true;
      removeStateListener?.();
      removeStateListener = null;
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

export default createEditorChrome;
