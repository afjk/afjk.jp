import test from 'node:test';
import assert from 'node:assert/strict';
import { canSelectCompletedLocalAdd } from './local-add-selection.js';

const start = { shell: 'studio', enabled: true, selectionVersion: 3 };
const current = { ...start, loaded: true, locked: false };
test('a completed local addition can enter editing', () => {
  assert.equal(canSelectCompletedLocalAdd(start, current), true);
  assert.equal(canSelectCompletedLocalAdd({ ...start, shell: 'editor' }, { ...current, shell: 'editor' }), true);
});
test('an async import cannot steal a newer selection or deselection', () => {
  assert.equal(canSelectCompletedLocalAdd(start, { ...current, selectionVersion: 4 }), false);
});
test('changing shell, interact mode or stamp mode cancels auto selection', () => {
  assert.equal(canSelectCompletedLocalAdd(start, { ...current, shell: 'editor' }), false);
  assert.equal(canSelectCompletedLocalAdd({ ...start, shell: 'editor' }, current), false);
  assert.equal(canSelectCompletedLocalAdd(start, { ...current, enabled: false }), false);
  assert.equal(canSelectCompletedLocalAdd({ ...start, enabled: false }, current), false);
});
test('failed loads and another client lock cannot become selected', () => {
  assert.equal(canSelectCompletedLocalAdd(start, { ...current, loaded: false }), false);
  assert.equal(canSelectCompletedLocalAdd(start, { ...current, locked: true }), false);
});
