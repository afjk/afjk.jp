import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldFreezeObjectForEditorRuntime } from './editing-state.js';

function objectWithId(objectId) {
  return { userData: { objectId } };
}

test('transport active disables selection-only freeze', () => {
  assert.equal(shouldFreezeObjectForEditorRuntime({
    objectId: 'object-1',
    selectedObjectIds: new Set(['object-1']),
    transportActive: true,
  }), false);
});

test('transport active keeps transform editing frozen', () => {
  assert.equal(shouldFreezeObjectForEditorRuntime({
    objectId: 'object-1',
    selectedObjectIds: new Set(['object-1']),
    transformObject: objectWithId('object-1'),
    transportActive: true,
  }), true);
});

test('transport active keeps XR two-hand editing frozen', () => {
  assert.equal(shouldFreezeObjectForEditorRuntime({
    objectId: 'object-1',
    xrTwoHand: {
      active: true,
      object: objectWithId('object-1'),
    },
    transportActive: true,
  }), true);
});

test('transport active keeps XR grabber editing frozen', () => {
  assert.equal(shouldFreezeObjectForEditorRuntime({
    objectId: 'object-1',
    grabbers: [
      { active: false, object: objectWithId('object-1') },
      { active: true, object: objectWithId('object-1') },
    ],
    transportActive: true,
  }), true);
});

test('selection freeze remains when transport is inactive', () => {
  assert.equal(shouldFreezeObjectForEditorRuntime({
    objectId: 'object-1',
    selectedObjectIds: new Set(['object-1']),
    transportActive: false,
  }), true);
});
