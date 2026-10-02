// Keep a Studio gizmo drag on the starting side of zero. Numeric edits,
// imported mirrors, remote updates and history replay do not use this guard.
export function createScaleDragGuard() {
  let drag = null;
  return {
    begin(object, { enabled, mode } = {}) {
      drag = enabled && mode === 'scale' && object
        ? { object, start: object.scale.toArray() }
        : null;
    },
    update(object) {
      if (!drag || drag.object !== object) return;
      for (const [index, axis] of ['x', 'y', 'z'].entries()) {
        const start = drag.start[index];
        // Preserve already-flat axes and tiny imported objects as well.
        if (start === 0) { object.scale[axis] = 0; continue; }
        const sign = Math.sign(start);
        const minimum = Math.abs(start) * 0.01;
        const candidate = object.scale[axis];
        object.scale[axis] = Number.isFinite(candidate)
          ? sign * Math.max(sign * candidate, minimum)
          : start;
      }
    },
    end() { drag = null; },
  };
}
