export function generateTemporaryImageObjectId() {
  return `temp-image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
