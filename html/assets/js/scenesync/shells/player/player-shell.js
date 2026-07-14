import { createPlayerTransportPanel } from './player-transport.js';

const BODY_CLASS = 'scene-sync-shell-player';
const CLOCK_MODE_STORAGE_KEY = 'scene-sync-player-clock-mode';
const CLOCK_MODES = ['local-preview', 'shared-playback', 'room-time'];
const DEFAULT_CLOCK_MODE = 'local-preview';

function normalizePlayerClockMode(mode) {
  if (mode === 'local') return 'local-preview';
  if (mode === 'host-follow') return 'room-time';
  return CLOCK_MODES.includes(mode) ? mode : null;
}

function readStoredClockMode() {
  try {
    return normalizePlayerClockMode(localStorage.getItem(CLOCK_MODE_STORAGE_KEY)) || DEFAULT_CLOCK_MODE;
  } catch {
    return DEFAULT_CLOCK_MODE;
  }
}

function writeStoredClockMode(mode) {
  try {
    localStorage.setItem(CLOCK_MODE_STORAGE_KEY, mode);
  } catch {
    // storage 不可（プライベートモード等）ではセッション内デフォルトのまま
  }
}

export function createSceneSyncShell({ id = 'player', requestedId = 'player', availableShellIds = [] } = {}) {
  let transport = null;
  let mountedCore = null;
  let removeStateListener = null;

  return {
    id,
    requestedId,
    name: 'Player Shell',
    kind: 'player',
    layouts: ['desktop', 'mobile'],
    inputs: ['player-physics-drag'],

    async mount({ core, root } = {}) {
      mountedCore = core;
      document.body.dataset.sceneSyncShell = 'player';
      document.body.classList.add(BODY_CLASS);
      document.body.classList.remove('scene-sync-shell-editor', 'scene-sync-shell-minimal');

      transport = createPlayerTransportPanel({
        title: 'SCENE SYNC · PLAYER',
        activateOnMount: true,
      });
      await transport.mount({ core, root: root || document.body });

      const mode = readStoredClockMode();
      core?.commands?.activateSceneClockTransport?.({ mode });
      if (mode === 'local-preview') {
        // Play に入ったら毎回 t=0 から即ローカル再生（local-preview は broadcast されない）
        core?.commands?.resetSceneClock?.();
        core?.commands?.playSceneClock?.();
      }

      let lastSavedMode = mode;
      removeStateListener = core?.onStateChange?.(() => {
        const nextMode = normalizePlayerClockMode(core?.getSceneClockState?.()?.mode);
        if (!nextMode || nextMode === lastSavedMode) return;
        lastSavedMode = nextMode;
        writeStoredClockMode(nextMode);
      }) ?? null;
    },

    unmount() {
      removeStateListener?.();
      removeStateListener = null;
      mountedCore?.commands?.deactivateSceneClockTransport?.();
      transport?.unmount?.();
      transport = null;
      mountedCore = null;
      document.body.classList.remove(BODY_CLASS);
      delete document.body.dataset.sceneSyncShell;
    },
  };
}

export default createSceneSyncShell;
