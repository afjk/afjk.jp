import { createSceneDocumentFromSceneSyncState } from './export-scene-document.js';
import { collectExportAssets } from './collect-export-assets.js';
import { fetchExportViewerSources, SINGLE_HTML_HANDOFF_SOURCES, VIEWER_SOURCES } from './viewer-sources.js';
import { normalizeExportMetadata } from './export-metadata.js';

export const SINGLE_HTML_VIEWER_SOURCES = [...VIEWER_SOURCES, ...SINGLE_HTML_HANDOFF_SOURCES];

/** Fetches every input shared by Single HTML and Static ZIP builders once. */
export async function prepareSceneSyncExport({
  managedObjects,
  bgmState,
  envId,
  blobBase,
  envOrigin = location.origin,
  assetCache = null,
  behaviorState = null,
  physicsState = null,
  exportMetadata = null,
  viewerSources = SINGLE_HTML_VIEWER_SOURCES,
} = {}) {
  const metadata = normalizeExportMetadata(exportMetadata);
  let sceneDocument;
  try {
    sceneDocument = createSceneDocumentFromSceneSyncState({
      managedObjects, bgmState, envId, behaviorState, physicsState, exportMetadata: metadata,
    });
  } catch (error) {
    throw new Error(`SceneDocument generation failed: ${error.message}`);
  }
  const assets = await collectExportAssets({ sceneDocument, blobBase, envOrigin, assetCache });
  const viewer = await fetchExportViewerSources(viewerSources);
  return { metadata, sceneDocument, ...assets, viewerFiles: viewer.results, viewerFailures: viewer.failures };
}
