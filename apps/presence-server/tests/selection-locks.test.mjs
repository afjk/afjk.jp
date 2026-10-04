import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createPresenceServer } from '../src/server.mjs';
import { createRoomSelectionLocks } from '../src/scenesync/selection-locks.mjs';

test('selection hints exclude absent objects and departed owners, and survive another owner’s stale unlock', () => {
  const locks = createRoomSelectionLocks();
  const objects = { photo: {}, absentOwner: {} };
  locks.observe('room', { kind: 'scene-lock', objectId: 'photo' }, 'a');
  locks.observe('room', { kind: 'scene-lock', objectId: 'photo' }, 'b');
  locks.observe('room', { kind: 'scene-unlock', objectId: 'photo' }, 'a');
  locks.observe('room', { kind: 'scene-lock', objectId: 'absentOwner' }, 'gone');
  locks.observe('room', { kind: 'scene-lock', objectId: 'absentObject' }, 'b');
  assert.deepEqual(locks.snapshot('room', objects, id => id === 'b'), { photo: 'b' });
  locks.observe('room', { kind: 'scene-batch', actions: [{ kind: 'scene-remove', objectId: 'photo' }] }, null);
  assert.deepEqual(locks.snapshot('room', objects, id => id === 'b'), {});
  locks.clearRoom('room');
  assert.deepEqual(locks.snapshot('room', { absentObject: {} }, () => true), {});
});

test('late join, legacy state replies, unlock, departure, clear and REST deletion preserve live selection ownership', async () => {
  const server = createPresenceServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const room = 'selection-lock-regression';
  const clients = [];
  async function connect(name, modern = true) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + `/?room=${room}`);
    clients.push(ws);
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    const wait = async (predicate, start = 0) => {
      for (let i = 0; i < 800; i++) {
        const found = messages.slice(start).find(predicate);
        if (found) return found;
        await delay(10);
      }
      throw new Error(`Message timeout: ${name}`);
    };
    const welcome = await wait(m => m.type === 'welcome');
    const send = data => ws.send(JSON.stringify(data));
    send({ type: 'hello', nickname: name, ...(modern ? { sceneProtocol: 1 } : {}) });
    if (modern) send({ type: 'scene-ready', epoch: welcome.sceneRoom.epoch });
    return { ws, messages, wait, welcome, send };
  }
  let request = 0;
  async function snapshot(donor, receiver, epoch, savedHints) {
    const requestId = `state-${++request}`;
    donor.send({ type: 'handoff', targetId: receiver.welcome.id, payload: {
      kind: 'scene-state', requestId, sceneEpoch: epoch, objects: { photo: { name: 'Photo' } },
      ...(savedHints ? { selectionLocks: savedHints } : {}),
    } });
    return (await receiver.wait(m => m.payload?.requestId === requestId)).payload.selectionLocks;
  }
  const sendLock = (client, kind, epoch) => client.send({ type: 'broadcast', payload: { kind, objectId: 'photo', sceneEpoch: epoch } });
  try {
    const a = await connect('owner');
    const legacy = await connect('legacy donor', false);
    const epoch = a.welcome.sceneRoom.epoch;
    sendLock(a, 'scene-lock', epoch);
    await legacy.wait(m => m.payload?.kind === 'scene-lock');
    const b = await connect('late viewer');
    assert.deepEqual(await snapshot(legacy, b, epoch), { photo: a.welcome.id });
    // Saved or fabricated hints cannot replace current connection ownership.
    assert.deepEqual(await snapshot(legacy, b, epoch, { photo: 'old-connection' }), { photo: a.welcome.id });
    sendLock(a, 'scene-unlock', epoch);
    await b.wait(m => m.payload?.kind === 'scene-unlock');
    assert.deepEqual(await snapshot(legacy, b, epoch), {});
    sendLock(a, 'scene-lock', epoch);
    await b.wait(m => m.payload?.kind === 'scene-lock');
    a.ws.close();
    await b.wait(m => m.type === 'peers' && !m.peers.some(p => p.id === a.welcome.id));
    assert.deepEqual(await snapshot(legacy, b, epoch, { photo: a.welcome.id }), {});
    const reconnected = await connect('owner reconnected');
    assert.notEqual(reconnected.welcome.id, a.welcome.id);
    assert.deepEqual(await snapshot(legacy, reconnected, epoch), {});
    sendLock(reconnected, 'scene-lock', epoch);
    assert.deepEqual(await snapshot(reconnected, b, epoch), { photo: reconnected.welcome.id });
    reconnected.send({ type: 'scene-clear-request', requestId: 'clear-locks', epoch });
    const cleared = await b.wait(m => m.type === 'scene-room' && m.event === 'cleared');
    for (const client of [b, reconnected]) client.send({ type: 'scene-ready', epoch: cleared.epoch });
    sendLock(reconnected, 'scene-lock', epoch);
    await reconnected.wait(m => m.error === 'scene_epoch_mismatch');
    assert.deepEqual(await snapshot(reconnected, b, cleared.epoch, { photo: reconnected.welcome.id }), {});
    sendLock(reconnected, 'scene-lock', cleared.epoch);
    assert.deepEqual(await snapshot(reconnected, b, cleared.epoch), { photo: reconnected.welcome.id });
    const removed = await fetch(`${base}/api/room/${room}/broadcast`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'scene-batch', actions: [{ kind: 'scene-remove', objectId: 'photo' }], sceneEpoch: cleared.epoch }),
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await snapshot(reconnected, b, cleared.epoch, { photo: reconnected.welcome.id }), {});
  } finally {
    for (const ws of clients) ws.terminate();
    await server.stop();
  }
});
