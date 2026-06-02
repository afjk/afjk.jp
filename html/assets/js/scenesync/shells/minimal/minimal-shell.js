const STYLE_ID = 'scene-sync-minimal-shell-style';

async function ensureStylesheet() {
  if (document.getElementById(STYLE_ID)) return;

  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./minimal-shell.css', import.meta.url).href;
  document.head.appendChild(link);
}

function createButton(label, onClick, className = 'chip') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function getConnectionText(core) {
  const state = core?.getConnectionState?.();
  if (!state) return 'Connection: starting…';
  const room = state.room || '—';
  const peers = Number.isFinite(state.peerCount) ? state.peerCount : 0;
  return state.connected
    ? `Connected · ${room} · ${peers} peer${peers === 1 ? '' : 's'}`
    : 'Connection: reconnecting…';
}

function getSelectionText(core) {
  const selection = core?.getSelection?.();
  const ids = Array.isArray(selection?.objectIds) ? selection.objectIds : [];
  if (ids.length === 0) return 'Selection: none';
  if (ids.length === 1) return `Selection: ${ids[0]}`;
  return `Selection: ${ids.length} objects`;
}

export function createSceneSyncShell({ id = 'minimal', requestedId = 'minimal', availableShellIds = [] } = {}) {
  let panel = null;
  let removeStateListener = null;

  function update(core) {
    if (!panel) return;
    const connectionEl = panel.querySelector('[data-minimal-shell-connection]');
    const selectionEl = panel.querySelector('[data-minimal-shell-selection]');
    if (connectionEl) connectionEl.textContent = getConnectionText(core);
    if (selectionEl) selectionEl.textContent = getSelectionText(core);
  }

  return {
    id,
    requestedId,
    name: 'Minimal Shell',
    kind: 'editor',
    layouts: ['desktop', 'mobile'],
    inputs: ['mouse', 'touch'],

    async mount({ core } = {}) {
      await ensureStylesheet();

      document.body.dataset.sceneSyncShell = 'minimal';
      document.body.classList.add('scene-sync-shell-minimal');
      document.body.classList.remove('scene-sync-shell-editor');

      panel = document.createElement('section');
      panel.className = 'scene-sync-minimal-shell-panel';
      panel.setAttribute('aria-label', 'Minimal Scene Sync Shell');
      panel.innerHTML = `
        <div class="scene-sync-minimal-shell-title">Scene Sync · Minimal Shell</div>
        <div class="scene-sync-minimal-shell-note">Experimental UI swap scaffold. Core scene/runtime stays active.</div>
        <div data-minimal-shell-connection></div>
        <div data-minimal-shell-selection></div>
        <div class="scene-sync-minimal-shell-actions" data-minimal-shell-actions></div>
      `;

      const actions = panel.querySelector('[data-minimal-shell-actions]');
      actions?.append(
        createButton('Add', () => core?.commands?.openAddMenu?.()),
        createButton('Undo', () => core?.commands?.undo?.()),
        createButton('Redo', () => core?.commands?.redo?.()),
        createButton('Delete', () => core?.commands?.deleteSelected?.(), 'chip danger'),
        createButton('Export', () => core?.commands?.exportScene?.(), 'chip primary')
      );

      document.body.appendChild(panel);
      removeStateListener = core?.onStateChange?.(() => update(core)) || null;
      update(core);

      if (core?.debug) {
        console.debug('[SceneSyncShell] mounted minimal shell', {
          requestedId,
          availableShellIds,
        });
      }
    },

    unmount() {
      removeStateListener?.();
      removeStateListener = null;
      panel?.remove();
      panel = null;
      document.body.classList.remove('scene-sync-shell-minimal');
      delete document.body.dataset.sceneSyncShell;
    },
  };
}

export default createSceneSyncShell;
