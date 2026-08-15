export const MAX_ROOM_CODE_LENGTH = 24;

export function sanitizeRoomCode(value) {
  if (!value) return null;
  const cleaned = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, '')
    .slice(0, MAX_ROOM_CODE_LENGTH);
  return cleaned || null;
}

export function isSanitizedRoomCode(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ROOM_CODE_LENGTH
    && sanitizeRoomCode(value) === value;
}
