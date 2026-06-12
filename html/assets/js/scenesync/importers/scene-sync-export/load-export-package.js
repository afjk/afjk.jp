import { isValidSceneDocument } from '../../../scenesync-export/viewer/scene-document.js';

async function ensureJSZip() {
  if (typeof globalThis.JSZip !== 'undefined') return globalThis.JSZip;

  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load JSZip'));
    document.head.appendChild(script);
  });

  return globalThis.JSZip;
}

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
