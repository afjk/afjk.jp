export function generateTemporaryImageObjectId() {
  const randomPart = globalThis.crypto?.randomUUID?.()
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `temp-image-${Date.now().toString(36)}-${randomPart}`;
}
