export function isTouchLikeDevice() {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

export function shouldAvoidProgrammaticTextFocus() {
  return isTouchLikeDevice();
}

export function focusTextInputIfSafe(element, options = {}) {
  if (!element || typeof element.focus !== 'function') return false;

  const allowOnTouch = options.allowOnTouch === true;
  if (!allowOnTouch && shouldAvoidProgrammaticTextFocus()) {
    return false;
  }

  element.focus(options.focusOptions || {});
  return document.activeElement === element;
}

export function isEditableElement(element) {
  if (!(element instanceof Element)) return false;
  return Boolean(element.closest('input, textarea, select, [contenteditable="true"], .cm-editor, .monaco-editor'));
}

export function blurActiveEditableElement() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && isEditableElement(active)) {
    active.blur();
    return true;
  }
  return false;
}
