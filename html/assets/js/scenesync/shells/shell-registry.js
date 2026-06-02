const DEFAULT_SHELL_ID = 'editor';

const SHELL_LOADERS = {
  editor: () => import('./editor/editor-shell.js'),
  minimal: () => import('./minimal/minimal-shell.js'),
  player: () => import('./player/player-shell.js'),
};

function normalizeShellId(value) {
  if (typeof value !== 'string') return DEFAULT_SHELL_ID;
  const id = value.trim().toLowerCase();
  return id || DEFAULT_SHELL_ID;
}

export function getRequestedSceneSyncShellId(search = location.search) {
  const params = new URLSearchParams(search);
  return normalizeShellId(params.get('shell'));
}

export function listSceneSyncShellIds() {
  return Object.keys(SHELL_LOADERS);
}

export async function loadSceneSyncShell(shellId = getRequestedSceneSyncShellId()) {
  const requestedId = normalizeShellId(shellId);
  const loader = SHELL_LOADERS[requestedId] || SHELL_LOADERS[DEFAULT_SHELL_ID];
  const module = await loader();
  const createShell = module.createSceneSyncShell || module.default;

  if (typeof createShell !== 'function') {
    throw new Error(`Scene Sync shell '${requestedId}' does not export createSceneSyncShell().`);
  }

  return createShell({
    id: SHELL_LOADERS[requestedId] ? requestedId : DEFAULT_SHELL_ID,
    requestedId,
    availableShellIds: listSceneSyncShellIds(),
  });
}
