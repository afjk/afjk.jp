export const IMAGE_SHAPE = {
  PLANE: 'plane',
  SPHERE_INSIDE: 'sphere-inside',
  HDRI: 'hdri',
  UNKNOWN: 'unknown',
};

export const CONFIDENCE = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

export function classifyByExtension(filename) {
  if (!filename) return null;
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (ext === 'hdr' || ext === 'exr') {
    return { shape: IMAGE_SHAPE.HDRI, confidence: CONFIDENCE.HIGH, reason: 'extension:hdr/exr' };
  }
  return null;
}

export function classifyByGPano(xmp) {
  if (!xmp) return null;
  const projectionType = xmp.ProjectionType || xmp['GPano:ProjectionType'];
  if (projectionType === 'equirectangular') {
    return { shape: IMAGE_SHAPE.SPHERE_INSIDE, confidence: CONFIDENCE.HIGH, reason: 'gpano-xmp' };
  }
  return null;
}

export function classifyByAspect(width, height) {
  if (!width || !height) return null;
  const aspect = width / height;
  const targetAspect = 2;
  const tolerance = 0.05;
  if (Math.abs(aspect - targetAspect) <= tolerance && width >= 2048) {
    return { shape: IMAGE_SHAPE.SPHERE_INSIDE, confidence: CONFIDENCE.MEDIUM, reason: 'aspect-2to1' };
  }
  return null;
}

export function classifyByFilename(filename) {
  if (!filename) return null;
  const lowerName = filename.toLowerCase();
  const regex = /(^|[^a-z])(pano|360|equirect|sphere)([^a-z]|$)/i;
  if (regex.test(lowerName)) {
    return { shape: IMAGE_SHAPE.SPHERE_INSIDE, confidence: CONFIDENCE.LOW, reason: 'filename-hint' };
  }
  return null;
}

export async function detectImageShape(file, deps) {
  if (!file) {
    return {
      shape: IMAGE_SHAPE.UNKNOWN,
      confidence: CONFIDENCE.HIGH,
      reason: 'no-file',
      metadata: { width: 0, height: 0, aspect: 0, hasAlpha: false, gpano: false, filenameHint: false, ext: '' },
    };
  }

  const filename = file.name || '';
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  // Extension check first (highest priority)
  const extClassification = classifyByExtension(filename);
  if (extClassification) {
    return {
      shape: extClassification.shape,
      confidence: extClassification.confidence,
      reason: extClassification.reason,
      metadata: { width: 0, height: 0, aspect: 0, hasAlpha: false, gpano: false, filenameHint: false, ext },
    };
  }

  // Parallel execution of exifr and getImageSize
  const [exifrResult, imageSizeResult, hasAlphaResult] = await Promise.allSettled([
    deps.exifr.parse(file, { xmp: true, ifd0: false, exif: false, gps: false, interop: false, thumbnail: false }),
    deps.getImageSize(file),
    deps.hasAlpha(file),
  ]);

  const xmp = exifrResult.status === 'fulfilled' ? exifrResult.value : undefined;
  const imageSize = imageSizeResult.status === 'fulfilled' ? imageSizeResult.value : null;
  const alpha = hasAlphaResult.status === 'fulfilled' ? hasAlphaResult.value : false;

  // Handle image decode failure
  if (!imageSize) {
    return {
      shape: IMAGE_SHAPE.UNKNOWN,
      confidence: CONFIDENCE.HIGH,
      reason: 'image-decode-failed',
      metadata: { width: 0, height: 0, aspect: 0, hasAlpha: alpha, gpano: false, filenameHint: false, ext },
    };
  }

  const { width, height } = imageSize;
  const aspect = height > 0 ? width / height : 0;

  // GPano check
  const gpanoClassification = classifyByGPano(xmp);
  if (gpanoClassification) {
    return {
      shape: gpanoClassification.shape,
      confidence: gpanoClassification.confidence,
      reason: gpanoClassification.reason,
      metadata: { width, height, aspect, hasAlpha: alpha, gpano: true, filenameHint: false, ext },
    };
  }

  // Aspect ratio check
  const aspectClassification = classifyByAspect(width, height);
  if (aspectClassification) {
    const filenameHint = !!classifyByFilename(filename);
    return {
      shape: aspectClassification.shape,
      confidence: aspectClassification.confidence,
      reason: aspectClassification.reason,
      metadata: { width, height, aspect, hasAlpha: alpha, gpano: false, filenameHint, ext },
    };
  }

  // Filename hint check
  const filenameClassification = classifyByFilename(filename);
  if (filenameClassification) {
    return {
      shape: filenameClassification.shape,
      confidence: filenameClassification.confidence,
      reason: filenameClassification.reason,
      metadata: { width, height, aspect, hasAlpha: alpha, gpano: false, filenameHint: true, ext },
    };
  }

  // Default to plane
  return {
    shape: IMAGE_SHAPE.PLANE,
    confidence: CONFIDENCE.HIGH,
    reason: 'default-plane',
    metadata: { width, height, aspect, hasAlpha: alpha, gpano: false, filenameHint: false, ext },
  };
}
