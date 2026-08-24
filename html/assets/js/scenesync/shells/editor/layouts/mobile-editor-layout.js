import { createEditorChrome } from '../editor-chrome.js';

function addListener(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

export function createMobileEditorLayout() {
  const disposers = [];
  let chrome = null;

  return {
    id: 'mobile-editor',
    name: 'Mobile Editor Layout',

    mount({ core, actions, root } = {}) {
      document.body.classList.add('scene-sync-layout-mobile-editor');

      chrome = createEditorChrome(core);
      chrome.mount();

      const mobileExportBtn = document.getElementById('mobile-export-btn');
      const mobileHelpBtn = document.getElementById('mobile-help-btn');
      const mobileLinkOpenBtn = document.getElementById('mobile-link-open-btn');
      const mobileDevOpenBtn = document.getElementById('mobile-dev-open-btn');

      // transform ツールバー（mobile-toolbar）。表示/活性の DOM 更新は editor-chrome.js が担う。
      const btnMove = document.getElementById('btn-move');
      const btnRotate = document.getElementById('btn-rotate');
      const btnScale = document.getElementById('btn-scale');
      const btnFocus = document.getElementById('btn-focus');
      const btnCopy = document.getElementById('btn-copy');
      const btnDelete = document.getElementById('btn-delete');
      const btnDeselect = document.getElementById('btn-deselect');

      disposers.push(
        addListener(mobileExportBtn, 'click', () => {
          core?.commands?.closeMobileActionSheet?.();
          actions?.exportScene?.();
        }),
        addListener(mobileHelpBtn, 'click', () => {
          core?.commands?.closeMobileActionSheet?.();
          actions?.openHelp?.();
        }),
        addListener(mobileLinkOpenBtn, 'click', () => {
          core?.commands?.closeMobileActionSheet?.();
          actions?.startAiLink?.();
        }),
        addListener(mobileDevOpenBtn, 'click', () => {
          core?.commands?.closeMobileActionSheet?.();
          core?.commands?.toggleSceneInspector?.();
        }),
        addListener(btnMove, 'click', () => actions?.setTransformMode?.('translate')),
        addListener(btnRotate, 'click', () => actions?.setTransformMode?.('rotate')),
        addListener(btnScale, 'click', () => actions?.setTransformMode?.('scale')),
        addListener(btnFocus, 'click', () => actions?.focusSelected?.()),
        addListener(btnCopy, 'click', () => actions?.duplicateSelected?.()),
        addListener(btnDelete, 'click', () => actions?.deleteSelected?.()),
        addListener(btnDeselect, 'click', () => actions?.deselect?.())
      );
    },

    unmount() {
      chrome?.unmount();
      chrome = null;
      for (const dispose of disposers.splice(0)) dispose();
      document.body.classList.remove('scene-sync-layout-mobile-editor');
    },
  };
}

export default createMobileEditorLayout;
