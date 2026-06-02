export function createXrInputAdapter() {
  return {
    id: 'xr',
    name: 'XR Input Adapter (WebXR)',

    mount({ core, actions } = {}) {},

    unmount() {},
  };
}

export default createXrInputAdapter;
