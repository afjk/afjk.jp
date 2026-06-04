// Pointer 入力アダプタ。canvas の pointer 系イベント（選択・hover・paste 配置・
// カメラ操作の前段）を配線する。編集専用のショートカットは含まないため、
// 鑑賞用 shell（viewer/player/minimal）でも安全に常時 mount できる。
// 解釈は core.input に委譲する（scene 内部に触れない）。
export function createPointerInputAdapter() {
  const disposers = [];
  let pointerSelectionStart = null;

  function add(target, type, handler, options) {
    if (!target) return;
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  }

  return {
    id: 'pointer',
    name: 'Pointer Input Adapter',

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
    },

    unmount() {
      for (const dispose of disposers.splice(0)) dispose();
      pointerSelectionStart = null;
    },
  };
}

export default createPointerInputAdapter;
