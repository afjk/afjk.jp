import test from 'node:test';
import assert from 'node:assert/strict';
import { createScaleDragGuard } from './scale-drag-guard.js';

function object(values) {
  return { scale: {
    x: values[0], y: values[1], z: values[2],
    toArray() { return [this.x, this.y, this.z]; },
  } };
}
function setScale(obj, values) {
  [obj.scale.x, obj.scale.y, obj.scale.z] = values;
}

test('crossing zero cannot flip or collapse a Studio scale drag', () => {
  const guard = createScaleDragGuard(), obj = object([1, 2, 3]);
  guard.begin(obj, { enabled: true, mode: 'scale' });
  setScale(obj, [-1.27, 0, 0.0001]); guard.update(obj);
  assert.deepEqual(obj.scale.toArray(), [0.01, 0.02, 0.03]);
  setScale(obj, [0.5, 1, 1.5]); guard.update(obj);
  assert.deepEqual(obj.scale.toArray(), [0.5, 1, 1.5], 'moving back recovers smoothly');
});
test('existing mirrors retain each axis sign while growing and shrinking', () => {
  const guard = createScaleDragGuard(), obj = object([-2, 3, -4]);
  guard.begin(obj, { enabled: true, mode: 'scale' });
  setScale(obj, [-4, 6, -8]); guard.update(obj);
  assert.deepEqual(obj.scale.toArray(), [-4, 6, -8]);
  setScale(obj, [2, -3, 4]); guard.update(obj);
  assert.deepEqual(obj.scale.toArray(), [-0.02, 0.03, -0.04]);
});
test('tiny imported scales and already-flat axes are preserved', () => {
  const guard = createScaleDragGuard(), obj = object([1e-8, -1e-8, 0]);
  guard.begin(obj, { enabled: true, mode: 'scale' });
  setScale(obj, [-1, 1, 10]); guard.update(obj);
  assert.deepEqual(obj.scale.toArray(), [1e-10, -1e-10, 0]);
});
test('inactive, non-Studio and non-scale edits can still explicitly mirror', () => {
  for (const settings of [null, { enabled: false, mode: 'scale' }, { enabled: true, mode: 'translate' }, { enabled: true, mode: 'rotate' }]) {
    const guard = createScaleDragGuard(), obj = object([1, 1, 1]);
    if (settings) guard.begin(obj, settings);
    setScale(obj, [-1, 1, 1]); guard.update(obj);
    assert.deepEqual(obj.scale.toArray(), [-1, 1, 1]);
  }
});
test('other objects and post-drag history/remote edits are unaffected', () => {
  const guard = createScaleDragGuard(), obj = object([1, 1, 1]), other = object([-2, 1, 1]);
  guard.begin(obj, { enabled: true, mode: 'scale' }); guard.update(other);
  assert.deepEqual(other.scale.toArray(), [-2, 1, 1]);
  guard.end(); setScale(obj, [-2, 1, 1]); guard.update(obj);
  assert.deepEqual(obj.scale.toArray(), [-2, 1, 1]);
});
test('each gesture snapshots the current scale; invalid drag values recover', () => {
  const guard = createScaleDragGuard(), obj = object([1, 1, 1]);
  guard.begin(obj, { enabled: true, mode: 'scale' }); guard.end();
  setScale(obj, [-2, 4, 6]); guard.begin(obj, { enabled: true, mode: 'scale' });
  setScale(obj, [NaN, Infinity, -Infinity]); guard.update(obj);
  assert.deepEqual(obj.scale.toArray(), [-2, 4, 6]);
});
