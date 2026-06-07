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
    btnCopy: document.getElementById('btn-copy'),
    btnDelete: document.getElementById('btn-delete'),
    btnUndo: document.getElementById('btn-undo'),
    btnRedo: document.getElementById('btn-redo'),
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
    if (els.btnCopy) els.btnCopy.disabled = count !== 1;
    if (els.btnDelete) els.btnDelete.disabled = count === 0;

    // undo / redo
    if (els.btnUndo) els.btnUndo.disabled = !s.canUndo;
    if (els.btnRedo) els.btnRedo.disabled = !s.canRedo;
  }

  return {
    mount() {
      disposers.push(
        addListener(els.btnUndo, 'click', () => core?.commands?.undo?.()),
        addListener(els.btnRedo, 'click', () => core?.commands?.redo?.())
      );
      removeStateListener = core?.onStateChange?.(render) || null;
      render();
    },
    unmount() {
      removeStateListener?.();
      removeStateListener = null;
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

export default createEditorChrome;
