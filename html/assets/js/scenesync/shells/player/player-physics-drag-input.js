export function createPlayerPhysicsDragInputAdapter() {
  const disposers = [];
  let draggingPointerId = null;
  let mountedInput = null;
  let mountedCanvas = null;

  function add(target, type, handler, options) {
    if (!target) return;
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  }

  function capture(event, canvas, { setPointerCapture = true } = {}) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    if (setPointerCapture && event.pointerId != null && typeof canvas?.setPointerCapture === 'function') {
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {}
    }
  }

  function releaseCapture(pointerId, canvas) {
    if (pointerId != null && typeof canvas?.releasePointerCapture === 'function') {
      try {
        canvas.releasePointerCapture(pointerId);
      } catch {}
    }
  }

  function cancelDrag({ release = false } = {}) {
    if (draggingPointerId == null) return;
    const pointerId = draggingPointerId;
    mountedInput?.cancelPhysicsDrag?.();
    if (release) releaseCapture(pointerId, mountedCanvas);
    draggingPointerId = null;
  }

  return {
    id: 'player-physics-drag',
    name: 'Player Physics Drag Input Adapter',

    mount({ core } = {}) {
      const input = core?.input;
      const canvas = input?.getCanvas?.();
      if (!input || !canvas) return;
      mountedInput = input;
      mountedCanvas = canvas;

      add(canvas, 'pointerdown', (event) => {
        // multi-touch は誤爆しやすいので primary pointer のみ許可（touch も含む）
        if (event.isPrimary === false) return;
        if (event.button !== 0) return;
        if (input.isPasteMode?.()) return;
        if (input.beginPhysicsDrag?.(event.clientX, event.clientY, event) !== true) return;
        draggingPointerId = event.pointerId;
        capture(event, canvas);
      }, { capture: true });

      add(canvas, 'pointermove', (event) => {
        if (draggingPointerId == null || event.pointerId !== draggingPointerId) return;
        input.updatePhysicsDrag?.(event.clientX, event.clientY, event);
        capture(event, canvas);
      }, { capture: true });

      add(canvas, 'pointerup', (event) => {
        if (draggingPointerId == null || event.pointerId !== draggingPointerId) return;
        input.endPhysicsDrag?.(event.clientX, event.clientY, event);
        releaseCapture(event.pointerId, canvas);
        draggingPointerId = null;
        capture(event, canvas, { setPointerCapture: false });
      }, { capture: true });

      add(canvas, 'pointercancel', (event) => {
        if (draggingPointerId == null || event.pointerId !== draggingPointerId) return;
        input.cancelPhysicsDrag?.();
        releaseCapture(event.pointerId, canvas);
        draggingPointerId = null;
        capture(event, canvas, { setPointerCapture: false });
      }, { capture: true });

      add(globalThis.window, 'blur', () => {
        cancelDrag({ release: true });
      });
    },

    unmount() {
      cancelDrag();
      for (const dispose of disposers.splice(0)) dispose();
      draggingPointerId = null;
      mountedInput = null;
      mountedCanvas = null;
    },
  };
}

export default createPlayerPhysicsDragInputAdapter;
