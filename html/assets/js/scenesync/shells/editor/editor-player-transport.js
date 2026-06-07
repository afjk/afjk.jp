import { createPlayerTransportPanel } from '../player/player-transport.js';

function addListener(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

function createToggleButton(label = 'Player') {
  const button = document.createElement('button');
  button.className = 'chip';
  button.type = 'button';
  button.title = 'Player controls';
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<span>Play</span>';
  button.querySelector('span').textContent = label;
  return button;
}

function insertDesktopToggle(button) {
  const settingsPanel = document.getElementById('settings-panel');
  if (!settingsPanel) return null;

  const row = document.createElement('div');
  row.className = 'row mobile-collapsible-row';
  row.appendChild(button);

  const devRow = document.getElementById('scene-inspector-toggle')?.closest('.row');
  if (devRow?.parentElement === settingsPanel) {
    settingsPanel.insertBefore(row, devRow);
  } else {
    settingsPanel.appendChild(row);
  }
  return row;
}

function insertMobileToggle(button) {
  const actions = document.querySelector('#mobile-action-sheet .mobile-sheet-actions');
  if (!actions) return null;

  const before = document.getElementById('mobile-export-btn');
  if (before?.parentElement === actions) {
    actions.insertBefore(button, before);
  } else {
    actions.appendChild(button);
  }
  return button;
}

export function createEditorPlayerTransport() {
  let transport = null;
  let desktopRow = null;
  let desktopButton = null;
  let mobileButton = null;
  let mountedCore = null;
  let opened = false;
  const disposers = [];

  function renderToggleState() {
    for (const button of [desktopButton, mobileButton]) {
      if (!button) continue;
      button.classList.toggle('active', opened);
      button.setAttribute('aria-expanded', String(opened));
    }
  }

  function open(core) {
    if (opened) return;
    opened = true;
    core?.commands?.activateSceneClockTransport?.();
    transport?.setHidden(false);
    renderToggleState();
  }

  function close(core) {
    if (!opened) return;
    opened = false;
    transport?.setHidden(true);
    core?.commands?.deactivateSceneClockTransport?.();
    renderToggleState();
  }

  function toggle(core) {
    if (opened) close(core);
    else open(core);
  }

  return {
    async mount({ core, root = document.body } = {}) {
      mountedCore = core;
      desktopButton = createToggleButton('Player');
      mobileButton = createToggleButton('Player');
      desktopRow = insertDesktopToggle(desktopButton);
      insertMobileToggle(mobileButton);

      transport = createPlayerTransportPanel({
        title: 'SCENE SYNC · EDITOR PLAYER',
        className: 'scene-sync-editor-player-panel',
        closeable: true,
        hidden: true,
        onClose: () => close(core),
      });
      await transport.mount({ core, root });

      disposers.push(
        addListener(desktopButton, 'click', () => toggle(core)),
        addListener(mobileButton, 'click', () => {
          core?.commands?.closeMobileActionSheet?.();
          toggle(core);
        }),
        addListener(document, 'keydown', (event) => {
          if (event.key === 'Escape' && opened) {
            close(core);
          }
        })
      );

      renderToggleState();
    },

    unmount() {
      if (opened) {
        mountedCore?.commands?.deactivateSceneClockTransport?.();
      }
      opened = false;
      for (const dispose of disposers.splice(0)) dispose();
      transport?.unmount?.();
      transport = null;
      desktopRow?.remove();
      desktopRow = null;
      mobileButton?.remove();
      desktopButton = null;
      mobileButton = null;
      mountedCore = null;
    },
  };
}

export default createEditorPlayerTransport;
