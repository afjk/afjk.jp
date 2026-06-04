import { createEditorActions } from './editor-actions.js';
import { createDesktopEditorLayout } from './layouts/desktop-editor-layout.js';
import { createMobileEditorLayout } from './layouts/mobile-editor-layout.js';
import { createXrEditorLayout } from './layouts/xr-editor-layout.js'; // forward placeholder for WebXR/MR editing

function isMobileSurface() {
  return document.body.classList.contains('scene-sync-device-mobile');
}

export function createSceneSyncShell({ id = 'editor', requestedId = 'editor', availableShellIds = [] } = {}) {
  let layout = null;

  return {
    id,
    requestedId,
    name: 'Editor Shell',
    kind: 'editor',
    layouts: ['desktop', 'mobile', 'xr'],
    inputs: ['pointer', 'touch', 'keyboard', 'xr'],

    mount({ core, root } = {}) {
      const actions = createEditorActions(core);

      document.body.dataset.sceneSyncShell = 'editor';
      document.body.classList.add('scene-sync-shell-editor');
      document.body.classList.remove('scene-sync-shell-minimal');

      layout = isMobileSurface()
        ? createMobileEditorLayout()
        : createDesktopEditorLayout();

      layout.mount({ core, actions, root });

      if (core?.debug) {
        console.debug('[SceneSyncShell] mounted editor shell', {
          requestedId,
          availableShellIds,
          layout: layout?.id,
        });
      }
    },

    unmount() {
      layout?.unmount?.();
      layout = null;
      document.body.classList.remove('scene-sync-shell-editor');
      delete document.body.dataset.sceneSyncShell;
    },
  };
}

export default createSceneSyncShell;
