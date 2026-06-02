export function createTouchInputAdapter() {
  return {
    id: 'touch',
    name: 'Touch Input Adapter',

    mount({ core, actions } = {}) {},

    unmount() {},
  };
}

export default createTouchInputAdapter;
