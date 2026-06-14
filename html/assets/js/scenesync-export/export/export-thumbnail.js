export const EXPORT_THUMBNAIL_WIDTH = 1200;
export const EXPORT_THUMBNAIL_HEIGHT = 630;

const FALLBACK_TITLE = 'Scene Sync Export';
const FALLBACK_STATS_LABEL = 'Scene Sync world';

function normalizeText(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

export function colorFromString(input) {
  const text = normalizeText(input, FALLBACK_TITLE);
  let hash = 0;
  for (const ch of text) {
    hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 64%, 42%)`;
}

export function collectExportSceneStats(sceneDocument = {}) {
  const objects = Array.isArray(sceneDocument.objects) ? sceneDocument.objects : [];
  const stats = {
    objects: objects.length,
    images: 0,
    videos: 0,
    audios: sceneDocument.bgm ? 1 : 0,
    texts: 0,
    glbs: 0,
    loomlets: sceneDocument.behaviors ? 1 : 0,
    physics: 0,
  };

  for (const obj of objects) {
    const type = obj?.asset?.type;
    if (type === 'image') stats.images += 1;
    else if (type === 'video') stats.videos += 1;
    else if (type === 'text') stats.texts += 1;
    else if (type === 'mesh') stats.glbs += 1;

    if (obj?.audioSources && typeof obj.audioSources === 'object' && !Array.isArray(obj.audioSources)) {
      stats.audios += Object.keys(obj.audioSources).length;
    }
    if (obj?.physics?.enabled) stats.physics += 1;
  }

  return stats;
}

export function buildExportThumbnailStatsLabel(stats = {}) {
  const parts = [];
  const objectCount = Number.isFinite(stats.objects) ? Math.max(0, stats.objects) : 0;
  parts.push(`${objectCount} object${objectCount === 1 ? '' : 's'}`);
  if (stats.glbs > 0) parts.push('glb');
  if (stats.images > 0) parts.push('image');
  if (stats.videos > 0) parts.push('video');
  if (stats.audios > 0) parts.push('audio');
  if (stats.texts > 0) parts.push('text');
  if (stats.loomlets > 0) parts.push('interactive');
  if (stats.physics > 0) parts.push('physics');
  return parts.filter(Boolean).slice(0, 5).join(' · ') || FALLBACK_STATS_LABEL;
}

export function resolveExportThumbnailTitle({
  sceneDocument = null,
  manifest = null,
  fallbackTitle = FALLBACK_TITLE,
} = {}) {
  return normalizeText(
    sceneDocument?.title || manifest?.title || fallbackTitle,
    FALLBACK_TITLE,
  );
}

export function wrapCanvasText(ctx, text, maxWidth, maxLines = 3) {
  const normalized = normalizeText(text, FALLBACK_TITLE);
  const words = normalized.split(/\s+/).filter(Boolean);
  const lines = [];

  function pushBrokenWord(word) {
    let current = '';
    for (const ch of word) {
      const next = `${current}${ch}`;
      if (current && ctx.measureText(next).width > maxWidth) {
        lines.push(current);
        current = ch;
        if (lines.length >= maxLines) break;
      } else {
        current = next;
      }
    }
    if (current && lines.length < maxLines) lines.push(current);
  }

  for (const word of words) {
    if (lines.length >= maxLines) break;
    const current = lines.pop() || '';
    const next = current ? `${current} ${word}` : word;
    if (!current || ctx.measureText(next).width <= maxWidth) {
      lines.push(next);
      continue;
    }
    lines.push(current);
    if (ctx.measureText(word).width <= maxWidth) {
      lines.push(word);
    } else {
      pushBrokenWord(word);
    }
  }

  if (lines.length > maxLines) lines.length = maxLines;
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
    const last = lines[maxLines - 1];
    let clipped = last;
    while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
      clipped = clipped.slice(0, -1);
    }
    lines[maxLines - 1] = `${clipped}…`;
  }
  return lines;
}

function createThumbnailCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height);
  }
  const doc = globalThis.document;
  if (!doc?.createElement) {
    throw new Error('Canvas is not available');
  }
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToPngBlob(canvas) {
  if (typeof canvas.convertToBlob === 'function') {
    return await canvas.convertToBlob({ type: 'image/png' });
  }
  if (typeof canvas.toBlob === 'function') {
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas returned an empty thumbnail blob'));
      }, 'image/png');
    });
  }
  throw new Error('Canvas PNG export is not available');
}

export async function generateExportThumbnail({
  title,
  stats = null,
  width = EXPORT_THUMBNAIL_WIDTH,
  height = EXPORT_THUMBNAIL_HEIGHT,
  canvasFactory = createThumbnailCanvas,
} = {}) {
  const safeTitle = normalizeText(title, FALLBACK_TITLE);
  const canvas = canvasFactory(width, height);
  const ctx = canvas.getContext?.('2d');
  if (!ctx) throw new Error('2D canvas context is not available');

  ctx.fillStyle = colorFromString(safeTitle);
  ctx.fillRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = '700 76px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const titleLines = wrapCanvasText(ctx, safeTitle, width - 200, 3);
  const lineHeight = 86;
  const firstY = height / 2 - ((titleLines.length - 1) * lineHeight) / 2 - 24;
  titleLines.forEach((line, index) => {
    ctx.fillText(line, width / 2, firstY + index * lineHeight);
  });

  ctx.font = '500 32px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.fillText(buildExportThumbnailStatsLabel(stats || {}), width / 2, height - 130);

  ctx.font = '700 30px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillText('Scene Sync', width / 2, height - 74);

  return {
    blob: await canvasToPngBlob(canvas),
    mode: 'title-card',
  };
}
