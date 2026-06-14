const STYLE_ID = 'scene-sync-viewer-shell-style';
const BODY_CLASS = 'scene-sync-shell-viewer';

const ENVIRONMENTS = ['studio', 'outdoor_day', 'outdoor_sunset', 'outdoor_night', 'indoor_warm'];
const ENV_LABEL = {
  studio: 'Studio',
  outdoor_day: 'Day',
  outdoor_sunset: 'Sunset',
  outdoor_night: 'Night',
  indoor_warm: 'Indoor',
};

const ICON = {
  reset: '<path d="M3 11a9 9 0 1 1 2.6 6.4"/><path d="M3 19v-5h5"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"/>',
};

async function ensureStylesheet() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./viewer-shell.css', import.meta.url).href;
  document.head.appendChild(link);
}

function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ''}</svg>`;
}

// 鑑賞用シェル。編集 chrome を隠し、Play（interact）既定で
// ナビゲーション補助のみを提供する。command/state API のみで構築。
export function createSceneSyncShell({ id = 'viewer', requestedId = 'viewer', availableShellIds = [] } = {}) {
  let root = null;
  let removeStateListener = null;

  function render(core) {
    if (!root) return;
    const conn = core?.getConnectionState?.() || {};
    const connEl = root.querySelector('[data-viewer-conn]');
    if (connEl) {
      const room = conn.room || '—';
      const peers = Number.isFinite(conn.peerCount) ? conn.peerCount : 0;
      connEl.textContent = conn.connected ? `${room} · ${peers} peer${peers === 1 ? '' : 's'}` : 'connecting…';
    }
    const envEl = root.querySelector('[data-viewer-env-label]');
    if (envEl) {
      const env = core?.getEditorState?.()?.environmentId;
      envEl.textContent = ENV_LABEL[env] || 'Environment';
    }
  }

  function cycleEnvironment(core) {
    const current = core?.getEditorState?.()?.environmentId;
    const idx = ENVIRONMENTS.indexOf(current);
    const next = ENVIRONMENTS[(idx + 1) % ENVIRONMENTS.length];
    core?.commands?.setEnvironment?.(next);
  }

  return {
    id,
    requestedId,
    name: 'Viewer Shell',
    kind: 'viewer',
    layouts: ['desktop', 'mobile'],
    inputs: ['pointer', 'touch'],

    async mount({ core } = {}) {
      await ensureStylesheet();

      document.body.dataset.sceneSyncShell = 'viewer';
      document.body.classList.add(BODY_CLASS);
      document.body.classList.remove('scene-sync-shell-editor', 'scene-sync-shell-minimal', 'scene-sync-shell-player', 'scene-sync-shell-studio');

      // 鑑賞は Play（interact）既定。クリックでオブジェクトを activate できる。
      core?.commands?.setInputRoutingMode?.('interact');
      core?.commands?.activateSceneClockTransport?.({ mode: 'shared-playback' });

      root = document.createElement('div');
      root.className = 'viewer-shell';
      root.setAttribute('aria-label', 'Scene Sync Viewer');
      root.innerHTML = `
        <div class="viewer-badge">
          <span class="viewer-badge-title">VIEWER</span>
          <span class="viewer-badge-conn" data-viewer-conn>connecting…</span>
        </div>
        <div class="viewer-dock">
          <button class="viewer-btn" data-viewer-reset type="button" title="Reset View">
            ${icon('reset')}<span>Reset View</span>
          </button>
          <button class="viewer-btn" data-viewer-env type="button" title="Environment">
            ${icon('sun')}<span data-viewer-env-label>Environment</span>
          </button>
        </div>
      `;

      root.querySelector('[data-viewer-reset]')?.addEventListener('click', () => core?.commands?.resetView?.());
      root.querySelector('[data-viewer-env]')?.addEventListener('click', () => cycleEnvironment(core));

      document.body.appendChild(root);
      removeStateListener = core?.onStateChange?.(() => render(core)) ?? null;
      render(core);

      if (core?.debug) {
        console.debug('[SceneSyncShell] mounted viewer shell', { requestedId, availableShellIds });
      }
    },

    unmount() {
      removeStateListener?.();
      removeStateListener = null;
      root?.remove();
      root = null;
      document.body.classList.remove(BODY_CLASS);
      delete document.body.dataset.sceneSyncShell;
    },
  };
}

export default createSceneSyncShell;
