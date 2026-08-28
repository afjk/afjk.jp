export const SUPERSPLAT_HOST = 'superspl.at';

const SUPERSPLAT_ASSET_HOST_SUFFIXES = Object.freeze([
  SUPERSPLAT_HOST,
  'cloudfront.net',
  'playcanvas.com',
]);
const SUPERSPLAT_SCENE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Parse a public share URL and return the canonical scene URL. */
export function parseSuperSplatSceneUrl(input) {
  if (typeof input !== 'string' || !/^https?:\/\//i.test(input.trim())) return null;

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== SUPERSPLAT_HOST) return null;
  if (url.username || url.password || url.port) return null;

  const pathId = url.pathname.match(/^\/scene\/([^/]+)\/?$/)?.[1] || '';
  const queryId = url.pathname.replace(/\/$/, '') === '/s'
    ? (url.searchParams.get('id') || '')
    : '';
  const sceneId = (pathId || queryId).trim();
  if (!SUPERSPLAT_SCENE_ID_PATTERN.test(sceneId)) return null;

  return {
    sceneId,
    sceneUrl: `https://${SUPERSPLAT_HOST}/scene/${sceneId}`,
  };
}

function hasAllowedHostSuffix(hostname) {
  const host = String(hostname || '').toLowerCase();
  return SUPERSPLAT_ASSET_HOST_SUFFIXES.some((suffix) => (
    host === suffix || host.endsWith(`.${suffix}`)
  ));
}

/** Only follow resolver-provided asset URLs on SuperSplat's public CDN hosts. */
export function isAllowedSuperSplatAssetUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return false;
  }

  return url.protocol === 'https:'
    && !url.username
    && !url.password
    && !url.port
    && hasAllowedHostSuffix(url.hostname);
}
