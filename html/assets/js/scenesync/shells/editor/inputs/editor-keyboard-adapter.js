// Editor keyboard shortcut アダプタ。Cmd/Ctrl+C/V・Undo/Redo・W/E/R・
// Escape・Delete/Backspace といった「編集系」ショートカットを配線する。
// 編集を行う shell（editor / studio）のみ mount すること。鑑賞用 shell
// （viewer / player / minimal）では mount しない＝編集ショートカットを無効化する。
// 解釈は core.input / core.commands に委譲する（scene 内部に触れない）。
export function createEditorKeyboardAdapter() {
  const disposers = [];

  function add(target, type, handler, options) {
    if (!target) return;
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  }

  return {
    id: 'editor-keyboard',
    name: 'Editor Keyboard Adapter',

    mount({ core } = {}) {
      const input = core?.input;
      if (!input) return;

      add(window, 'keydown', (e) => {
        if (input.shouldIgnoreShortcut(e)) return;

        // ドラッグ中は Undo/Redo を無効化
        if (input.isDragging()) {
          if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'y')) {
            e.preventDefault();
            return;
          }
        }

        const isMod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();

        if (isMod && !e.altKey && key === 'c') {
          if (input.copySelection()) { e.preventDefault(); e.stopPropagation(); }
          return;
        }
        if (isMod && !e.altKey && key === 'v') {
          if (input.pasteToggle()) { e.preventDefault(); e.stopPropagation(); }
          return;
        }
        if (isMod && key === 'z' && !e.shiftKey) {
          e.preventDefault(); core.commands?.undo?.(); return;
        }
        if (isMod && (key === 'y' || (key === 'z' && e.shiftKey))) {
          e.preventDefault(); core.commands?.redo?.(); return;
        }

        switch (key) {
          case 'w': core.commands?.setTransformMode?.('translate'); break;
          case 'e': core.commands?.setTransformMode?.('rotate'); break;
          case 'r': core.commands?.setTransformMode?.('scale'); break;
          case 'escape': { if (input.handleEscape()) e.preventDefault(); break; }
          case 'delete':
          case 'backspace': { e.preventDefault(); core.commands?.deleteSelected?.(); break; }
        }
      });
    },

    unmount() {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

export default createEditorKeyboardAdapter;
