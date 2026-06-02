export function createSceneSyncShell({ id = 'editor', requestedId = 'editor', availableShellIds = [] } = {}) {
  return {
    id,
    requestedId,
    name: 'Editor Shell',
    kind: 'editor',
    layouts: ['desktop', 'mobile', 'xr'],
    inputs: ['mouse', 'touch', 'xr'],

    mount({ core } = {}) {
      document.body.dataset.sceneSyncShell = 'editor';
      document.body.classList.add('scene-sync-shell-editor');
      document.body.classList.remove('scene-sync-shell-minimal');

      if (core?.debug) {
        console.debug('[SceneSyncShell] mounted editor shell', {
          requestedId,
          availableShellIds,
        });
      }
    },

    unmount() {
      document.body.classList.remove('scene-sync-shell-editor');
      delete document.body.dataset.sceneSyncShell;
    },
  };
}

export default createSceneSyncShell;
