const SUPPORTED_EXTENSIONS = new Set(['.glb', '.gltf', '.png', '.jpg', '.jpeg', '.webp', '.webm', '.mp4']);
const SUPPORTED_MIME_TYPES = new Set([
  'model/gltf-binary',
  'model/gltf+json',
  'application/octet-stream',
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/webm',
  'video/mp4',
]);

export function getFileExtension(filename = '') {
  const index = String(filename).lastIndexOf('.');
  if (index < 0) return '';
  return String(filename).slice(index).toLowerCase();
}

export function isGlbLike({ filename = '', mimeType = '' }) {
  const ext = getFileExtension(filename);
  return ext === '.glb' || mimeType === 'model/gltf-binary';
}

export function hasValidGlbMagic(buffer) {
  if (!buffer || buffer.length < 4) return false;
  return buffer.subarray(0, 4).toString('ascii') === 'glTF';
}

export function validateUpload({ size, mimeType, filename = '', buffer = null, maxUploadBytes }) {
  const extension = getFileExtension(filename);

  if (size > maxUploadBytes) {
    return { ok: false, status: 413, code: 'file_too_large', reason: 'size limit exceeded', message: 'ファイルサイズが大きすぎます。' };
  }

  const extensionSupported = !extension || SUPPORTED_EXTENSIONS.has(extension);
  const mimeSupported = SUPPORTED_MIME_TYPES.has(mimeType);
  if (!extensionSupported || !mimeSupported) {
    return { ok: false, status: 415, code: 'unsupported_type', reason: 'unsupported mime or extension', message: 'このファイル形式には対応していません。' };
  }

  if (isGlbLike({ filename, mimeType }) && !hasValidGlbMagic(buffer)) {
    return { ok: false, status: 400, code: 'invalid_glb', reason: 'invalid glb magic', message: 'GLBファイルの形式が正しくありません。' };
  }

  return { ok: true };
}
