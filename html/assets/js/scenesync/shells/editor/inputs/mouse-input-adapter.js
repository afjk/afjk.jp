export function createMouseInputAdapter() {
  return {
    id: 'mouse',
    name: 'Mouse Input Adapter',

    mount({ core, actions } = {}) {},

    unmount() {},
  };
}

export default createMouseInputAdapter;
