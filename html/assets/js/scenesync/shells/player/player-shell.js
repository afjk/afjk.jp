import { createPlayerActions } from './player-actions.js';

const STYLE_ID = 'scene-sync-player-shell-style';
const BODY_CLASS = 'scene-sync-shell-player';
const DEFAULT_DURATION = 60;

async function ensureStylesheet() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./player-shell.css', import.meta.url).href;
  document.head.appendChild(link);
}

function resolvePlayerDuration(core) {
  return core?.getSceneClockState?.()?.duration ?? DEFAULT_DURATION;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2).padStart(5, '0');
  return `${String(mins).padStart(2, '0')}:${secs}`;
}

export function createSceneSyncShell({ id = 'player', requestedId = 'player', availableShellIds = [] } = {}) {
  let panel = null;
  let actions = null;
  let removeStateListener = null;
  let rafId = null;
  let isSeeking = false;

  function getClockState(core) {
    return core?.getSceneClockState?.() ?? {};
  }

  function startLoop(core) {
    function tick() {
      updateDisplay(core);
      rafId = requestAnimationFrame(tick);
    }
    tick();
  }

  function stopLoop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function updateDisplay(core) {
    if (!panel) return;
    const state = getClockState(core);
    const time = Number.isFinite(state.time) ? state.time : (state.t ?? 0);
    const isPaused = state.isPaused === true || state.playing === false;
    const mode = state.mode ?? 'local';
    const rate = state.rate ?? 1;
    const duration = resolvePlayerDuration(core);

    const timeEl = panel.querySelector('[data-player-current-time]');
    if (timeEl) timeEl.textContent = formatTime(time);

    if (!isSeeking) {
      const seekEl = panel.querySelector('[data-player-seek]');
      if (seekEl) {
        if (parseFloat(seekEl.max) !== duration) seekEl.max = duration;
        seekEl.value = Math.min(time, duration);
      }
    }

    const playPauseBtn = panel.querySelector('[data-player-play-pause]');
    if (playPauseBtn) {
      const playing = !isPaused;
      if (playPauseBtn.dataset.playerPlaying !== (playing ? '1' : '0')) {
        playPauseBtn.dataset.playerPlaying = playing ? '1' : '0';
        playPauseBtn.title = playing ? 'Pause' : 'Play';
      }
    }

    const modeEl = panel.querySelector('[data-player-clock-mode]');
    if (modeEl && modeEl.textContent !== mode) {
      modeEl.textContent = mode;
      modeEl.dataset.mode = mode;
    }

    const statusEl = panel.querySelector('[data-player-clock-status]');
    if (statusEl) {
      const pausedStr = isPaused ? '1' : '0';
      if (statusEl.dataset.paused !== pausedStr) {
        statusEl.textContent = isPaused ? 'paused' : 'playing';
        statusEl.dataset.paused = pausedStr;
      }
    }

    panel.querySelectorAll('[data-player-rate]').forEach(btn => {
      const active = String(parseFloat(btn.dataset.playerRate) === rate);
      if (btn.dataset.active !== active) btn.dataset.active = active;
    });
  }

  return {
    id,
    requestedId,
    name: 'Player Shell',
    kind: 'player',
    layouts: ['desktop', 'mobile'],
    inputs: [],

    async mount({ core } = {}) {
      await ensureStylesheet();

      document.body.dataset.sceneSyncShell = 'player';
      document.body.classList.add(BODY_CLASS);
      document.body.classList.remove('scene-sync-shell-editor', 'scene-sync-shell-minimal');

      actions = createPlayerActions(core);

      panel = document.createElement('section');
      panel.className = 'scene-sync-player-shell';
      panel.setAttribute('aria-label', 'Scene Sync Player');
      panel.innerHTML = `
        <header class="player-header">
          <span class="player-title">SCENE SYNC · PLAYER</span>
          <div class="player-badges">
            <span class="player-badge player-badge-mode" data-player-clock-mode data-mode="local">local</span>
            <span class="player-badge player-badge-status" data-player-clock-status data-paused="1">paused</span>
          </div>
        </header>
        <div class="player-time-display">
          <span class="player-current-time" data-player-current-time>00:00.00</span>
        </div>
        <div class="player-seek-wrap">
          <input class="player-seek" data-player-seek type="range" min="0" max="60" step="0.01" value="0" />
        </div>
        <div class="player-controls">
          <button class="player-btn player-btn-stop" data-player-stop type="button" title="Stop">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <rect x="3" y="3" width="10" height="10" rx="2"/>
            </svg>
          </button>
          <button class="player-btn player-btn-play-pause" data-player-play-pause data-player-playing="0" type="button" title="Play">
            <svg class="icon-play" width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
              <polygon points="5,2 16,9 5,16"/>
            </svg>
            <svg class="icon-pause" width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
              <rect x="3" y="2" width="4" height="14" rx="1.5"/>
              <rect x="11" y="2" width="4" height="14" rx="1.5"/>
            </svg>
          </button>
        </div>
        <div class="player-rate-row">
          <span class="player-rate-label">Rate</span>
          <button class="player-rate-btn" data-player-rate="0.25" type="button">¼×</button>
          <button class="player-rate-btn" data-player-rate="0.5" type="button">½×</button>
          <button class="player-rate-btn" data-player-rate="1" type="button" data-active="true">1×</button>
          <button class="player-rate-btn" data-player-rate="2" type="button">2×</button>
        </div>
      `;

      const seekEl = panel.querySelector('[data-player-seek]');
      seekEl?.addEventListener('pointerdown', () => { isSeeking = true; });
      seekEl?.addEventListener('input', (e) => {
        // Live preview while dragging (no seek yet)
        const timeEl = panel.querySelector('[data-player-current-time]');
        if (timeEl) timeEl.textContent = formatTime(parseFloat(e.target.value));
      });
      seekEl?.addEventListener('change', (e) => {
        actions.seek(parseFloat(e.target.value));
        isSeeking = false;
      });
      seekEl?.addEventListener('pointerup', (e) => {
        actions.seek(parseFloat(e.target.value));
        isSeeking = false;
      });

      panel.querySelector('[data-player-play-pause]')?.addEventListener('click', () => {
        const state = getClockState(core);
        const isPaused = state.isPaused === true || state.playing === false;
        if (isPaused) actions.play();
        else actions.pause();
      });

      panel.querySelector('[data-player-stop]')?.addEventListener('click', () => actions.stop());

      panel.querySelectorAll('[data-player-rate]').forEach(btn => {
        btn.addEventListener('click', () => {
          const rate = parseFloat(btn.dataset.playerRate);
          if (Number.isFinite(rate)) actions.setRate(rate);
        });
      });

      document.body.appendChild(panel);
      removeStateListener = core?.onStateChange?.(() => updateDisplay(core)) ?? null;
      startLoop(core);
    },

    unmount() {
      stopLoop();
      removeStateListener?.();
      removeStateListener = null;
      panel?.remove();
      panel = null;
      actions = null;
      isSeeking = false;
      document.body.classList.remove(BODY_CLASS);
      delete document.body.dataset.sceneSyncShell;
    },
  };
}

export default createSceneSyncShell;
