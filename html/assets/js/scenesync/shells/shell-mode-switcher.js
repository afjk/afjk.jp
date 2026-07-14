const STYLE_ID = 'scene-sync-shell-mode-switcher-style';
const CONTAINER_ID = 'scene-sync-shell-mode-switcher';

// 将来 shell を増やす場合はここに追加する
const SWITCHER_SHELLS = [
  { id: 'editor', label: 'Edit' },
  { id: 'player', label: 'Play' },
];

function ensureSwitcherStylesheet() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${CONTAINER_ID} {
      position: fixed;
      top: calc(12px + var(--mobile-safe-top, 0px));
      left: 50%;
      transform: translateX(-50%);
      z-index: 60;
      display: flex;
      gap: 2px;
      padding: 3px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }
    #${CONTAINER_ID}[hidden] {
      display: none;
    }
    #${CONTAINER_ID} button {
      border: none;
      border-radius: 8px;
      padding: 5px 14px;
      background: transparent;
      color: #ddd;
      font-family: monospace;
      font-size: 13px;
      line-height: 1.2;
      cursor: pointer;
    }
    #${CONTAINER_ID} button[aria-pressed="true"] {
      background: rgba(68, 136, 255, 0.7);
      color: #fff;
    }
    #${CONTAINER_ID} button:disabled {
      opacity: 0.55;
      cursor: default;
    }
    /* XR セッション中は中央上を XR ボタン (#xr-toggle-btn 等) に譲る */
    body.scene-sync-xr-session #${CONTAINER_ID} {
      display: none;
    }
  `;
  document.head.appendChild(style);
}

export function createShellModeSwitcher(runtime) {
  let container = null;
  let removeShellChangeListener = null;
  let switching = false;
  const buttons = new Map();

  function updateActive(shellId = runtime?.getCurrentShellId?.()) {
    if (!container) return;
    container.hidden = !SWITCHER_SHELLS.some((shell) => shell.id === shellId);
    for (const [id, button] of buttons) {
      button.setAttribute('aria-pressed', id === shellId ? 'true' : 'false');
    }
  }

  function setButtonsDisabled(disabled) {
    for (const button of buttons.values()) {
      button.disabled = disabled;
    }
  }

  async function handleSwitchClick(shellId) {
    if (switching || typeof runtime?.switchShell !== 'function') return;
    if (shellId === runtime.getCurrentShellId?.()) return;
    switching = true;
    setButtonsDisabled(true);
    try {
      await runtime.switchShell(shellId, { updateUrl: true });
    } catch (error) {
      console.warn('[ShellModeSwitcher] shell switch failed:', error);
    } finally {
      switching = false;
      setButtonsDisabled(false);
      updateActive();
    }
  }

  return {
    mount({ root = document.body } = {}) {
      if (container) return;
      ensureSwitcherStylesheet();

      container = document.createElement('div');
      container.id = CONTAINER_ID;
      container.setAttribute('role', 'group');
      container.setAttribute('aria-label', 'Shell mode');

      for (const { id, label } of SWITCHER_SHELLS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => handleSwitchClick(id));
        buttons.set(id, button);
        container.appendChild(button);
      }

      root.appendChild(container);

      removeShellChangeListener =
        runtime?.onShellChange?.(({ shellId }) => updateActive(shellId)) ?? null;
      updateActive();
    },

    unmount() {
      removeShellChangeListener?.();
      removeShellChangeListener = null;
      container?.remove();
      container = null;
      buttons.clear();
      switching = false;
    },
  };
}

export default createShellModeSwitcher;
