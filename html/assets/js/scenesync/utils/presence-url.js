// Resolve WebSocket and HTTP APIs from one selected presence endpoint. In
// particular, a staging page must not silently use the production origin.
export function resolveSceneSyncPresenceUrl(pageUrl) {
  const page = new URL(pageUrl);
  const override = page.searchParams.get('presence');
  if (override) {
    const url = new URL(override, page);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Unsupported presence URL protocol');
    return url.href;
  }
  // Keep the existing local development server convention.
  if (['localhost', '127.0.0.1'].includes(page.hostname)) return 'ws://localhost:8787';
  const url = new URL('/presence', page.origin);
  url.protocol = page.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export function getSceneSyncApiBaseUrl(presenceUrl) {
  const url = new URL(presenceUrl);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported presence API protocol');
  return url.origin + url.pathname.replace(/\/+$/, '') + '/api';
}
