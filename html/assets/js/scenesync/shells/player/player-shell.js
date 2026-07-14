import { createPlayerTransportPanel, normalizeUiClockMode } from './player-transport.js';

const BODY_CLASS = 'scene-sync-shell-player';
const CLOCK_MODE_STORAGE_KEY = 'scene-sync-player-clock-mode';

// 不正値・未保存・storage 例外は normalizeUiClockMode が 'local-preview' に落とす
function readStoredClockMode() {
  try {
    return normalizeUiClockMode(localStorage.getItem(CLOCK_MODE_STORAGE_KEY));
  } catch {
    return 'local-preview';
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
      removeStateListener = core?.onStateChange?.((event = {}) => {
        // mode 変更は必ず scene-clock 系 reason で通知される。高頻度な
        // scene-delta / physics 系イベントで O(N) の getSceneClockState を呼ばない
        if (typeof event.reason === 'string' && !event.reason.startsWith('scene-clock')) return;
        const state = core?.getSceneClockState?.();
        if (!state) return;
        const nextMode = normalizeUiClockMode(state.mode);
        if (nextMode === lastSavedMode) return;
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
