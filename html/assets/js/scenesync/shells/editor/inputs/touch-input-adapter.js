// Touch 入力アダプタ（iOS Safari 等）。タップ/ダブルタップのジェスチャ検出を行い、
// 選択は core.input に委譲する（scene 内部に触れない）。
const DOUBLE_TAP_DELAY = 300;
const DOUBLE_TAP_DISTANCE = 30;

export function createTouchInputAdapter() {
  const disposers = [];
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let touchMoved = false;
  let singleTapTimer = null;

  function add(target, type, handler, options) {
    if (!target) return;
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  }

  return {
    id: 'touch',
    name: 'Touch Input Adapter',

    mount({ core } = {}) {
      const input = core?.input;
      const canvas = input?.getCanvas?.();
      if (!input || !canvas) return;

      add(canvas, 'touchstart', (e) => {
        touchMoved = false;
        const touch = e.touches[0];
        if (!touch) return;
        lastTapX = touch.clientX;
        lastTapY = touch.clientY;
      }, { passive: false });

      add(canvas, 'touchmove', () => { touchMoved = true; }, { passive: false });

      add(canvas, 'touchend', (e) => {
        if (e.touches.length > 0) return;
        const touch = e.changedTouches[0];
        if (!touch) return;

        const now = Date.now();
        const dx = touch.clientX - lastTapX;
        const dy = touch.clientY - lastTapY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        clearTimeout(singleTapTimer);

        if (now - lastTapTime < DOUBLE_TAP_DELAY && dist < DOUBLE_TAP_DISTANCE) {
          // ダブルタップ → 選択
          e.preventDefault();
          input.selectAt(touch.clientX, touch.clientY);
          lastTapTime = 0;
        } else {
          lastTapTime = now;
          lastTapX = touch.clientX;
          lastTapY = touch.clientY;

          // シングルタップ → 空き領域なら選択解除
          const tapX = touch.clientX;
          const tapY = touch.clientY;
          singleTapTimer = setTimeout(() => {
            if (!touchMoved) input.handleEmptyTapDeselect(tapX, tapY);
          }, DOUBLE_TAP_DELAY + 50);
        }
      }, { passive: false });
    },

    unmount() {
      clearTimeout(singleTapTimer);
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

export default createTouchInputAdapter;
