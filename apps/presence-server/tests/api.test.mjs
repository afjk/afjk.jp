import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { createPresenceServer } from '../src/server.mjs';

const MESSAGE_TIMEOUT_MS = 3000;

let server;
let baseUrl;
let wsBaseUrl;

before(async () => {
  server = createPresenceServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  wsBaseUrl = `ws://127.0.0.1:${address.port}/ws`;
});

after(async () => {
  await server.stop();
});

function waitForEvent(target, event, timeoutMs = MESSAGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);

    const cleanup = () => clearTimeout(timer);

    target.once(event, (...args) => {
      cleanup();
      resolve(args);
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = MESSAGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for websocket message'));
    }, timeoutMs);

    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    }

    ws.on('message', onMessage);
  });
}

async function connectClient(roomId, nickname = 'TestUser', userId = null) {
  const ws = new WebSocket(`${wsBaseUrl}?room=${roomId}`);
  await waitForEvent(ws, 'open');
  ws.send(JSON.stringify({
    type: 'hello',
    nickname,
    device: 'Node Test',
    userId,
  }));
  return ws;
}

async function closeClient(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CLOSING) {
    await waitForEvent(ws, 'close');
    return;
  }
  ws.terminate();
  await waitForEvent(ws, 'close');
}

describe('presence REST broadcast API', () => {
  it('delivers JSON payload to room websocket clients', async () => {
    const ws = await connectClient('test-room');
    try {
      const messagePromise = waitForMessage(ws, message => message.type === 'handoff');
      const response = await fetch(`${baseUrl}/api/room/test-room/broadcast?name=TestAI`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'scene-add',
          objectId: 'obj-1',
          name: 'Test',
        }),
      });

      const [body, message] = await Promise.all([
        response.json(),
        messagePromise,
      ]);

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.peers, 1);
      assert.equal(message.type, 'handoff');
      assert.match(message.from.id, /^api-/);
      assert.equal(message.from.nickname, 'TestAI');
      assert.equal(message.from.device, 'REST API');
      assert.equal(message.payload.kind, 'scene-add');
      assert.equal(message.payload.objectId, 'obj-1');
    } finally {
      await closeClient(ws);
    }
  });

  it('defaults nickname to AI when name is omitted', async () => {
    const ws = await connectClient('test-room');
    try {
      const messagePromise = waitForMessage(ws, message => message.type === 'handoff');
      const response = await fetch(`${baseUrl}/api/room/test-room/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'scene-add', objectId: 'obj-2' }),
      });

      const [message] = await Promise.all([
        messagePromise,
        response.json(),
      ]);

      assert.equal(message.from.nickname, 'AI');
    } finally {
      await closeClient(ws);
    }
  });

  it('accepts wrapped payload bodies for broadcast', async () => {
    const ws = await connectClient('test-room');
    try {
      const messagePromise = waitForMessage(ws, message => message.type === 'handoff');
      const response = await fetch(`${baseUrl}/api/room/test-room/broadcast?name=WrappedAI`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload: {
            kind: 'scene-add',
            objectId: 'obj-wrapped',
            name: 'Wrapped Test',
          },
        }),
      });

      const [body, message] = await Promise.all([
        response.json(),
        messagePromise,
      ]);

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(message.from.nickname, 'WrappedAI');
      assert.equal(message.payload.kind, 'scene-add');
      assert.equal(message.payload.objectId, 'obj-wrapped');
    } finally {
      await closeClient(ws);
    }
  });

  it('accepts nickname query parameter for broadcast', async () => {
    const ws = await connectClient('test-room');
    try {
      const messagePromise = waitForMessage(ws, message => message.type === 'handoff');
      const response = await fetch(`${baseUrl}/api/room/test-room/broadcast?nickname=TestBot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'scene-add', objectId: 'obj-nickname' }),
      });

      const [body, message] = await Promise.all([
        response.json(),
        messagePromise,
      ]);

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(message.from.nickname, 'TestBot');
    } finally {
      await closeClient(ws);
    }
  });

  it('prefers name query parameter over nickname for broadcast', async () => {
    const ws = await connectClient('test-room');
    try {
      const messagePromise = waitForMessage(ws, message => message.type === 'handoff');
      const response = await fetch(`${baseUrl}/api/room/test-room/broadcast?name=PrimaryName&nickname=SecondaryName`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'scene-add', objectId: 'obj-priority' }),
      });

      const [body, message] = await Promise.all([
        response.json(),
        messagePromise,
      ]);

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(message.from.nickname, 'PrimaryName');
    } finally {
      await closeClient(ws);
    }
  });

  it('returns 400 when body is empty', async () => {
    const response = await fetch(`${baseUrl}/api/room/test-room/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid JSON body' });
  });

  it('returns 400 when body is invalid JSON', async () => {
    const response = await fetch(`${baseUrl}/api/room/test-room/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid JSON body' });
  });

  it('returns success with zero peers for a nonexistent room', async () => {
    const response = await fetch(`${baseUrl}/api/room/nonexistent/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'scene-add', objectId: 'obj-3' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      room: 'nonexistent',
      peers: 0,
      userPresent: false,
    });
  });

  it('broadcasts to multiple clients in the same room', async () => {
    const ws1 = await connectClient('test-room');
    const ws2 = await connectClient('test-room', 'Peer2');
    try {
      const message1 = waitForMessage(ws1, message => message.type === 'handoff');
      const message2 = waitForMessage(ws2, message => message.type === 'handoff');
      const response = await fetch(`${baseUrl}/api/room/test-room/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'scene-add', objectId: 'obj-4' }),
      });

      const [body, handoff1, handoff2] = await Promise.all([
        response.json(),
        message1,
        message2,
      ]);

      assert.equal(body.peers, 2);
      assert.equal(handoff1.payload.objectId, 'obj-4');
      assert.equal(handoff2.payload.objectId, 'obj-4');
    } finally {
      await Promise.all([closeClient(ws1), closeClient(ws2)]);
    }
  });

  it('broadcasts scene-env to change environment', async () => {
    const ws = await connectClient('env-test-room');
    try {
      const messagePromise = waitForMessage(ws, message => message.type === 'handoff');
      const response = await fetch(`${baseUrl}/api/room/env-test-room/broadcast?name=Claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'scene-env', envId: 'outdoor_night' }),
      });

      const [body, message] = await Promise.all([
        response.json(),
        messagePromise,
      ]);

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(message.type, 'handoff');
      assert.equal(message.payload.kind, 'scene-env');
      assert.equal(message.payload.envId, 'outdoor_night');
    } finally {
      await closeClient(ws);
    }
  });
});

describe('presence REST scene API', () => {
  it('returns an empty scene immediately when the room has no peers', async () => {
    const response = await fetch(`${baseUrl}/api/room/no-peers/scene?name=TestAI`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { objects: {} });
  });

  it('requests scene-state from a websocket client and returns it', async () => {
    const ws = await connectClient('scene-room');
    try {
      const requestPromise = waitForMessage(ws, message =>
        message.type === 'handoff' && message.payload?.kind === 'scene-request');

      const responsePromise = fetch(`${baseUrl}/api/room/scene-room/scene?name=TestAI`);
      const requestMessage = await requestPromise;

      assert.match(requestMessage.from.id, /^api-/);
      assert.equal(requestMessage.from.nickname, 'TestAI');
      assert.equal(requestMessage.from.device, 'REST API');

      ws.send(JSON.stringify({
        type: 'handoff',
        targetId: requestMessage.from.id,
        payload: {
          kind: 'scene-state',
          objects: {
            'booth-1': {
              name: 'VR体験ブース',
              position: [2, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [2, 2, 3],
              asset: {
                type: 'primitive',
                primitive: 'box',
                color: '#4488ff',
              },
            },
          },
        },
      }));

      const response = await responsePromise;
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        objects: {
          'booth-1': {
            name: 'VR体験ブース',
            position: [2, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [2, 2, 3],
            asset: {
              type: 'primitive',
              primitive: 'box',
              color: '#4488ff',
            },
          },
        },
      });
    } finally {
      await closeClient(ws);
    }
  });

  it('accepts nickname query parameter for scene', async () => {
    const ws = await connectClient('scene-room');
    try {
      const requestPromise = waitForMessage(ws, message =>
        message.type === 'handoff' && message.payload?.kind === 'scene-request');

      const responsePromise = fetch(`${baseUrl}/api/room/scene-room/scene?nickname=TestBot`);
      const requestMessage = await requestPromise;

      assert.equal(requestMessage.from.nickname, 'TestBot');

      ws.send(JSON.stringify({
        type: 'handoff',
        targetId: requestMessage.from.id,
        payload: { kind: 'scene-state', objects: {} },
      }));

      const response = await responsePromise;
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { objects: {} });
    } finally {
      await closeClient(ws);
    }
  });

  it('prefers name query parameter over nickname for scene', async () => {
    const ws = await connectClient('scene-room');
    try {
      const requestPromise = waitForMessage(ws, message =>
        message.type === 'handoff' && message.payload?.kind === 'scene-request');

      const responsePromise = fetch(`${baseUrl}/api/room/scene-room/scene?name=PrimaryName&nickname=SecondaryName`);
      const requestMessage = await requestPromise;

      assert.equal(requestMessage.from.nickname, 'PrimaryName');

      ws.send(JSON.stringify({
        type: 'handoff',
        targetId: requestMessage.from.id,
        payload: { kind: 'scene-state', objects: {} },
      }));

      const response = await responsePromise;
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { objects: {} });
    } finally {
      await closeClient(ws);
    }
  });

  it('returns an empty scene when scene-state times out', async () => {
    const ws = await connectClient('scene-timeout-room');
    try {
      const requestPromise = waitForMessage(ws, message =>
        message.type === 'handoff' && message.payload?.kind === 'scene-request');
      const responsePromise = fetch(`${baseUrl}/api/room/scene-timeout-room/scene`);
      const requestMessage = await requestPromise;

      assert.match(requestMessage.from.id, /^api-/);

      const response = await responsePromise;
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { objects: {} });
    } finally {
      await closeClient(ws);
    }
  });
});

describe('presence AI link API', () => {
  it('broadcasts ai-link-established when a pairing code is redeemed', async () => {
    const userId = 'usr-test-link';
    const ws = await connectClient('link-room', 'Linked User', userId);
    try {
      const response = await fetch(`${baseUrl}/api/link/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: 'link-room', userId }),
      });

      const { code } = await response.json();
      const messagePromise = waitForMessage(ws, message =>
        message.type === 'handoff' && message.payload?.kind === 'ai-link-established');

      const redeemResponse = await fetch(`${baseUrl}/api/link/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      const [redeemBody, message] = await Promise.all([
        redeemResponse.json(),
        messagePromise,
      ]);

      assert.equal(redeemResponse.status, 200);
      assert.equal(redeemBody.ok, true);
      assert.equal(redeemBody.userId, userId);
      assert.equal(message.payload.linkId, redeemBody.linkId);
      assert.equal(message.payload.userId, userId);
      assert.equal(message.payload.roomId, 'link-room');
      assert.equal(message.payload.expiresAt, redeemBody.expiresAt);
    } finally {
      await closeClient(ws);
    }
  });

  it('revokes a remotely established link by linkId and broadcasts ai-link-revoked', async () => {
    const userId = 'usr-test-revoke';
    const ws = await connectClient('revoke-room', 'Linked User', userId);
    try {
      const initiateResponse = await fetch(`${baseUrl}/api/link/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: 'revoke-room', userId }),
      });
      const { code } = await initiateResponse.json();

      const establishedPromise = waitForMessage(ws, message =>
        message.type === 'handoff' && message.payload?.kind === 'ai-link-established');

      await fetch(`${baseUrl}/api/link/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }).then(res => res.json());

      const established = await establishedPromise;

      const revokedPromise = waitForMessage(ws, message =>
        message.type === 'handoff' && message.payload?.kind === 'ai-link-revoked');

      const revokeResponse = await fetch(`${baseUrl}/api/link/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId: established.payload.linkId }),
      });

      const [revokeBody, revoked] = await Promise.all([
        revokeResponse.json(),
        revokedPromise,
      ]);

      assert.equal(revokeResponse.status, 200);
      assert.deepEqual(revokeBody, { ok: true });
      assert.equal(revoked.payload.linkId, established.payload.linkId);
      assert.equal(revoked.payload.reason, 'ai-revoked');
    } finally {
      await closeClient(ws);
    }
  });
});
