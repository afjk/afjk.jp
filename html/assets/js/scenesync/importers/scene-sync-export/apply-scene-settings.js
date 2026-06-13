import { uploadZipAsset } from './zip-asset-upload.js';

function buildBgmPayload(bgm, uploaded = null) {
  if (!bgm) return null;
  const url = uploaded?.url || bgm.url;
  if (!url) return null;
  return {
    version: bgm.version ?? 1,
    url,
    name: bgm.name || uploaded?.originalName || 'bgm',
    loop: bgm.loop !== false,
    volume: Number.isFinite(bgm.volume) ? bgm.volume : 1,
    playback: bgm.playback || { mode: 'local-loop' },
  };
}

// Applies scene-level settings (skybox/environment and BGM) from a
// SceneDocument. If the document has no skybox.envId, the current
// environment is left untouched (no reset to default).
export async function applySceneDocumentSettings(sceneDocument, {
  environmentManager,
  broadcast,
  applySceneBgm,
  applyScenePhysics,
  zip,
  uploadBlobToStore,
} = {}) {
  const result = { envApplied: false };
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

    result.envApplied = true;
    result.envId = envId;
  }

  const bgm = sceneDocument?.bgm || null;
  if (bgm) {
    const uploaded = bgm.importAsset?.kind === 'blob-file'
      ? await uploadZipAsset({
          zip,
          plan: bgm.importAsset,
          uploadBlobToStore,
        })
      : null;
    const bgmPayload = buildBgmPayload(bgm, uploaded);
    if (bgmPayload) {
      applySceneBgm?.(bgmPayload, { source: 'scene-sync-export-import' });
      broadcast?.({
        kind: 'scene-bgm',
        bgm: bgmPayload,
      });
      result.bgmApplied = true;
      result.bgmUrl = bgmPayload.url;
    } else {
      result.bgmApplied = false;
      result.bgmSkipped = true;
    }
  }

  if (sceneDocument?.physics && typeof sceneDocument.physics === 'object') {
    const appliedPhysics = applyScenePhysics?.(sceneDocument.physics, {
      source: 'scene-sync-export-import',
      notify: true,
    });
    broadcast?.({
      kind: 'scene-physics',
      physics: appliedPhysics || sceneDocument.physics,
    });
    result.physicsApplied = true;
  }

  return result;
}
