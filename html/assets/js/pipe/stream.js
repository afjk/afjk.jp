// ── WHIP/WHEP streaming module ────────────────────────────────────────────────
// Provides startBroadcast / stopBroadcast (WHIP) and startWatch / stopWatch (WHEP).
// Integrates with presence for live-dot and auto-watch.

let _deps = null;

const _state = {
  isStreaming: false,
  isWatching: false,
  localStream: null,
  publisherPc: null,
  viewerPc: null,
  activeStreamerNickname: null, // nickname of the peer who is currently streaming
};

export function initStreamModule(deps) {
  _deps = deps;
}

// ── Called by app.js on peer list update ──────────────────────────────────────

export function onStreamingPeersChange(peers) {
  const streamer = peers.find(p => p.streaming);
  _state.activeStreamerNickname = streamer ? (streamer.nickname || '?') : null;

  // Live dot: anyone in the room is streaming (including self)
  _setLiveDot(!!streamer || _state.isStreaming);

  if (streamer && !_state.isWatching && !_state.isStreaming) {
    // Auto-watch if stream tab is already open
    const tab = document.getElementById('tab-stream');
    if (tab?.classList.contains('active')) {
      startWatch();
      return;
    }
  }

  // Streamer disconnected while we were watching
  if (!streamer && _state.isWatching) {
    stopWatch();
    return;
  }

  _renderTab();
}

// Called when the user clicks the stream tab
export function onStreamTabEntered() {
  if (_state.activeStreamerNickname && !_state.isWatching && !_state.isStreaming) {
    startWatch();
    return;
  }
  _renderTab();
}

// ── WHIP — publish ────────────────────────────────────────────────────────────

export async function startBroadcast() {
  if (_state.isStreaming || _state.isWatching) return;
  const { t, fetchIceServers, getStreamBase, getActiveRoomCode, sendPresenceHello } = _deps;
  const roomCode = getActiveRoomCode();
  if (!roomCode) {
    _setStatus(t('streamNoRoom'), 'err');
    return;
  }

  try {
    _setStatus(t('streamGettingMedia'), 'waiting');
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    _state.localStream = stream;

    const localVideo = document.getElementById('stream-local-video');
    if (localVideo) localVideo.srcObject = stream;
    _renderTab();

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
  } catch (e) {
    _setStatus(`${t('streamError')}: ${e.message}`, 'err');
    _cleanupBroadcast();
    _renderTab();
  }
}

export function stopBroadcast() {
  const { sendPresenceHello, setStreamingActive } = _deps;
  _cleanupBroadcast();
  _state.isStreaming = false;
  setStreamingActive(false);
  sendPresenceHello();
  _setLiveDot(!!_state.activeStreamerNickname);
  _setStatus('', '');
  _renderTab();
}

// ── WHEP — view ───────────────────────────────────────────────────────────────

export async function startWatch() {
  if (_state.isWatching || _state.isStreaming) return;
  const { t, fetchIceServers, getStreamBase, getActiveRoomCode } = _deps;
  const roomCode = getActiveRoomCode();
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
    setTimeout(resolve, 4000); // fallback timeout
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
  const stopBtn      = document.getElementById('stream-stop-btn');
  const watchBtn     = document.getElementById('stream-watch-btn');
  const leaveBtn     = document.getElementById('stream-leave-btn');
  const localVideo   = document.getElementById('stream-local-video');
  const remoteVideo  = document.getElementById('stream-remote-video');
  const watchSection = document.getElementById('stream-watch-section');
  const whoEl        = document.getElementById('stream-who');
  if (!startBtn) return;

  const { t, getActiveRoomCode } = _deps;
  const hasStreamer = !!_state.activeStreamerNickname;
  const noRoom     = !getActiveRoomCode();

  // Broadcast controls
  startBtn.style.display = (_state.isStreaming || _state.isWatching) ? 'none' : '';
  startBtn.disabled      = noRoom || hasStreamer;
  startBtn.title         = noRoom ? t('streamNoRoom') : (hasStreamer ? t('streamAlreadyLive') : '');
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
    if (hasStreamer) {
      whoEl.textContent = t('streamFrom')(_state.activeStreamerNickname);
      whoEl.style.display = '';
    } else {
      whoEl.style.display = 'none';
    }
  }
}

// Cleanup on page unload
export function cleanupStream() {
  if (_state.isStreaming) stopBroadcast();
  if (_state.isWatching) stopWatch();
}
