import { loadSceneSyncShell } from './shell-registry.js';

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
      listeners.clear();
      extraCore.dispose?.();
    },
  };
}

export async function mountSceneSyncShell(extraCore = {}) {
  const shell = await loadSceneSyncShell();
  const core = createDomBackedCore(extraCore);
  await shell.mount({ core, root: document.body });

  return {
    shell,
    core,
    dispose() {
      shell.unmount?.();
      core.dispose?.();
    },
  };
}
