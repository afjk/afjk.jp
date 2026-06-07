import { createPlayerActions } from './player-actions.js';

const STYLE_ID = 'scene-sync-player-shell-style';
const DEFAULT_DURATION = 60;

export async function ensurePlayerTransportStylesheet() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./player-shell.css', import.meta.url).href;
  document.head.appendChild(link);
}

function resolvePlayerDuration(core, state = null) {
  const duration = state?.duration ?? core?.getSceneClockState?.()?.duration;
  return Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_DURATION;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2).padStart(5, '0');
  return `${String(mins).padStart(2, '0')}:${secs}`;
}

function createPanelHtml({ title, closeable }) {
  return `
    <header class="player-header">
      <span class="player-title">${title}</span>
      <div class="player-badges">
        <span class="player-badge player-badge-mode" data-player-clock-mode data-mode="local">local</span>
        <span class="player-badge player-badge-status" data-player-clock-status data-paused="1">paused</span>
        ${closeable ? '<button class="player-close-btn" data-player-close type="button" title="Close">x</button>' : ''}
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
      <button class="player-rate-btn" data-player-rate="0.25" type="button">1/4x</button>
      <button class="player-rate-btn" data-player-rate="0.5" type="button">1/2x</button>
      <button class="player-rate-btn" data-player-rate="1" type="button" data-active="true">1x</button>
      <button class="player-rate-btn" data-player-rate="2" type="button">2x</button>
    </div>
  `;
}

export function createPlayerTransportPanel({
  title = 'SCENE SYNC · PLAYER',
  className = '',
  closeable = false,
  hidden = false,
  activateOnMount = false,
  onClose = null,
} = {}) {
  let panel = null;
  let actions = null;
  let removeStateListener = null;
  let rafId = null;
  let isSeeking = false;
  let lastSeekValue = null;
  let mountedCore = null;
  const disposers = [];

  function getClockState(core) {
    return core?.getSceneClockState?.() ?? {};
  }

  function updateDisplay(core) {
    if (!panel) return;
    const state = getClockState(core);
    const time = Number.isFinite(state.time) ? state.time : (state.t ?? 0);
    const isPaused = state.isPaused === true || state.playing === false;
    const mode = state.mode ?? 'local';
    const rate = state.rate ?? 1;
    const duration = resolvePlayerDuration(core, state);

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

  return {
    get element() {
      return panel;
    },

    async mount({ core, root = document.body } = {}) {
      await ensurePlayerTransportStylesheet();
      mountedCore = core;
      actions = createPlayerActions(core);

      panel = document.createElement('section');
      panel.className = ['scene-sync-player-shell', className].filter(Boolean).join(' ');
      panel.setAttribute('aria-label', title);
      panel.hidden = hidden;
      panel.innerHTML = createPanelHtml({ title, closeable });

      const seekEl = panel.querySelector('[data-player-seek]');
      disposers.push(
        addListener(seekEl, 'pointerdown', () => { isSeeking = true; }),
        addListener(seekEl, 'input', (e) => {
          const value = parseFloat(e.target.value);
          if (!Number.isFinite(value)) return;

          const timeEl = panel.querySelector('[data-player-current-time]');
          if (timeEl) timeEl.textContent = formatTime(value);

          if (lastSeekValue !== value) {
            lastSeekValue = value;
            actions.seek(value);
          }
        }),
        addListener(seekEl, 'change', (e) => {
          const value = parseFloat(e.target.value);
          if (Number.isFinite(value) && lastSeekValue !== value) {
            lastSeekValue = value;
            actions.seek(value);
          }
          isSeeking = false;
        }),
        addListener(panel.querySelector('[data-player-play-pause]'), 'click', () => {
          const state = getClockState(core);
          const isPaused = state.isPaused === true || state.playing === false;
          if (isPaused) actions.play();
          else actions.pause();
        }),
        addListener(panel.querySelector('[data-player-stop]'), 'click', () => actions.stop())
      );

      panel.querySelectorAll('[data-player-rate]').forEach(btn => {
        disposers.push(addListener(btn, 'click', () => {
          const rate = parseFloat(btn.dataset.playerRate);
          if (Number.isFinite(rate)) actions.setRate(rate);
        }));
      });

      if (closeable) {
        disposers.push(addListener(panel.querySelector('[data-player-close]'), 'click', () => {
          onClose?.();
        }));
      }

      root.appendChild(panel);
      removeStateListener = core?.onStateChange?.(() => updateDisplay(core)) ?? null;
      if (activateOnMount) core?.commands?.activateSceneClockTransport?.();
      if (!hidden) {
        startLoop(core);
      }
    },

    setHidden(nextHidden) {
      if (!panel) return;
      const shouldHide = !!nextHidden;
      if (panel.hidden === shouldHide) return;
      panel.hidden = shouldHide;
      if (shouldHide) {
        stopLoop();
      } else {
        updateDisplay(mountedCore);
        startLoop(mountedCore);
      }
    },

    unmount() {
      stopLoop();
      removeStateListener?.();
      removeStateListener = null;
      for (const dispose of disposers.splice(0)) dispose();
      panel?.remove();
      panel = null;
      actions = null;
      mountedCore = null;
      isSeeking = false;
      lastSeekValue = null;
    },
  };
}

function addListener(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}
