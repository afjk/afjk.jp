import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSceneLifetime } from './scene-lifetime.js';

test('clear/reconnect cancels already-started work even after a new generation is ready', async () => {
  const lifetime = createSceneLifetime();
  const old = lifetime.capture();
  let release;
  let committed = false;
  const load = new Promise(resolve => { release = resolve; }).then(() => {
    lifetime.assert(old);
    committed = true;
  });
  lifetime.invalidate();
  const current = lifetime.capture();
  release();
  await assert.rejects(load, { name: 'AbortError' });
  assert.equal(committed, false);
  assert.equal(old.signal.aborted, true);
  assert.equal(lifetime.current(current), true);
});
