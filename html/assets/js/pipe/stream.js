// ── WHIP/WHEP streaming module ────────────────────────────────────────────────

let _deps = null;

const _state = {
  isStreaming: false,
  isWatching: false,
  localStream: null,
  publisherPc: null,
  viewerPc: null,
  activeStreamerNickname: null,
  cameras: [],           // MediaDeviceInfo[]
  facingMode: null,      // 'user' | 'environment' | null
  deviceId: null,        // deviceId string | null
  isMobile: navigator.maxTouchPoints > 0,
  broadcastMode: null,   // 'camera' | 'screen' | null
};

export function initStreamModule(deps) {
  _deps = deps;
}

// ── Called by app.js on peer list update ──────────────────────────────────────

export function onStreamingPeersChange(peers) {
  const streamer = peers.find(p => p.streaming);
  _state.activeStreamerNickname = streamer ? (streamer.nickname || '?') : null;

  _setLiveDot(!!streamer || _state.isStreaming);

  if (streamer && !_state.isWatching && !_state.isStreaming) {
    const tab = document.getElementById('tab-stream');
    if (tab?.classList.contains('active')) {
      startWatch();
      return;
    }
  }

  if (!streamer && _state.isWatching) {
    stopWatch();
    return;
  }

  _renderTab();
}

export function onStreamTabEntered() {
  if (_state.activeStreamerNickname && !_state.isWatching && !_state.isStreaming) {
    startWatch();
    return;
  }
  // Enumerate cameras when tab opens (labels become available after permission)
  _loadCameras();
  _renderTab();
}

// ── Camera management ─────────────────────────────────────────────────────────

async function _loadCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    _state.cameras = devices.filter(d => d.kind === 'videoinput');
  } catch {
    _state.cameras = [];
  }
  _updateCameraSelect();
}

function _updateCameraSelect() {
  const sel = document.getElementById('stream-camera-select');
  if (!sel) return;

  const currentDeviceId = _state.localStream
    ?.getVideoTracks()[0]?.getSettings()?.deviceId;

  const prev = sel.value;
  sel.innerHTML = '';

  if (_state.cameras.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = _deps.t('streamNoCameras');
    sel.appendChild(opt);
    return;
  }

  _state.cameras.forEach((cam, i) => {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `${_deps.t('streamCameraLabel')} ${i + 1}`;
    if (cam.deviceId === (currentDeviceId || prev)) opt.selected = true;
    sel.appendChild(opt);
  });

  // Flip button: show when ≥2 cameras
  const flipBtn = document.getElementById('stream-flip-btn');
  if (flipBtn) flipBtn.style.display = _state.cameras.length >= 2 ? '' : 'none';
}

function _videoConstraints() {
  if (_state.deviceId) return { deviceId: { exact: _state.deviceId } };
  if (_state.facingMode) return { facingMode: _state.facingMode };
  // Mobile default: front camera
  if (_state.isMobile) return { facingMode: 'user' };
  return true;
}

// Replace video track without renegotiation (mid-stream camera switch)
async function _replaceVideoTrack(videoConstraints) {
  const newStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
  const newTrack = newStream.getVideoTracks()[0];
  if (!newTrack) throw new Error('no video track');

  if (_state.publisherPc) {
    const sender = _state.publisherPc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);
  }

  _state.localStream?.getVideoTracks().forEach(t => t.stop());

  const audio = _state.localStream?.getAudioTracks() ?? [];
  _state.localStream = new MediaStream([newTrack, ...audio]);

  const localVideo = document.getElementById('stream-local-video');
  if (localVideo) localVideo.srcObject = _state.localStream;

  await _loadCameras();
}

// Flip between front / back camera
export async function flipCamera() {
  const next = (_state.facingMode === 'environment') ? 'user' : 'environment';
  _state.facingMode = next;
  _state.deviceId = null;

  if (_state.isStreaming) {
    try {
      _setStatus(_deps.t('streamSwitchingCamera'), 'waiting');
      await _replaceVideoTrack({ facingMode: next });
      _setStatus(_deps.t('streamStatusLive'), 'ok');
    } catch (e) {
      _setStatus(`${_deps.t('streamError')}: ${e.message}`, 'err');
    }
  }
}

// Select a specific camera by deviceId
export async function selectCamera(deviceId) {
  if (!deviceId) return;
  _state.deviceId = deviceId;
  _state.facingMode = null;

  if (_state.isStreaming) {
    try {
      _setStatus(_deps.t('streamSwitchingCamera'), 'waiting');
      await _replaceVideoTrack({ deviceId: { exact: deviceId } });
      _setStatus(_deps.t('streamStatusLive'), 'ok');
    } catch (e) {
      _setStatus(`${_deps.t('streamError')}: ${e.message}`, 'err');
    }
  }
}

// ── Room resolution ───────────────────────────────────────────────────────────

// Returns the room code to use for WHIP/WHEP.
// Falls back to the presence server's IP-based room (sanitized for the path regex).
function _effectiveRoomCode() {
  const explicit = _deps.getActiveRoomCode();
  if (explicit) return explicit;
  const presence = _deps.getPresenceRoom?.();
  if (!presence) return null;
  return presence.replace(/\./g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 24) || null;
}

// ── WHIP — publish ────────────────────────────────────────────────────────────

// Shared WHIP publish logic (used by both camera and screen share)
async function _doPublish(stream) {
  const { t, fetchIceServers, getStreamBase, sendPresenceHello } = _deps;
  const roomCode = _effectiveRoomCode();

  const iceServers = await fetchIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  _state.publisherPc = pc;
  stream.getTracks().forEach(track => pc.addTrack(track, stream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await _waitForIce(pc);

  _setStatus(t('streamConnecting'), 'waiting');
  const res = await fetch(`${getStreamBase()}/room/${roomCode}/whip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription.sdp,
  });
  if (!res.ok) throw new Error(`WHIP ${res.status}`);
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });

  _state.isStreaming = true;
  _deps.setStreamingActive(true);
  sendPresenceHello();
  _setLiveDot(true);
  _setStatus(t('streamStatusLive'), 'ok');
  _renderTab();

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      stopBroadcast();
    }
  };
}

export async function startBroadcast() {
  if (_state.isStreaming || _state.isWatching) return;
  const { t } = _deps;
  if (!_effectiveRoomCode()) { _setStatus(t('streamNoRoom'), 'err'); return; }

  try {
    _setStatus(t('streamGettingMedia'), 'waiting');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: _videoConstraints(),
      audio: true,
    });
    _state.localStream = stream;
    _state.broadcastMode = 'camera';

    const localVideo = document.getElementById('stream-local-video');
    if (localVideo) localVideo.srcObject = stream;

    await _loadCameras();
    _renderTab();
    await _doPublish(stream);
  } catch (e) {
    _setStatus(`${_deps.t('streamError')}: ${e.message}`, 'err');
    _cleanupBroadcast();
    _state.broadcastMode = null;
    _renderTab();
  }
}

export async function startScreenShare() {
  if (_state.isStreaming || _state.isWatching) return;
  const { t } = _deps;
  if (!_effectiveRoomCode()) { _setStatus(t('streamNoRoom'), 'err'); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    _setStatus(t('streamNoDisplayMedia'), 'err');
    return;
  }

  try {
    _setStatus(t('streamGettingDisplay'), 'waiting');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

    // Add mic if display stream has no audio (e.g. iOS, some desktop configs)
    if (stream.getAudioTracks().length === 0) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        mic.getAudioTracks().forEach(t => stream.addTrack(t));
      } catch { /* no mic available, proceed without audio */ }
    }

    _state.localStream = stream;
    _state.broadcastMode = 'screen';

    const localVideo = document.getElementById('stream-local-video');
    if (localVideo) localVideo.srcObject = stream;
    _renderTab();

    // Auto-stop when user ends share via OS/browser UI
    stream.getVideoTracks()[0].onended = () => stopBroadcast();

    await _doPublish(stream);
  } catch (e) {
    _setStatus(`${_deps.t('streamError')}: ${e.message}`, 'err');
    _cleanupBroadcast();
    _state.broadcastMode = null;
    _renderTab();
  }
}

export function stopBroadcast() {
  const { sendPresenceHello, setStreamingActive } = _deps;
  _cleanupBroadcast();
  _state.isStreaming = false;
  _state.broadcastMode = null;
  setStreamingActive(false);
  sendPresenceHello();
  _setLiveDot(!!_state.activeStreamerNickname);
  _setStatus('', '');
  _renderTab();
}

// ── WHEP — view ───────────────────────────────────────────────────────────────

export async function startWatch() {
  if (_state.isWatching || _state.isStreaming) return;
  const { t, fetchIceServers, getStreamBase } = _deps;
  const roomCode = _effectiveRoomCode();
  if (!roomCode) return;

  try {
    _setStatus(t('streamConnectingViewer'), 'waiting');
    const iceServers = await fetchIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    _state.viewerPc = pc;

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const remoteVideo = document.getElementById('stream-remote-video');
    pc.ontrack = e => {
      if (remoteVideo && e.streams[0]) remoteVideo.srcObject = e.streams[0];
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await _waitForIce(pc);

    const res = await fetch(`${getStreamBase()}/room/${roomCode}/whep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) throw new Error(`WHEP ${res.status}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });

    _state.isWatching = true;
    _setStatus(t('streamStatusViewing'), 'ok');
    _renderTab();

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        stopWatch();
      }
    };
  } catch (e) {
    _setStatus(`${t('streamError')}: ${e.message}`, 'err');
    _cleanupViewer();
    _renderTab();
  }
}

export function stopWatch() {
  _cleanupViewer();
  _state.isWatching = false;
  _setStatus('', '');
  _renderTab();
}

// ── Cleanup helpers ───────────────────────────────────────────────────────────

function _cleanupBroadcast() {
  _state.localStream?.getTracks().forEach(t => t.stop());
  _state.localStream = null;
  _state.publisherPc?.close();
  _state.publisherPc = null;
  const v = document.getElementById('stream-local-video');
  if (v) v.srcObject = null;
}

function _cleanupViewer() {
  _state.viewerPc?.close();
  _state.viewerPc = null;
  const v = document.getElementById('stream-remote-video');
  if (v) { v.srcObject = null; v.pause(); }
}

// ── ICE gathering ─────────────────────────────────────────────────────────────

function _waitForIce(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(resolve, 4000);
  });
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function _setLiveDot(show) {
  const dot = document.getElementById('tab-live-dot');
  if (!dot) return;
  dot.hidden = !show;
}

function _setStatus(msg, cls = '') {
  const el = document.getElementById('stream-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `status${cls ? ' ' + cls : ''}`;
}

export function renderStreamTab() {
  _renderTab();
}

function _renderTab() {
  const startBtn     = document.getElementById('stream-start-btn');
  const screenBtn    = document.getElementById('stream-screen-btn');
  const stopBtn      = document.getElementById('stream-stop-btn');
  const watchBtn     = document.getElementById('stream-watch-btn');
  const leaveBtn     = document.getElementById('stream-leave-btn');
  const localVideo   = document.getElementById('stream-local-video');
  const remoteVideo  = document.getElementById('stream-remote-video');
  const watchSection = document.getElementById('stream-watch-section');
  const whoEl        = document.getElementById('stream-who');
  const cameraRow    = document.getElementById('stream-camera-row');
  const flipBtn      = document.getElementById('stream-flip-btn');
  if (!startBtn) return;

  const { t } = _deps;
  const hasStreamer = !!_state.activeStreamerNickname;
  const broadcasting = _state.isStreaming || _state.isWatching;
  const isScreen   = _state.broadcastMode === 'screen';

  // Camera row: hide when watching or screen sharing
  if (cameraRow) cameraRow.style.display = (_state.isWatching || isScreen) ? 'none' : '';

  // Flip button: only when camera-streaming with ≥2 cameras
  if (flipBtn) flipBtn.style.display =
    (_state.isStreaming && !isScreen && _state.cameras.length >= 2) ? '' : 'none';

  // Broadcast controls — disabled only when someone else is already streaming
  const btnTitle = hasStreamer ? t('streamAlreadyLive') : '';
  startBtn.style.display = broadcasting ? 'none' : '';
  startBtn.disabled      = hasStreamer;
  startBtn.title         = btnTitle;
  if (screenBtn) {
    screenBtn.style.display = broadcasting ? 'none' : '';
    screenBtn.disabled      = hasStreamer;
    screenBtn.title         = btnTitle;
  }
  stopBtn.style.display  = _state.isStreaming ? '' : 'none';
  if (localVideo) localVideo.style.display = _state.isStreaming ? 'block' : 'none';

  // Viewer section
  if (_state.isWatching) {
    watchSection.style.display = '';
    if (watchBtn) watchBtn.style.display = 'none';
    leaveBtn.style.display = '';
    if (remoteVideo) remoteVideo.style.display = 'block';
  } else if (!_state.isStreaming && hasStreamer) {
    watchSection.style.display = '';
    if (watchBtn) watchBtn.style.display = '';
    leaveBtn.style.display = 'none';
    if (remoteVideo) remoteVideo.style.display = 'none';
  } else {
    watchSection.style.display = 'none';
    if (remoteVideo) remoteVideo.style.display = 'none';
  }

  if (whoEl) {
    whoEl.textContent = hasStreamer ? t('streamFrom')(_state.activeStreamerNickname) : '';
    whoEl.style.display = hasStreamer ? '' : 'none';
  }
}

// Cleanup on page unload
export function cleanupStream() {
  if (_state.isStreaming) stopBroadcast();
  if (_state.isWatching) stopWatch();
}
