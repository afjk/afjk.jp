import { createEditorChrome } from '../editor-chrome.js';

function addListener(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

export function createDesktopEditorLayout() {
  const disposers = [];
  let chrome = null;

  return {
    id: 'desktop-editor',
    name: 'Desktop Editor Layout',

    mount({ core, actions, root } = {}) {
      document.body.classList.add('scene-sync-layout-desktop-editor');

      chrome = createEditorChrome(core);
      chrome.mount();

      const sceneInspectorToggleBtn = document.getElementById('scene-inspector-toggle');
      const sceneInspectorCloseBtn = document.getElementById('scene-inspector-close');

      disposers.push(
        addListener(sceneInspectorToggleBtn, 'click', () => core?.commands?.toggleSceneInspector?.()),
        addListener(sceneInspectorCloseBtn, 'click', () => actions?.closeSceneInspector?.())
      );
    },

    unmount() {
      chrome?.unmount();
      chrome = null;
      for (const dispose of disposers.splice(0)) dispose();
      document.body.classList.remove('scene-sync-layout-desktop-editor');
    },
  };
}

export default createDesktopEditorLayout;
