/**
 * Thin wrapper that exposes a ScenePhysicsRuntime as a SceneSyncRuntimePlugin.
 *
 * The plugin boundary keeps Physics isolated from Clock, UI, Loomlet, Audio,
 * and Network concerns. Only update() and dispose() are wired to the runtime;
 * lifecycle hooks (onSceneLoaded, onObjectAdded, …) are stubs for future use.
 *
 * @param {Object} options
 * @param {Object} [options.physicsRuntime] - Existing runtime from createScenePhysicsRuntime()
 * @param {Function} [options.createPhysicsRuntime] - Factory called during init() if no runtime is pre-built
 * @returns {SceneSyncRuntimePlugin & { hasBodies(): boolean, getRuntime(): Object|null }}
 */
export function createSceneSyncPhysicsPlugin(options = {}) {
  const { createPhysicsRuntime, physicsRuntime: prebuiltRuntime } = options;
  let runtime = prebuiltRuntime || null;

  return {
    name: 'physics',

    init(context) {
      if (!runtime && typeof createPhysicsRuntime === 'function') {
        runtime = createPhysicsRuntime(context);
      }
    },

    onSceneLoaded(nextScene) {
      runtime?.onSceneLoaded?.(nextScene);
    },

    onObjectAdded(object) {
      runtime?.onObjectAdded?.(object);
    },

    onObjectChanged(object, changes) {
      runtime?.onObjectChanged?.(object, changes);
    },

    onObjectRemoved(objectId) {
      runtime?.onObjectRemoved?.(objectId);
    },

    /**
     * @param {Object} clockState
     * @param {{ events: Array, diagnostics: Array }} scheduleContext
     */
    update(clockState, scheduleContext) {
      if (!runtime || typeof runtime.update !== 'function') return;
      runtime.update(clockState);
      // Future: push collision/physics events into scheduleContext.events
    },

    hasBodies() {
      return runtime?.hasBodies?.() ?? false;
    },

    dispose() {
      runtime?.dispose?.();
      runtime = null;
    },

    getRuntime() {
      return runtime;
    },
  };
}
