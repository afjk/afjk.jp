export const SCENE_SYNC_JSZIP_URL =
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

let loadingPromise = null;

/**
 * Load the JSZip runtime already used by Scene Sync Export imports.
 *
 * Keeping this in one module prevents URL importers and export importers from
 * injecting separate script tags when both paths are used in one session.
 */
export async function ensureJSZip() {
  if (typeof globalThis.JSZip !== 'undefined') return globalThis.JSZip;
  if (loadingPromise) return loadingPromise;

  if (!globalThis.document?.createElement) {
    throw new Error('JSZip is not available in this environment');
  }

  loadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCENE_SYNC_JSZIP_URL;
    script.onload = () => {
      if (typeof globalThis.JSZip === 'undefined') {
        reject(new Error('JSZip loaded without exposing its runtime'));
        return;
      }
      resolve(globalThis.JSZip);
    };
    script.onerror = () => reject(new Error('Failed to load JSZip'));
    document.head.appendChild(script);
  }).catch((error) => {
    loadingPromise = null;
    throw error;
  });

  return loadingPromise;
}
