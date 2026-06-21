import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlayerPhysicsDragInputAdapter } from './player-physics-drag-input.js';

function pointerEvent(type, props = {}) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, Object.fromEntries(
    Object.entries({
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 10,
      clientY: 20,
      ...props,
    }).map(([key, value]) => [key, { value, configurable: true }]),
  ));
  return event;
}

function withWindow(target, run) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    value: target,
    configurable: true,
    writable: true,
  });
  try {
    run();
  } finally {
    if (hadWindow) {
      Object.defineProperty(globalThis, 'window', {
        value: previousWindow,
        configurable: true,
        writable: true,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
}

test('player physics drag adapter delegates captured pointer drags', () => {
  const canvas = new EventTarget();
  const calls = [];
  canvas.setPointerCapture = (pointerId) => calls.push(['capture', pointerId]);
  canvas.releasePointerCapture = (pointerId) => calls.push(['release', pointerId]);

  const adapter = createPlayerPhysicsDragInputAdapter();
  adapter.mount({
    core: {
      input: {
        getCanvas: () => canvas,
        isPasteMode: () => false,
        beginPhysicsDrag: (x, y) => {
          calls.push(['begin', x, y]);
          return true;
        },
        updatePhysicsDrag: (x, y) => calls.push(['move', x, y]),
        endPhysicsDrag: (x, y) => calls.push(['end', x, y]),
        cancelPhysicsDrag: () => calls.push(['cancel']),
      },
    },
  });

  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 12, clientY: 24 }));
  canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 18, clientY: 30 }));
  canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 22, clientY: 34 }));
  adapter.unmount();

  assert.deepEqual(calls, [
    ['begin', 12, 24],
    ['capture', 1],
    ['move', 18, 30],
    ['capture', 1],
    ['end', 22, 34],
    ['release', 1],
  ]);
});

test('player physics drag adapter cancels and releases capture on window blur', () => {
  const canvas = new EventTarget();
  const windowTarget = new EventTarget();
  const calls = [];
  canvas.setPointerCapture = (pointerId) => calls.push(['capture', pointerId]);
  canvas.releasePointerCapture = (pointerId) => calls.push(['release', pointerId]);

  withWindow(windowTarget, () => {
    const adapter = createPlayerPhysicsDragInputAdapter();
    adapter.mount({
      core: {
        input: {
          getCanvas: () => canvas,
          isPasteMode: () => false,
          beginPhysicsDrag: (x, y) => {
            calls.push(['begin', x, y]);
            return true;
          },
          updatePhysicsDrag: (x, y) => calls.push(['move', x, y]),
          cancelPhysicsDrag: () => calls.push(['cancel']),
        },
      },
    });

    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 12, clientY: 24 }));
    windowTarget.dispatchEvent(new Event('blur'));
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 18, clientY: 30 }));
    adapter.unmount();
  });

  assert.deepEqual(calls, [
    ['begin', 12, 24],
    ['capture', 1],
    ['cancel'],
    ['release', 1],
  ]);
});

test('player physics drag adapter ignores non-object pointerdown', () => {
  const canvas = new EventTarget();
  const calls = [];
  canvas.setPointerCapture = () => calls.push(['capture']);

  const adapter = createPlayerPhysicsDragInputAdapter();
  adapter.mount({
    core: {
      input: {
        getCanvas: () => canvas,
        isPasteMode: () => false,
        beginPhysicsDrag: () => {
          calls.push(['begin']);
          return false;
        },
        updatePhysicsDrag: () => calls.push(['move']),
        endPhysicsDrag: () => calls.push(['end']),
      },
    },
  });

  canvas.dispatchEvent(pointerEvent('pointerdown'));
  canvas.dispatchEvent(pointerEvent('pointermove'));
  canvas.dispatchEvent(pointerEvent('pointerup'));
  adapter.unmount();

  assert.deepEqual(calls, [['begin']]);
});
