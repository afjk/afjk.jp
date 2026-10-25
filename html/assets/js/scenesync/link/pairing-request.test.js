import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairingRequestController } from './pairing-request.js';

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let session = { roomId: 'room', userId: 'user', peerId: 'peer' }, linked = false, now = 1000;
  const requests = [], views = [];
  const controller = createPairingRequestController({
    getSession: () => session,
    isLinked: () => linked,
    now: () => now,
    render: view => views.push(view),
    request: identity => { const gate = deferred(); requests.push({ ...gate, identity }); return gate.promise; },
  });
  return { controller, requests, views, session: value => { session = value; }, linked: value => { linked = value; }, time: value => { now = value; } };
}
const code = (value = '123456', expiresAt = 10000) => ({ code: value, expiresAt });

test('loading renders before the request and repeated clicks produce a single initiation', async () => {
  const f = fixture();
  const a = f.controller.open(), b = f.controller.open();
  assert.equal(f.views.at(-1).status, 'loading');
  await flush(); assert.equal(f.requests.length, 1);
  f.requests[0].resolve(code()); await Promise.all([a, b]);
  assert.equal(f.views.filter(v => v.status === 'code').length, 1);
  assert.equal(f.views.at(-1).code, '123456');
});

test('close hides immediately; reopen joins the pending request and reuses its unexpired code', async () => {
  const f = fixture(); const old = f.controller.open(); await flush();
  f.controller.close(); assert.equal(f.views.at(-1).status, 'closed');
  const reopened = f.controller.open(); await flush(); assert.equal(f.requests.length, 1);
  f.requests[0].resolve(code()); await Promise.all([old, reopened]);
  assert.equal(f.views.at(-1).status, 'code');
  f.controller.close(); await f.controller.open();
  assert.equal(f.requests.length, 1); assert.equal(f.views.at(-1).code, '123456');
});

test('a late success or failure cannot reopen a cancelled dialog', async () => {
  for (const fail of [true, false]) {
    const f = fixture(); const work = f.controller.open(); await flush(); f.controller.close();
    if (fail) f.requests[0].reject(new Error('Failed to fetch')); else f.requests[0].resolve(code());
    await work; assert.equal(f.views.at(-1).status, 'closed');
  }
});

test('a visible error can be retried without duplicating the retry', async () => {
  const f = fixture(); const first = f.controller.open(); await flush();
  f.requests[0].reject(new Error('Failed to fetch')); await first;
  assert.deepEqual(f.views.at(-1), { status: 'error', error: 'Failed to fetch' });
  const a = f.controller.open(), b = f.controller.open(); await flush();
  assert.equal(f.requests.length, 2); f.requests[1].resolve(code('654321')); await Promise.all([a, b]);
  assert.equal(f.views.at(-1).code, '654321');
});

test('room or peer changes discard old UI updates while allowing a request for the new session', async () => {
  const f = fixture(); const old = f.controller.open(); await flush();
  f.session({ roomId: 'other', userId: 'user', peerId: 'new-peer' }); f.controller.sessionChanged();
  assert.equal(f.views.at(-1).status, 'closed');
  const next = f.controller.open(); await flush();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(code('654321')); await next;
  f.requests[0].resolve(code('111111')); await old;
  assert.equal(f.views.at(-1).code, '654321');
});

test('completion and reset ignore stale work; completed links never initiate again', async () => {
  const f = fixture(); const old = f.controller.open(); await flush();
  f.linked(true); f.controller.complete();
  const count = f.views.length; f.requests[0].reject(new Error('late failure')); await old;
  assert.equal(f.views.length, count); await f.controller.open(); assert.equal(f.requests.length, 1);
  f.linked(false); f.controller.reset(); const next = f.controller.open(); await flush();
  f.requests[1].resolve(code('654321')); await next; assert.equal(f.views.at(-1).code, '654321');
});

test('expired or malformed responses never display a code and expired cache is refreshed', async () => {
  for (const response of [code('', 10000), code('123456', 999), code('123456', Infinity), {}]) {
    const f = fixture(); const work = f.controller.open(); await flush(); f.requests[0].resolve(response); await work;
    assert.equal(f.views.at(-1).status, 'error');
  }
  const f = fixture(); const first = f.controller.open(); await flush(); f.requests[0].resolve(code()); await first;
  f.controller.close(); f.time(11000); const next = f.controller.open(); await flush(); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(code('654321', 20000)); await next; assert.equal(f.views.at(-1).code, '654321');
});

test('a disconnected session shows an error without issuing a request, then allows retry', async () => {
  const f = fixture(); f.session(null); await f.controller.open(); assert.equal(f.requests.length, 0);
  assert.equal(f.views.at(-1).status, 'error');
  f.session({ roomId: 'room', userId: 'user', peerId: 'peer' }); f.controller.sessionChanged();
  assert.equal(f.views.at(-1).status, 'error');
  const next = f.controller.open(); await flush(); f.requests[0].resolve(code()); await next;
  assert.equal(f.views.at(-1).status, 'code');
});
