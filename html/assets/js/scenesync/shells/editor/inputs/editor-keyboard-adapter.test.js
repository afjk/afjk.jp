import test from 'node:test';
import assert from 'node:assert/strict';

import { createEditorKeyboardAdapter } from './editor-keyboard-adapter.js';

function createKeyboardHarness({ focusResult = true, ignoreShortcut = false } = {}) {
  const listeners = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };

  let focusCalls = 0;
  const adapter = createEditorKeyboardAdapter();
  adapter.mount({
    core: {
      input: {
        shouldIgnoreShortcut: () => ignoreShortcut,
        isDragging: () => false,
        copySelection: () => false,
        pasteToggle: () => false,
        handleEscape: () => false,
      },
      commands: {
        focusSelected() {
          focusCalls += 1;
          return focusResult;
        },
      },
    },
  });

  return {
    dispatch(properties = {}) {
      const event = {
        key: 'f',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        prevented: false,
        stopped: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; },
        ...properties,
      };
      listeners.get('keydown')?.(event);
      return event;
    },
    focusCalls: () => focusCalls,
    dispose() {
      adapter.unmount();
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

test('plain F frames the current selection and consumes the shortcut', (t) => {
  const harness = createKeyboardHarness();
  t.after(() => harness.dispose());

  const event = harness.dispatch();

  assert.equal(harness.focusCalls(), 1);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});

test('modified or editable-target F input is left alone', (t) => {
  const modified = createKeyboardHarness();
  t.after(() => modified.dispose());

  const modifiedEvent = modified.dispatch({ shiftKey: true });
  assert.equal(modified.focusCalls(), 0);
  assert.equal(modifiedEvent.prevented, false);

  modified.dispose();
  const ignored = createKeyboardHarness({ ignoreShortcut: true });
  t.after(() => ignored.dispose());
  const ignoredEvent = ignored.dispatch();
  assert.equal(ignored.focusCalls(), 0);
  assert.equal(ignoredEvent.prevented, false);
});
