/**
 * Lightweight runner that dispatches lifecycle calls to an ordered list of plugins.
 * dispose() runs plugins in reverse order so later-registered plugins clean up first.
 *
 * @param {Array<import('../plugins/scene-sync-physics-plugin.js').SceneSyncRuntimePlugin>} plugins
 */
export function createRuntimePluginRunner(plugins = []) {
  return {
    plugins,

    init(context) {
      for (const plugin of plugins) {
        plugin.init?.(context);
      }
    },

    onSceneLoaded(scene) {
      for (const plugin of plugins) {
        plugin.onSceneLoaded?.(scene);
      }
    },

    onObjectAdded(object) {
      for (const plugin of plugins) {
        plugin.onObjectAdded?.(object);
      }
    },

    onObjectChanged(object, changes) {
      for (const plugin of plugins) {
        plugin.onObjectChanged?.(object, changes);
      }
    },

    onObjectRemoved(objectId) {
      for (const plugin of plugins) {
        plugin.onObjectRemoved?.(objectId);
      }
    },

    update(clockState, scheduleContext) {
      for (const plugin of plugins) {
        plugin.update?.(clockState, scheduleContext);
      }
    },

    dispose() {
      for (const plugin of [...plugins].reverse()) {
        plugin.dispose?.();
      }
    },
  };
}
