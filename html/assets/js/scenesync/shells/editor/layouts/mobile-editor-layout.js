export function createMobileEditorLayout() {
  return {
    id: 'mobile-editor',
    name: 'Mobile Editor Layout',

    mount({ core, actions, root } = {}) {
      document.body.classList.add('scene-sync-layout-mobile-editor');
    },

    unmount() {
      document.body.classList.remove('scene-sync-layout-mobile-editor');
    },
  };
}

export default createMobileEditorLayout;
