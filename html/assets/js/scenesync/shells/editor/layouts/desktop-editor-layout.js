export function createDesktopEditorLayout() {
  return {
    id: 'desktop-editor',
    name: 'Desktop Editor Layout',

    mount({ core, actions, root } = {}) {
      document.body.classList.add('scene-sync-layout-desktop-editor');
    },

    unmount() {
      document.body.classList.remove('scene-sync-layout-desktop-editor');
    },
  };
}

export default createDesktopEditorLayout;
