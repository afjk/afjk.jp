import { createPlayerTransportPanel } from './player-transport.js';

const BODY_CLASS = 'scene-sync-shell-player';

export function createSceneSyncShell({ id = 'player', requestedId = 'player', availableShellIds = [] } = {}) {
  let transport = null;
  let mountedCore = null;

  return {
    id,
    requestedId,
    name: 'Player Shell',
    kind: 'player',
    layouts: ['desktop', 'mobile'],
    inputs: [],

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
    },

    unmount() {
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
