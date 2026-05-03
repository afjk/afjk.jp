export class ValidationError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'ValidationError'
    this.code = options.code || 'validation_error'
    this.retryable = options.retryable ?? false
    this.details = options.details || null
  }
}

export function assertLinked(session) {
  if (!session.sessionId || !session.roomId) {
    throw new ValidationError('Not linked to Scene Sync. Call scene_sync_redeem first.', {
      code: 'unauthorized'
    })
  }
  if (session.expiresAt && session.expiresAt <= Date.now()) {
    throw new ValidationError('Scene Sync link expired. Call scene_sync_redeem again.', {
      code: 'unauthorized'
    })
  }
}

export function assertCode(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new ValidationError('Code must be exactly 6 digits.')
  }
}

export function assertVec3(value, name = 'vector') {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === 'number')) {
    throw new ValidationError(`${name} must be [number, number, number].`)
  }
}

export function assertQuat(value, name = 'quaternion') {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(v => typeof v === 'number')) {
    throw new ValidationError(`${name} must be [number, number, number, number].`)
  }
}

export function assertObjectId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('objectId must be a non-empty string.')
  }
}

export function assertColor(value) {
  if (typeof value !== 'string' || !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
    throw new ValidationError('color must be #RGB or #RRGGBB format.')
  }
}

export function normalizeVec3(value, fallback = [0, 0.5, 0]) {
  if (value === undefined || value === null) {
    return fallback
  }
  assertVec3(value, 'position')
  return value
}

export function normalizeQuat(value, fallback = [0, 0, 0, 1]) {
  if (value === undefined || value === null) {
    return fallback
  }
  assertQuat(value, 'rotation')
  return value
}

export function normalizeScale(value, fallback = [1, 1, 1]) {
  if (value === undefined || value === null) {
    return fallback
  }
  assertVec3(value, 'scale')
  return value
}

export function normalizeColor(value, defaultColor = '#ff8800') {
  if (value === undefined || value === null) {
    return defaultColor
  }
  assertColor(value)
  return value
}

export function normalizePrimitive(value, fallback = 'box') {
  const valid = ['box', 'sphere', 'cylinder', 'plane']
  if (value === undefined || value === null) {
    return fallback
  }
  if (!valid.includes(value)) {
    throw new ValidationError(`primitive must be one of: ${valid.join(', ')}`)
  }
  return value
}

export function makeObjectId(prefix = 'ai-object') {
  return `${prefix}-${Date.now()}`
}

export function normalizeName(value, fallback) {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'string') {
    throw new ValidationError('name must be a string.')
  }
  return value
}

export function primitiveToName(primitive) {
  const names = {
    box: 'AI Box',
    sphere: 'AI Sphere',
    cylinder: 'AI Cylinder',
    plane: 'AI Plane'
  }
  return names[primitive] || 'AI Object'
}
