import test from 'node:test';
import assert from 'node:assert/strict';
import { initTextAddDialog, readTextAddInput } from './text-add-dialog.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('an older shell without the optional dialog can still initialize', () => {
  assert.doesNotThrow(() => initTextAddDialog({ root: { getElementById: () => null } }));
});

function fixture(onAdd = async () => {}) {
  const ids = ['text-add-dialog', 'text-add-form', 'text-add-content', 'text-add-x', 'text-add-y', 'text-add-z', 'editor-add-text', 'text-add-submit', 'text-add-cancel', 'text-add-error'];
  const elements = Object.fromEntries(ids.map(id => [id, Object.assign(new EventTarget(), { value: '', disabled: false, hidden: true })]));
  const dialog = elements['text-add-dialog'];
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  elements['text-add-content'].focus = () => {};
  elements['text-add-form'].reset = () => {
    elements['text-add-content'].value = '';
    ['x', 'y', 'z'].forEach((axis, i) => { elements[`text-add-${axis}`].value = String([0, 1, 0][i]); });
  };
  elements['text-add-form'].setAttribute = () => {};
  let allowed = true, refresh;
  const additions = [], messages = [];
  initTextAddDialog({
    root: { getElementById: id => elements[id] },
    canAdd: () => allowed,
    onAdd: async input => { additions.push(input); await onAdd(input); },
    showToast: message => messages.push(message),
    onStateChange: listener => { refresh = listener; },
  });
  return {
    elements, dialog, additions, messages,
    open() { elements['editor-add-text'].dispatchEvent(new Event('click')); },
    text(value) { elements['text-add-content'].value = value; },
    submit() { elements['text-add-form'].dispatchEvent(new Event('submit', { cancelable: true })); },
    allow(value) { allowed = value; refresh(); },
  };
}

test('numeric text input preserves literal text and rejects empty/non-finite fields', () => {
  assert.deepEqual(readTextAddInput(' やあ、af！一緒に作ろう。\r\nnext ', ['-2', '1.25', '0']), {
    text: 'やあ、af！一緒に作ろう。\nnext', position: [-2, 1.25, 0],
  });
  for (const value of ['', ' \n ']) assert.throws(() => readTextAddInput(value, [0, 1, 0]), /テキスト/);
  assert.throws(() => readTextAddInput('x'.repeat(5001), [0, 1, 0]), /5000/);
  for (const values of [[0, '', 0], [0, Infinity, 0], [NaN, 1, 0], ['x', 1, 0], [0, 1]]) {
    assert.throws(() => readTextAddInput('reply', values), /数値/);
  }
});

test('duplicate submissions share one pending addition and cannot re-submit a closed dialog', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  f.open(); f.text('やあ、af！一緒に作ろう。');
  f.submit(); f.submit();
  assert.equal(f.additions.length, 1);
  assert.equal(f.elements['text-add-submit'].disabled, true);
  const cancel = new Event('cancel', { cancelable: true });
  f.dialog.dispatchEvent(cancel); assert.equal(cancel.defaultPrevented, true);
  f.elements['text-add-cancel'].dispatchEvent(new Event('click')); assert.equal(f.dialog.open, true);
  resolve(); await flush();
  assert.equal(f.dialog.open, false); assert.equal(f.messages.length, 1);
  f.submit(); await flush(); assert.equal(f.additions.length, 1);
});

test('read-only mode or loss of room readiness rejects an already-open form', async () => {
  const f = fixture(); f.allow(false); f.open(); assert.equal(f.dialog.open, false);
  f.allow(true); f.open(); f.text('reply'); f.allow(false); f.submit(); await flush();
  assert.equal(f.additions.length, 0);
  assert.equal(f.elements['text-add-submit'].disabled, true);
  assert.equal(f.elements['text-add-error'].hidden, false);
  f.allow(true); f.submit(); await flush(); assert.equal(f.additions.length, 1);
});

test('failed preparation leaves the draft available for retry; cancel makes no addition', async () => {
  let fail = true;
  const f = fixture(async () => { if (fail) throw new Error('preparation failed'); });
  f.open(); f.text('reply'); f.submit(); await flush();
  assert.equal(f.dialog.open, true);
  assert.equal(f.elements['text-add-content'].value, 'reply');
  assert.equal(f.elements['text-add-error'].textContent, 'preparation failed');
  assert.equal(f.messages.length, 0);
  fail = false; f.submit(); await flush(); assert.equal(f.messages.length, 1);
  f.open(); f.text('cancelled'); f.elements['text-add-cancel'].dispatchEvent(new Event('click'));
  f.submit(); await flush(); assert.equal(f.additions.length, 2);
});
