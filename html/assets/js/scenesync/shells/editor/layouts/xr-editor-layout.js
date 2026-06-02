export function createXrEditorLayout() {
  return {
    id: 'xr-editor',
    name: 'XR Editor Layout',

    mount({ core, actions, root } = {}) {
      document.body.classList.add('scene-sync-layout-xr-editor');
    },

    unmount() {
      document.body.classList.remove('scene-sync-layout-xr-editor');
    },
  };
}

export default createXrEditorLayout;
