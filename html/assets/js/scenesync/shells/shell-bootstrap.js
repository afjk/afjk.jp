import { loadSceneSyncShell } from './shell-registry.js';
import { createMouseInputAdapter } from './editor/inputs/mouse-input-adapter.js';
import { createTouchInputAdapter } from './editor/inputs/touch-input-adapter.js';

function clickElement(id) {
  document.getElementById(id)?.click();
}

function createDomBackedCommands() {
  return {
    openAddMenu() {
      clickElement('add-btn');
    },
    undo() {
      clickElement('btn-undo');
    },
    redo() {
      clickElement('btn-redo');
    },
    deleteSelected() {
      clickElement('btn-delete');
    },
    exportScene() {
      clickElement('export-btn');
    },
  };
}

function createDomBackedCore(extraCore = {}) {
  const listeners = new Set();
  let removeExtraStateListener = null;

  const notify = (reason) => {
    for (const listener of listeners) {
      listener({ reason });
    }
  };

  const statusEl = document.getElementById('status');
  const selectionOutputEl = document.getElementById('scene-inspector-object-meta');

  const observer = new MutationObserver(() => notify('dom-mutated'));
  if (statusEl) observer.observe(statusEl, { childList: true, subtree: true, characterData: true });
  if (selectionOutputEl) observer.observe(selectionOutputEl, { childList: true, subtree: true, characterData: true });

  if (typeof extraCore.onStateChange === 'function') {
    const removeListener = extraCore.onStateChange((event = {}) => {
      notify(event.reason || 'core-state-changed');
    });
    if (typeof removeListener === 'function') {
      removeExtraStateListener = removeListener;
    }
  }

  return {
    ...extraCore,
    commands: {
      ...createDomBackedCommands(),
      ...(extraCore.commands || {}),
    },
    getConnectionState() {
      const statusText = statusEl?.textContent || '';
      return {
        connected: statusText.includes('·'),
        room: statusText.split('·')[1]?.trim() || '',
        peerCount: Number.parseInt(statusText.match(/(\d+) peer/)?.[1] || '0', 10),
        label: statusText,
      };
    },
    getSelection() {
      const coreSelection = extraCore.getSelection?.();
      if (coreSelection) {
        const objectIds = Array.isArray(coreSelection.objectIds)
          ? coreSelection.objectIds
          : Array.isArray(coreSelection.selectedObjectIds)
            ? coreSelection.selectedObjectIds
            : [];
        return {
          ...coreSelection,
          objectIds,
        };
      }

      const label = selectionOutputEl?.textContent?.trim() || '';
      return {
        label,
        objectIds: [],
      };
    },
    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      observer.disconnect();
      removeExtraStateListener?.();
      removeExtraStateListener = null;
      listeners.clear();
      extraCore.dispose?.();
    },
  };
}

export async function mountSceneSyncShell(extraCore = {}) {
  const shell = await loadSceneSyncShell();
  const core = createDomBackedCore(extraCore);
  await shell.mount({ core, root: document.body });

  // 既定の入力アダプタ（canvas pointer/keyboard + touch）を常時 mount する。
  // 3D シーンを表示する全 shell が選択・操作・カメラ入力を得られるよう、
  // 旧来 scene.js が持っていたグローバル入力配線をここに集約する。
  const inputAdapters = [];
  if (core?.input?.getCanvas?.()) {
    for (const create of [createMouseInputAdapter, createTouchInputAdapter]) {
      const adapter = create();
      try { adapter.mount({ core }); inputAdapters.push(adapter); }
      catch (error) { console.warn('[SceneSyncShell] input adapter mount failed:', error); }
    }
  }

  return {
    shell,
    core,
    inputAdapters,
    dispose() {
      for (const adapter of inputAdapters.splice(0)) adapter.unmount?.();
      shell.unmount?.();
      core.dispose?.();
    },
  };
}
