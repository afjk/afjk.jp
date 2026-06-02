function addListener(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

export function createMobileEditorLayout() {
  const disposers = [];

  return {
    id: 'mobile-editor',
    name: 'Mobile Editor Layout',

    mount({ core, actions, root } = {}) {
      document.body.classList.add('scene-sync-layout-mobile-editor');

      const mobileExportBtn = document.getElementById('mobile-export-btn');
      const mobileHelpBtn = document.getElementById('mobile-help-btn');
      const mobileLinkOpenBtn = document.getElementById('mobile-link-open-btn');
      const mobileDevOpenBtn = document.getElementById('mobile-dev-open-btn');

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
        })
      );
    },

    unmount() {
      for (const dispose of disposers.splice(0)) dispose();
      document.body.classList.remove('scene-sync-layout-mobile-editor');
    },
  };
}

export default createMobileEditorLayout;
