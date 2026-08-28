import { isValidSceneDocument } from '../../../scenesync-export/viewer/scene-document.js';
import { ensureJSZip } from '../../utils/jszip-loader.js';

// Reads scene.json (and manifest.json, if present) from a Scene Sync Export ZIP Blob.
export async function loadExportPackageFromBlob(blob) {
  let JSZip;
  try {
    JSZip = await ensureJSZip();
  } catch (err) {
    return { valid: false, reason: 'jszip-load-failed', error: err };
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(blob);
  } catch (err) {
    return { valid: false, reason: 'invalid-zip', error: err };
  }

  const sceneEntry = zip.file('scene.json');
  if (!sceneEntry) {
    return { valid: false, reason: 'missing-scene-json' };
  }

  let sceneDocument;
  try {
    sceneDocument = JSON.parse(await sceneEntry.async('string'));
  } catch (err) {
    return { valid: false, reason: 'invalid-scene-json', error: err };
  }

  if (!isValidSceneDocument(sceneDocument)) {
    return { valid: false, reason: 'invalid-scene-document' };
  }

  let manifest = null;
  const manifestEntry = zip.file('manifest.json');
  if (manifestEntry) {
    try {
      manifest = JSON.parse(await manifestEntry.async('string'));
    } catch {
      manifest = null;
    }
  }

  return { valid: true, sceneDocument, manifest, zip };
}
