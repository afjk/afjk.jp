import * as THREE from 'three';
import { createLockstepSession, tickForElapsedMs } from './physics/index.js';

const VERSION = 1;
const DEFAULT_ROOM = 'physics-toy';
const WORLD_OPTIONS = { gravity: -9.81, ground: { y: 0, restitution: 0.35, friction: 0.72 } };
const $ = (id) => document.getElementById(id);
const ui = {
  canvas: $('c'), room: $('room'), connect: $('connect'), reset: $('reset'), ball: $('ball'), crate: $('crate'), push: $('push'), copy: $('copy'), open: $('open'),
  status: $('status'), tick: $('tick'), bodies: $('bodies'), hash: $('hash'), peers: $('peers'), log: $('log'),
};
let ws = null;
let online = false;
let peerId = `local-${Math.random().toString(36).slice(2, 9)}`;
let session = null;
let startHostTime = Date.now();
let hasRemoteState = false;
let lastStateReplyAt = 0;
let ballCount = 0;
let crateCount = 0;

const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101827);
scene.fog = new THREE.Fog(0x101827, 14, 34);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 100);
camera.position.set(6, 5.2, 8.4);
camera.lookAt(0, 1.1, 0);
scene.add(new THREE.HemisphereLight(0xdbe9ff, 0x151b28, 2.0));
const light = new THREE.DirectionalLight(0xffffff, 2.3);
light.position.set(4, 8, 5);
scene.add(light);
const floor = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.08, 7.2), new THREE.MeshStandardMaterial({ color: 0x263247, roughness: 0.86 }));
floor.position.y = -0.04;
scene.add(floor);
const grid = new THREE.GridHelper(9.2, 23, 0x4e6b9f, 0x253650);
grid.position.y = 0.01;
scene.add(grid);
const mats = {
  sphere: new THREE.MeshStandardMaterial({ color: 0x6ea8ff, roughness: 0.48 }),
  crate: new THREE.MeshStandardMaterial({ color: 0xffbd66, roughness: 0.62 }),
  fixed: new THREE.MeshStandardMaterial({ color: 0x7ee0a7, roughness: 0.72 }),
};
const meshes = new Map();

function roomId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) || DEFAULT_ROOM;
}
function currentRoom() {
  return roomId(new URLSearchParams(location.search).get('room') || DEFAULT_ROOM);
}
function setRoom(room) {
  const url = new URL(location.href);
  url.searchParams.set('room', room);
  history.replaceState(null, '', url);
  ui.room.value = room;
  ui.open.href = `/scenesync/?room=${encodeURIComponent(room)}`;
}
function presenceUrl(room) {
  const encoded = encodeURIComponent(room);
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return `ws://${location.hostname}:8787?room=${encoded}`;
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/presence?room=${encoded}`;
}
function writeLog(type, text = '') {
  const line = document.createElement('div');
  line.innerHTML = `<b>${type}</b> ${new Date().toLocaleTimeString()} ${text}`;
  ui.log.appendChild(line);
  while (ui.log.childElementCount > 60) ui.log.firstElementChild.remove();
  ui.log.scrollTop = ui.log.scrollHeight;
}
function setEnabled(enabled) {
  [ui.reset, ui.ball, ui.crate, ui.push].forEach((button) => { button.disabled = !enabled; });
}
function updateUi() {
  ui.status.textContent = online ? 'online' : 'offline';
  ui.status.className = online ? 'on' : 'off';
  ui.connect.textContent = online ? 'Disconnect' : 'Connect';
  setEnabled(Boolean(session));
}
function seedTemplate() {
  const bodies = [
    { id: 'wall-left', shape: 'box', halfExtents: [0.18, 0.8, 3.2], position: [-4.2, 0.8, 0], static: true, restitution: 0.35, friction: 0.8 },
    { id: 'wall-right', shape: 'box', halfExtents: [0.18, 0.8, 3.2], position: [4.2, 0.8, 0], static: true, restitution: 0.35, friction: 0.8 },
    { id: 'back-stop', shape: 'box', halfExtents: [4.2, 0.75, 0.18], position: [0, 0.75, -3.2], static: true, restitution: 0.42, friction: 0.8 },
    { id: 'bumper', shape: 'box', halfExtents: [1.7, 0.16, 0.55], position: [-1.9, 0.32, 1.3], static: true, restitution: 0.16, friction: 0.85 },
    { id: 'target', shape: 'box', halfExtents: [0.72, 0.18, 0.72], position: [2.35, 0.18, -1.65], static: true, restitution: 0.8, friction: 0.15 },
    { id: 'crate-0', shape: 'box', halfExtents: [0.35, 0.35, 0.35], position: [1.1, 0.35, -0.25], mass: 1, restitution: 0.08, friction: 0.62 },
    { id: 'crate-1', shape: 'box', halfExtents: [0.35, 0.35, 0.35], position: [1.1, 1.05, -0.25], mass: 1, restitution: 0.08, friction: 0.62 },
    { id: 'crate-2', shape: 'box', halfExtents: [0.35, 0.35, 0.35], position: [1.1, 1.75, -0.25], mass: 1, restitution: 0.08, friction: 0.62 },
    { id: 'starter-ball', shape: 'sphere', radius: 0.34, position: [-2.9, 2.7, 1.35], mass: 1, restitution: 0.72, friction: 0.36 },
  ];
  bodies.forEach((body) => session.world.addBody(body));
  ballCount = 1;
  crateCount = 3;
}
function makeSession(nextStartHostTime = Date.now(), seed = true) {
  session = createLockstepSession({ peerId, worldOptions: WORLD_OPTIONS, commandDelayTicks: 4, snapshotIntervalTicks: 30, maxSnapshots: 12 });
  startHostTime = nextStartHostTime;
  hasRemoteState = false;
  if (seed) seedTemplate();
  updateUi();
}
function send(payload) {
  if (!online || !ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: 'broadcast', payload }));
  return true;
}
function issue(type, payload) {
  if (!session) makeSession();
  const command = session.issueCommand(type, payload);
  send({ type: 'physics-demo-command', version: VERSION, command });
  writeLog('cmd', `${type} tick=${command.tick}`);
  return command;
}
function resetShared() {
  const nextStartHostTime = Date.now() + 180;
  makeSession(nextStartHostTime, true);
  send({ type: 'physics-demo-start', version: VERSION, by: peerId, startHostTime: nextStartHostTime });
  writeLog('reset', 'shared toy restarted');
}
function addBall() {
  const id = `ball-${ballCount++}`;
  issue('add-body', { body: { id, shape: 'sphere', radius: 0.28, position: [-3.05, 3.1, 1.55], velocity: [1.2, 0, -0.35], mass: 1, restitution: 0.76, friction: 0.28 } });
}
function addCrate() {
  const id = `crate-${crateCount++}`;
  const x = 0.15 + (crateCount % 4) * 0.42;
  issue('add-body', { body: { id, shape: 'box', halfExtents: [0.32, 0.32, 0.32], position: [x, 2.8, 0.25], mass: 1, restitution: 0.12, friction: 0.72 } });
}
function pushTower() {
  ['crate-0', 'crate-1', 'crate-2'].forEach((bodyId, index) => issue('impulse', { bodyId, impulse: [-1.6 - index * 0.25, 0.3, 0.7] }));
}
function connect() {
  const room = roomId(ui.room.value);
  setRoom(room);
  ws = new WebSocket(presenceUrl(room));
  writeLog('connect', room);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', nickname: 'PhysicsToy', device: 'Scene Sync Physics Demo' }));
  ws.onmessage = (event) => {
    try { handleMessage(JSON.parse(event.data)); } catch (error) { console.error(error); writeLog('error', 'bad message'); }
  };
  ws.onclose = () => { online = false; updateUi(); writeLog('close', 'disconnected'); };
  ws.onerror = () => writeLog('error', 'websocket');
}
function disconnect() {
  if (ws) ws.close();
  ws = null;
  online = false;
  updateUi();
}
function handleMessage(message) {
  if (message.type === 'welcome') {
    peerId = String(message.id || peerId);
    online = true;
    if (!session) makeSession();
    updateUi();
    writeLog('welcome', `peer=${peerId}`);
    setTimeout(() => send({ type: 'physics-demo-state-request', version: VERSION, by: peerId }), 250);
    return;
  }
  if (message.type === 'peers') {
    ui.peers.textContent = String(message.peers?.length || 0);
    return;
  }
  if (message.type === 'handoff' && message.payload) handlePayload(message.payload);
}
function handlePayload(payload) {
  if (!payload || (payload.version && payload.version !== VERSION) || payload.by === peerId) return;
  if (payload.type === 'physics-demo-start') {
    makeSession(Number(payload.startHostTime) || Date.now(), true);
    hasRemoteState = true;
    writeLog('remote', 'reset/start');
    return;
  }
  if (payload.type === 'physics-demo-command') {
    if (!session) makeSession();
    const result = session.receiveCommand(payload.command);
    if (result.applied) writeLog('remote', `${payload.command?.type || 'command'}${result.rolledBack ? ' rollback' : ''}`);
    return;
  }
  if (payload.type === 'physics-demo-state-request') {
    if (!session || Date.now() - lastStateReplyAt < 1000) return;
    lastStateReplyAt = Date.now();
    send({ type: 'physics-demo-state', version: VERSION, by: peerId, startHostTime, state: session.createResyncState() });
    writeLog('state', 'sent');
    return;
  }
  if (payload.type === 'physics-demo-state' && payload.state) {
    if (!session || !hasRemoteState || session.tick < payload.state.tick) {
      if (!session) makeSession(Number(payload.startHostTime) || Date.now(), false);
      startHostTime = Number(payload.startHostTime) || startHostTime;
      session.applyResyncState(payload.state);
      hasRemoteState = true;
      writeLog('state', `applied tick=${payload.state.tick}`);
    }
  }
}
function materialFor(body) {
  if (body.static) return mats.fixed;
  return body.shape === 'sphere' ? mats.sphere : mats.crate;
}
function updateMeshes() {
  if (!session) return;
  const bodies = session.getBodies();
  const active = new Set();
  bodies.forEach((body) => {
    active.add(body.id);
    let mesh = meshes.get(body.id);
    if (!mesh) {
      mesh = body.shape === 'sphere'
        ? new THREE.Mesh(new THREE.SphereGeometry(body.radius, 24, 16), materialFor(body))
        : new THREE.Mesh(new THREE.BoxGeometry(body.halfExtents[0] * 2, body.halfExtents[1] * 2, body.halfExtents[2] * 2), materialFor(body));
      mesh.name = body.id;
      scene.add(mesh);
      meshes.set(body.id, mesh);
    }
    mesh.position.set(body.position[0], body.position[1], body.position[2]);
    mesh.material = materialFor(body);
  });
  for (const [id, mesh] of meshes) {
    if (!active.has(id)) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      meshes.delete(id);
    }
  }
}
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
function animate() {
  requestAnimationFrame(animate);
  if (session) {
    session.advanceTo(tickForElapsedMs(Date.now() - startHostTime, session.world.timestepFp));
    updateMeshes();
    ui.tick.textContent = String(session.tick);
    ui.bodies.textContent = String(session.getBodies().length);
    ui.hash.textContent = session.stateHash().toString(16).padStart(8, '0');
  }
  renderer.render(scene, camera);
}
ui.connect.addEventListener('click', () => (online ? disconnect() : connect()));
ui.reset.addEventListener('click', resetShared);
ui.ball.addEventListener('click', addBall);
ui.crate.addEventListener('click', addCrate);
ui.push.addEventListener('click', pushTower);
ui.copy.addEventListener('click', async () => {
  setRoom(roomId(ui.room.value));
  try { await navigator.clipboard.writeText(location.href); writeLog('copy', 'room URL'); } catch { writeLog('copy', location.href); }
});
ui.room.addEventListener('change', () => setRoom(roomId(ui.room.value)));
addEventListener('resize', resize);

setRoom(currentRoom());
makeSession();
updateUi();
animate();
setTimeout(connect, 100);
