import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createPresenceServer } from '../apps/presence-server/src/server.mjs';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const require = createRequire(import.meta.url);
const WebSocket = require(path.join(repoRoot, 'apps/presence-server/node_modules/ws'));

process.env.GPT_SESSION_SECRET ||= 'scene-sync-unity-physics-presence-smoke-secret';

const TEST_TIMEOUT_MS = 60000;
const uloopBin = process.env.ULOOP_BIN || 'uloop';
const unityProject = process.env.SCENESYNC_UNITY_PROJECT
  || path.resolve(repoRoot, '..', 'SceneSyncClient');
const rootName = '__SceneSyncUnityPhysicsPresenceSmoke';

function listenPresenceServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function serverUrl(server, scheme = 'http') {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server did not expose a TCP address');
  }
  return `${scheme}://127.0.0.1:${address.port}`;
}

function waitForEvent(target, event, timeoutMs = TEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      target.off(event, onEvent);
      target.off('error', onError);
    };
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    target.once(event, onEvent);
    if (event !== 'error') {
      target.once('error', onError);
    }
  });
}

function waitForMessage(ws, predicate, { timeoutMs = TEST_TIMEOUT_MS, label = 'websocket message' } = {}) {
  const seen = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${label}; recent messages: ${JSON.stringify(seen.slice(-8))}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`websocket closed while waiting for ${label}`));
    };
    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      seen.push({
        type: message.type || null,
        kind: message.payload?.kind || null,
        from: message.from?.id || null,
      });
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };

    ws.on('message', onMessage);
    ws.once('error', onError);
    ws.once('close', onClose);
  });
}

async function connectPresenceClient(wsBaseUrl, roomId, nickname) {
  const ws = new WebSocket(`${wsBaseUrl}?room=${encodeURIComponent(roomId)}`);
  const welcomePromise = waitForMessage(ws, message => message.type === 'welcome', {
    label: `${nickname} welcome`,
  });
  await waitForEvent(ws, 'open');
  ws.send(JSON.stringify({
    type: 'hello',
    nickname,
    device: 'Node Web Smoke',
    userId: `${nickname.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`,
  }));
  const welcome = await welcomePromise;
  ws.presenceId = welcome.id;
  return ws;
}

async function closeWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CLOSING) {
    await waitForEvent(ws, 'close', 5000).catch(() => {});
    return;
  }
  ws.terminate();
  await waitForEvent(ws, 'close', 5000).catch(() => {});
}

async function stopPresenceServer(server) {
  if (!server) return;
  await Promise.race([
    server.stop(),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
}

function csharpString(value) {
  return `System.Text.Encoding.UTF8.GetString(System.Convert.FromBase64String("${Buffer.from(value).toString('base64')}"))`;
}

async function executeUnityCode(code) {
  const { stdout, stderr } = await execFileAsync(
    uloopBin,
    ['--project-path', unityProject, 'execute-dynamic-code', '--code', code],
    { maxBuffer: 1024 * 1024 * 8 },
  );
  const output = `${stdout || ''}${stderr || ''}`.trim();
  if (output) {
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // Keep raw output for error reporting below.
    }
    if (parsed && parsed.success === false) {
      throw new Error(output);
    }
  }
  return output;
}

function createUnitySetupCode({ presenceUrl, roomId }) {
  const scenePhysicsJson = JSON.stringify({
    version: 1,
    enabled: true,
    duration: 4,
    worldOptions: {
      gravity: -9.81,
      ground: null,
      timestep: 1 / 60,
    },
  });
  const objectPhysicsJson = JSON.stringify({
    version: 1,
    enabled: true,
    bodyType: 'dynamic',
    shape: 'box',
    halfExtents: [0.5, 0.5, 0.5],
    mass: 1,
    restitution: 0.2,
    friction: 0.5,
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  });

  return `
using System;
using System.Reflection;
using System.Threading.Tasks;
using UnityEngine;
using Afjk.SceneSync;
using Afjk.SceneSync.Rapier;

var rootName = ${csharpString(rootName)};
var presenceUrl = ${csharpString(presenceUrl)};
var roomId = ${csharpString(roomId)};

void SetPrivate(object target, string fieldName, object value)
{
    var field = target.GetType().GetField(fieldName, BindingFlags.Instance | BindingFlags.NonPublic);
    if (field == null) throw new Exception("Missing field " + fieldName + " on " + target.GetType().Name);
    field.SetValue(target, value);
}

void InvokePrivate(object target, string methodName)
{
    var method = target.GetType().GetMethod(methodName, BindingFlags.Instance | BindingFlags.NonPublic);
    if (method != null) method.Invoke(target, null);
}

var old = GameObject.Find(rootName);
if (old != null) UnityEngine.Object.DestroyImmediate(old);

var root = new GameObject(rootName);
var manager = root.AddComponent<SceneSyncManager>();
SetPrivate(manager, "_presenceUrl", presenceUrl);
SetPrivate(manager, "_room", roomId);
SetPrivate(manager, "_nickname", "Unity Physics Smoke");
SetPrivate(manager, "_autoConnect", false);
InvokePrivate(manager, "Awake");
InvokePrivate(manager, "OnEnable");

var sceneMetadata = root.AddComponent<SceneSyncPhysicsMetadata>();
sceneMetadata.ConfigureScenePhysics(${csharpString(scenePhysicsJson)});

var bridge = root.AddComponent<SceneSyncRapierBridge>();
SetPrivate(bridge, "autoRun", false);

var box = GameObject.CreatePrimitive(PrimitiveType.Cube);
box.name = "Unity Physics Smoke Box";
box.transform.SetParent(root.transform, false);
box.transform.position = new Vector3(0f, 1.25f, 0f);
box.transform.rotation = Quaternion.identity;
box.transform.localScale = Vector3.one;

var identity = box.AddComponent<SceneSyncIdentity>();
identity.ConfigureUnityManaged("unity-box");
var objectMetadata = box.AddComponent<SceneSyncPhysicsMetadata>();
objectMetadata.ConfigureObjectPhysics(${csharpString(objectPhysicsJson)});

InvokePrivate(bridge, "OnEnable");
InvokePrivate(bridge, "Update");

await manager.Connect();
var started = DateTime.UtcNow;
while (!manager.IsConnected && (DateTime.UtcNow - started).TotalSeconds < 10)
{
    await Task.Delay(100);
}
if (!manager.IsConnected) throw new Exception("Unity SceneSyncManager did not connect to presence");

for (var i = 0; i < 3; i++)
{
    InvokePrivate(bridge, "Update");
    await Task.Delay(20);
}
if (!bridge.HasWorld) throw new Exception("SceneSyncRapierBridge did not create a Rapier world");
if (bridge.Tick != 0) throw new Exception("Expected bridge tick 0 before remote hash, got " + bridge.Tick);
Debug.Log("ok:unity-physics-presence-setup:" + bridge.Tick + ":" + bridge.LastStateHash);
`;
}

function createUnityCleanupCode() {
  return `
using UnityEngine;
var old = GameObject.Find(${csharpString(rootName)});
if (old != null) UnityEngine.Object.DestroyImmediate(old);
Debug.Log("ok:unity-physics-presence-cleanup");
`;
}

function createUnitySnapshotApplyAssertionCode() {
  return `
using System;
using System.Threading.Tasks;
using UnityEngine;
using Afjk.SceneSync.Rapier;

var root = GameObject.Find(${csharpString(rootName)});
if (root == null) throw new Exception("Smoke root not found");
var bridge = root.GetComponent<SceneSyncRapierBridge>();
if (bridge == null) throw new Exception("SceneSyncRapierBridge not found");

var started = DateTime.UtcNow;
while (!bridge.HasRemoteSnapshotReport && (DateTime.UtcNow - started).TotalSeconds < 10)
{
    await Task.Delay(100);
}

if (!bridge.HasRemoteSnapshotReport) throw new Exception("Unity did not receive a physics snapshot");
if (!bridge.LastRemoteSnapshotApplied)
{
    var report = bridge.LastRemoteSnapshotReport;
    throw new Exception(
        "Unity did not apply physics snapshot: bodyCount=" + report.BodyCount
        + " dynamicBodyCount=" + report.DynamicBodyCount
        + " appliedBodyCount=" + report.AppliedBodyCount
        + " missingBodyCount=" + report.MissingBodyCount);
}

Debug.Log(
    "ok:unity-physics-snapshot-applied:"
    + bridge.LastRemoteSnapshotReport.Tick
    + ":"
    + bridge.LastRemoteSnapshotReport.LocalHash
    + ":"
    + bridge.LastRemoteSnapshotReport.HashMatched);
`;
}

function createPhysicsHashPayload() {
  return {
    kind: 'scene-physics-hash',
    source: 'physics',
    phase: 'postPhysics',
    profile: 'SceneSyncRapierParity-0.30',
    hashVersion: 'SceneSyncCanonicalPhysicsHashV1',
    rapierCoreVersion: '0.19.3',
    tick: 0,
    hash: '0000000000000000',
    timestep: 1 / 60,
    activeTime: 0,
    worldAge: 0,
    worldEpochTime: 0,
    sceneClockRevision: 1,
    controller: {
      id: 'web-physics-smoke',
      nickname: 'Web Physics Smoke',
    },
    sentAt: Date.now(),
  };
}

function createPhysicsSnapshotPayload(requestPayload) {
  return {
    kind: 'scene-physics-snapshot',
    source: 'physics',
    phase: 'postPhysics',
    snapshotVersion: 'SceneSyncPhysicsSnapshotV1',
    profile: requestPayload.profile || 'SceneSyncRapierParity-0.30',
    hashVersion: requestPayload.hashVersion || 'SceneSyncCanonicalPhysicsHashV1',
    rapierCoreVersion: '0.19.3',
    tick: requestPayload.localTick,
    hash: requestPayload.localHash,
    timestep: 1 / 60,
    activeTime: 0,
    worldAge: 0,
    worldEpochTime: 0,
    sceneClockRevision: requestPayload.sceneClockRevision,
    requestId: requestPayload.requestId,
    requestTick: requestPayload.tick,
    requestReason: requestPayload.reason,
    bodyCount: 1,
    bodies: [{
      id: 'unity-box',
      type: 'dynamic',
      position: [0, 1.25, 0],
      rotation: [0, 0, 0, 1],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    }],
  };
}

async function run() {
  const presenceServer = createPresenceServer();
  await listenPresenceServer(presenceServer);
  const wsBaseUrl = `${serverUrl(presenceServer, 'ws')}/ws`;
  const roomId = `unity-physics-${Date.now().toString(36)}`;
  let webWs;

  try {
    webWs = await connectPresenceClient(wsBaseUrl, roomId, 'Web Physics Smoke');

    const unityPeerPromise = waitForMessage(webWs, message => (
      message.type === 'peers'
      && Array.isArray(message.peers)
      && message.peers.some(peer => peer.nickname === 'Unity Physics Smoke')
    ), { label: 'Unity peer presence' });

    await executeUnityCode(createUnitySetupCode({
      presenceUrl: wsBaseUrl,
      roomId,
    }));

    await unityPeerPromise;

    const requestPromise = waitForMessage(webWs, message => (
      message.type === 'handoff'
      && message.payload?.kind === 'scene-physics-snapshot-request'
      && message.payload?.source === 'physics'
      && message.payload?.reason === 'hash-mismatch'
      && message.payload?.tick === 0
      && message.payload?.localTick === 0
      && typeof message.payload?.requestId === 'string'
    ), { label: 'Unity scene-physics-snapshot-request' });

    webWs.send(JSON.stringify({
      type: 'broadcast',
      payload: createPhysicsHashPayload(),
    }));

    const requestMessage = await requestPromise;
    assert.equal(requestMessage.payload.snapshotVersion, 'SceneSyncPhysicsSnapshotV1');
    assert.equal(requestMessage.payload.hashVersion, 'SceneSyncCanonicalPhysicsHashV1');
    assert.equal(requestMessage.payload.remoteHash, '0000000000000000');
    assert.equal(typeof requestMessage.payload.localHash, 'string');
    assert.notEqual(requestMessage.payload.localHash, requestMessage.payload.remoteHash);
    assert.equal(typeof requestMessage.from?.id, 'string');

    webWs.send(JSON.stringify({
      type: 'handoff',
      targetId: requestMessage.from.id,
      payload: createPhysicsSnapshotPayload(requestMessage.payload),
    }));

    await executeUnityCode(createUnitySnapshotApplyAssertionCode());

    console.log(JSON.stringify({
      ok: true,
      roomId,
      unityPeer: requestMessage.from?.id || null,
      requestId: requestMessage.payload.requestId,
      localHash: requestMessage.payload.localHash,
      snapshotApplied: true,
    }, null, 2));
  } finally {
    await executeUnityCode(createUnityCleanupCode()).catch(() => {});
    await closeWebSocket(webWs);
    await stopPresenceServer(presenceServer);
  }
}

run().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
