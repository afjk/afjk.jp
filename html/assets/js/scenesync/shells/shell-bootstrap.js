import { loadSceneSyncShell, listSceneSyncShellIds } from './shell-registry.js';
import { createPointerInputAdapter } from './editor/inputs/pointer-input-adapter.js';
import { createTouchInputAdapter } from './editor/inputs/touch-input-adapter.js';
import { createEditorKeyboardAdapter } from './editor/inputs/editor-keyboard-adapter.js';
import { createPlayerPhysicsDragInputAdapter } from './player/player-physics-drag-input.js';

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

const INPUT_ADAPTER_FACTORIES = {
  pointer: createPointerInputAdapter,
  touch: createTouchInputAdapter,
  keyboard: createEditorKeyboardAdapter,
  'player-physics-drag': createPlayerPhysicsDragInputAdapter,
};

function mountInputAdaptersForShell(shell, core) {
  const inputAdapters = [];
  if (!core?.input?.getCanvas?.()) return inputAdapters;

  const shellInputs = Array.isArray(shell?.inputs) ? shell.inputs : [];

  for (const inputId of shellInputs) {
    const factory = INPUT_ADAPTER_FACTORIES[inputId];
    if (!factory) {
      console.warn(`[SceneSyncShell] unknown input adapter: ${inputId}`);
      continue;
    }

    const adapter = factory();
    try {
      adapter.mount({ core });
      inputAdapters.push(adapter);
    } catch (error) {
      console.warn(`[SceneSyncShell] input adapter '${inputId}' mount failed:`, error);
    }
  }

  return inputAdapters;
}

function unmountInputAdapters(inputAdapters) {
  for (const adapter of inputAdapters.splice(0)) {
    try {
      adapter.unmount?.();
    } catch (error) {
      console.warn('[SceneSyncShell] input adapter unmount failed:', error);
    }
  }
}

export async function createSceneSyncShellRuntimeManager(extraCore = {}) {
  const core = createDomBackedCore(extraCore);
  let currentShell = null;
  let currentShellId = null;
  let currentInputAdapters = [];
  let switchSerial = 0;
  let disposed = false;
  const shellChangeListeners = new Set();

  function notifyShellChange(shellId, reason) {
    for (const listener of shellChangeListeners) {
      try {
        listener({ shellId, reason });
      } catch (error) {
        console.warn('[SceneSyncShell] shell change listener failed:', error);
      }
    }
  }

  async function switchShell(nextShellId, options = {}) {
    if (disposed) {
      console.warn('[SceneSyncShell] runtime already disposed');
      return;
    }

    const token = ++switchSerial;
    const normalizedId = String(nextShellId || '').trim().toLowerCase() || 'editor';

    if (normalizedId === currentShellId) {
      return;
    }

    const previousShell = currentShell;
    const previousShellId = currentShellId;
    const previousInputAdapters = currentInputAdapters;

    try {
      const nextShell = await loadSceneSyncShell(normalizedId);

      if (token !== switchSerial) {
        nextShell.unmount?.();
        return;
      }

      unmountInputAdapters(previousInputAdapters);
      previousShell?.unmount?.();

      currentShell = null;
      currentShellId = null;
      currentInputAdapters = [];

      await nextShell.mount({ core, root: document.body });

      if (token !== switchSerial) {
        nextShell.unmount?.();
        return;
      }

      currentInputAdapters = mountInputAdaptersForShell(nextShell, core);
      currentShell = nextShell;
      currentShellId = nextShell.id || normalizedId;

      if (options?.updateUrl) {
        const url = new URL(location.href);
        const mountedShellId = nextShell.id || normalizedId;
        url.searchParams.set('shell', mountedShellId);
        history.replaceState(null, '', url);
      }

      notifyShellChange(currentShellId, 'switch');

      if (core?.debug) {
        console.debug('[SceneSyncShell] switched to shell:', currentShellId);
      }
    } catch (error) {
      console.error('[SceneSyncShell] failed to switch shell:', error);

      if (token === switchSerial && currentShell === null) {
        try {
          const fallbackShell = await loadSceneSyncShell('editor');
          await fallbackShell.mount({ core, root: document.body });
          currentInputAdapters = mountInputAdaptersForShell(fallbackShell, core);
          currentShell = fallbackShell;
          currentShellId = fallbackShell.id || 'editor';
          notifyShellChange(currentShellId, 'fallback');
          console.warn('[SceneSyncShell] fell back to editor shell');
        } catch (fallbackError) {
          console.error('[SceneSyncShell] fallback to editor shell failed:', fallbackError);
        }
      }
    }
  }

  const initialShell = await loadSceneSyncShell();
  await initialShell.mount({ core, root: document.body });
  currentShell = initialShell;
  currentShellId = initialShell?.id || 'editor';
  currentInputAdapters = mountInputAdaptersForShell(initialShell, core);
  notifyShellChange(currentShellId, 'initial');

  return {
    get core() {
      return core;
    },

    getCurrentShellId() {
      return currentShellId;
    },

    getCurrentShell() {
      return currentShell;
    },

    switchShell,

    listShellIds() {
      return listSceneSyncShellIds();
    },

    onShellChange(listener) {
      if (typeof listener !== 'function') return () => {};
      shellChangeListeners.add(listener);
      return () => shellChangeListeners.delete(listener);
    },

    dispose() {
      if (disposed) return;
      disposed = true;

      shellChangeListeners.clear();

      unmountInputAdapters(currentInputAdapters);
      currentInputAdapters = [];

      currentShell?.unmount?.();
      currentShell = null;
      currentShellId = null;

      core?.dispose?.();
    },
  };
}

export async function mountSceneSyncShell(extraCore = {}) {
  const shell = await loadSceneSyncShell();
  const core = createDomBackedCore(extraCore);
  await shell.mount({ core, root: document.body });

  const inputAdapters = mountInputAdaptersForShell(shell, core);

  return {
    shell,
    core,
    inputAdapters,
    dispose() {
      unmountInputAdapters(inputAdapters);
      shell.unmount?.();
      core.dispose?.();
    },
  };
}
