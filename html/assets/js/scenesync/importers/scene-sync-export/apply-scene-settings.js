// Applies scene-level settings (currently: skybox/environment) from a
// SceneDocument. If the document has no skybox.envId, the current
// environment is left untouched (no reset to default).
export function applySceneDocumentSettings(sceneDocument, {
  environmentManager,
  broadcast,
} = {}) {
  const envId = sceneDocument?.skybox?.envId;

  if (typeof envId === 'string' && envId.trim()) {
    environmentManager?.loadEnvironment?.(envId, {
      source: 'scene-sync-export-import',
      broadcastChange: false,
    });

    broadcast?.({
      kind: 'scene-env',
      envId,
    });

    return { envApplied: true, envId };
  }

  return { envApplied: false };
}
