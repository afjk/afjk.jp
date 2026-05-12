export function computeResizedImageSize(width, height, maxPixel) {
  const maxDim = Math.max(width, height);
  if (!Number.isFinite(maxPixel) || maxPixel <= 0 || maxDim <= maxPixel) {
    return {
      width,
      height,
      scale: 1,
      resized: false,
    };
  }

  const scale = maxPixel / maxDim;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
    resized: true,
  };
}

export async function createImageCanvasForScene(fileOrBlob, options = {}) {
  const {
    maxPixel = 2048,
    label = 'image',
  } = options;

  const t0 = performance.now();
  let bitmap;

  try {
    try {
      bitmap = await createImageBitmap(fileOrBlob, { imageOrientation: 'from-image' });
    } catch {
      bitmap = await createImageBitmap(fileOrBlob);
    }

    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;
    const resized = computeResizedImageSize(originalWidth, originalHeight, maxPixel);

    const canvas = document.createElement('canvas');
    canvas.width = resized.width;
    canvas.height = resized.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    ctx.drawImage(bitmap, 0, 0, resized.width, resized.height);

    const meta = {
      label,
      originalWidth,
      originalHeight,
      textureWidth: resized.width,
      textureHeight: resized.height,
      maxPixel,
      scale: resized.scale,
      resized: resized.resized,
      originalBytes: fileOrBlob?.size ?? null,
      durationMs: Math.round(performance.now() - t0),
    };

    console.debug('[image-optimize] complete', meta);

    return {
      canvas,
      ...meta,
    };
  } finally {
    bitmap?.close?.();
  }
}
