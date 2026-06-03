// Mouse / pointer + keyboard 入力アダプタ。
// canvas の pointer 系イベントとキーボードショートカットを配線し、
// 解釈は core.input / core.commands に委譲する（scene 内部に触れない）。
export function createMouseInputAdapter() {
  const disposers = [];
  let pointerSelectionStart = null;

  function add(target, type, handler, options) {
    if (!target) return;
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  }

  return {
    id: 'mouse',
    name: 'Mouse Input Adapter',

    mount({ core } = {}) {
      const input = core?.input;
      const canvas = input?.getCanvas?.();
      if (!input || !canvas) return;

      add(canvas, 'pointerdown', (e) => {
        if (input.isPasteMode()) { pointerSelectionStart = null; return; }
        if (e.pointerType === 'touch') return;
        pointerSelectionStart = { x: e.clientX, y: e.clientY, button: e.button };
      });

      add(canvas, 'pointermove', (e) => {
        input.pointerMove(e.clientX, e.clientY);
        if (input.isPasteMode()) input.pasteMoveFromPointer(e);
      });

      add(canvas, 'pointerup', (e) => {
        if (input.isPasteMode()) { pointerSelectionStart = null; return; }
        if (e.pointerType === 'touch') return;
        if (input.isDragging() || !pointerSelectionStart) return;
        if (pointerSelectionStart.button !== 0 || e.button !== 0) return;

        const dx = e.clientX - pointerSelectionStart.x;
        const dy = e.clientY - pointerSelectionStart.y;
        pointerSelectionStart = null;

        if ((dx * dx + dy * dy) > 25) return;
        input.selectAt(e.clientX, e.clientY, e);
      });

      add(canvas, 'pointercancel', () => { pointerSelectionStart = null; });

      add(canvas, 'pointerleave', () => { input.clearHover(); });

      add(canvas, 'click', (event) => {
        if (!input.isPasteMode()) return;
        event.preventDefault();
        event.stopPropagation();
        input.commitPasteClick();
      });

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
      pointerSelectionStart = null;
    },
  };
}

export default createMouseInputAdapter;
