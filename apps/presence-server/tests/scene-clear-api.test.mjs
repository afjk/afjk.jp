import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { createPresenceServer } from '../src/server.mjs';

test('clear protocol fences old websocket, targeted, graph and REST writes; reconnect receives new epoch', async () => {
  const server = createPresenceServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  async function connect(modern = true) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/?room=clear-api-test');
    const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
    clients.push(ws);
    async function wait(predicate) {
      for (let i = 0; i < 700; i++) {
        const found = messages.find(predicate); if (found) return found;
        await delay(10);
      }
      throw new Error('message timeout');
    }
    const welcome = await wait(m => m.type === 'welcome');
    const send = data => ws.send(JSON.stringify(data));
    send({ type: 'hello', nickname: modern ? 'Phone' : 'Legacy', ...(modern ? { sceneProtocol: 1 } : {}) });
    if (modern) send({ type: 'scene-ready', epoch: welcome.sceneRoom.epoch });
    return { ws, send, wait, messages, welcome };
  }
  try {
    const a = await connect(), b = await connect(), old = await connect(false);
    const epoch = a.welcome.sceneRoom.epoch;
    a.send({ type: 'scene-clear-request', requestId: 'clear-one', epoch });
    a.send({ type: 'scene-clear-request', requestId: 'clear-one', epoch });
    const pending = await b.wait(m => m.type === 'scene-room' && m.event === 'pending');
    assert.equal(pending.pending.actorName, 'Phone');
    const clear = await b.wait(m => m.type === 'scene-room' && m.event === 'cleared');
    assert.notEqual(clear.epoch, epoch);
    b.send({ type: 'scene-ready', epoch: clear.epoch });
    const cut = b.messages.length;
    old.send({ type: 'broadcast', payload: { kind: 'scene-add', objectId: 'stale' } });
    old.send({ type: 'handoff', targetId: b.welcome.id, payload: { kind: 'scene-state', objects: { stale: {} } } });
    old.send({ type: 'broadcast', payload: { type: 'scene-graph-clear', scope: 'scene' } });
    a.send({ type: 'broadcast', payload: { kind: 'scene-remove', objectId: 'stale', sceneEpoch: epoch } });
    const legacyError = await old.wait(m => m.error === 'scene_epoch_mismatch');
    assert.equal(legacyError.type, 'error');
    assert.match(legacyError.message, /再接続またはクライアントの更新/);
    await a.wait(m => m.error === 'scene_epoch_mismatch');
    const post = payload => fetch(`${base}/api/room/clear-api-test/broadcast`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal((await post({ kind: 'scene-add', objectId: 'legacy-rest' })).status, 409);
    assert.equal((await post({ kind: 'scene-add', objectId: 'old-rest', sceneEpoch: epoch })).status, 409);
    await delay(50);
    assert.equal(b.messages.slice(cut).some(m => m.type === 'handoff'), false);
    assert.equal((await post({ kind: 'scene-add', objectId: 'new-object', sceneEpoch: clear.epoch })).status, 200);
    await b.wait(m => m.payload?.objectId === 'new-object');
    const reconnected = await connect();
    assert.equal(reconnected.welcome.sceneRoom.epoch, clear.epoch);
    assert.equal(reconnected.welcome.sceneRoom.cleared, true);
    assert.equal(a.messages.filter(m => m.event === 'cleared').length, 1);
  } finally {
    for (const ws of clients) ws.terminate();
    await server.stop();
  }
});
