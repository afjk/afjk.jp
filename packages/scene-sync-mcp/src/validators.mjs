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
  if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === 'number' && Number.isFinite(v))) {
    throw new ValidationError(`${name} must be [finite number, finite number, finite number].`)
  }
}

export function assertQuat(value, name = 'quaternion') {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(v => typeof v === 'number' && Number.isFinite(v))) {
    throw new ValidationError(`${name} must be [finite number, finite number, finite number, finite number].`)
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

export function assertBoundsWorld(value, name = 'bounds.world') {
  if (!value || typeof value !== 'object') {
    throw new ValidationError(`${name} must be an object.`)
  }

  assertVec3(value.min, `${name}.min`)
  assertVec3(value.center, `${name}.center`)
  assertVec3(value.max, `${name}.max`)

  if (value.size !== undefined) {
    assertVec3(value.size, `${name}.size`)
  }
}

export function getAxisIndex(axis) {
  if (axis === 'x') return 0
  if (axis === 'y') return 1
  if (axis === 'z') return 2
  throw new ValidationError(`Invalid axis: ${axis}`)
}

export function getBoundsAnchor(bounds, axis, anchor) {
  assertBoundsWorld(bounds)
  const index = getAxisIndex(axis)

  if (anchor === 'min') return bounds.min[index]
  if (anchor === 'center') return bounds.center[index]
  if (anchor === 'max') return bounds.max[index]

  throw new ValidationError(`Invalid anchor: ${anchor}`)
}

function assertPositiveFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`${name} must be a positive number.`)
  }
}

function assertNonZeroBoundsSize(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) < 1e-9) {
    throw new ValidationError(`${name} must be non-zero.`)
  }
}

export function computeAlignedPosition({ sourcePosition, sourceBounds, targetBounds = null, axes }) {
  assertVec3(sourcePosition, 'sourcePosition')
  assertBoundsWorld(sourceBounds, 'sourceBounds')

  if (!axes || typeof axes !== 'object') {
    throw new ValidationError('axes must be an object.')
  }

  const nextPosition = [...sourcePosition]
  let applied = 0

  for (const axis of ['x', 'y', 'z']) {
    const rule = axes[axis]
    if (!rule) continue

    applied += 1

    const sourceAnchor = getBoundsAnchor(sourceBounds, axis, rule.source)
    let targetValue = null

    if (typeof rule.value === 'number') {
      if (!Number.isFinite(rule.value)) {
        throw new ValidationError(`axes.${axis}.value must be a finite number.`)
      }
      targetValue = rule.value
    } else {
      if (!targetBounds) {
        throw new ValidationError(`axes.${axis}.value or targetBounds is required.`)
      }
      if (!rule.target) {
        throw new ValidationError(`axes.${axis}.target is required when aligning to target bounds.`)
      }
      targetValue = getBoundsAnchor(targetBounds, axis, rule.target)
    }

    const offset = rule.offset === undefined ? 0 : rule.offset
    if (typeof offset !== 'number' || !Number.isFinite(offset)) {
      throw new ValidationError(`axes.${axis}.offset must be a finite number.`)
    }

    const delta = targetValue + offset - sourceAnchor
    nextPosition[getAxisIndex(axis)] += delta
  }

  if (applied === 0) {
    throw new ValidationError('At least one axis rule is required.')
  }

  return nextPosition
}

export function computeFitScale({ currentScale, currentBoundsSize, targetSize, preserveAspect = true }) {
  assertVec3(currentScale, 'currentScale')
  assertVec3(currentBoundsSize, 'currentBoundsSize')

  if (!targetSize || typeof targetSize !== 'object') {
    throw new ValidationError('targetSize must be an object.')
  }

  const specifiedAxes = ['x', 'y', 'z'].filter((axis) => targetSize[axis] !== undefined)

  if (specifiedAxes.length === 0) {
    throw new ValidationError('At least one target size axis is required.')
  }

  for (const axis of specifiedAxes) {
    assertPositiveFiniteNumber(targetSize[axis], `targetSize.${axis}`)
  }

  if (preserveAspect) {
    const axis = specifiedAxes[0]
    const index = getAxisIndex(axis)
    const currentSize = currentBoundsSize[index]
    assertNonZeroBoundsSize(currentSize, `currentBoundsSize.${axis}`)

    const factor = targetSize[axis] / currentSize
    return currentScale.map((value) => value * factor)
  }

  const nextScale = [...currentScale]

  for (const axis of specifiedAxes) {
    const index = getAxisIndex(axis)
    const currentSize = currentBoundsSize[index]
    assertNonZeroBoundsSize(currentSize, `currentBoundsSize.${axis}`)
    nextScale[index] = currentScale[index] * (targetSize[axis] / currentSize)
  }

  return nextScale
}

export function computeBoundsAlignmentErrors({ sourceBounds, targetBounds = null, axes }) {
  assertBoundsWorld(sourceBounds, 'sourceBounds')

  if (!axes || typeof axes !== 'object') {
    throw new ValidationError('axes must be an object.')
  }

  const errors = {}
  const passed = {}
  let checked = 0

  for (const axis of ['x', 'y', 'z']) {
    const rule = axes[axis]
    if (!rule) continue

    checked += 1

    const sourceValue = getBoundsAnchor(sourceBounds, axis, rule.source)
    let targetValue = null

    if (typeof rule.value === 'number') {
      if (!Number.isFinite(rule.value)) {
        throw new ValidationError(`axes.${axis}.value must be a finite number.`)
      }
      targetValue = rule.value
    } else {
      if (!targetBounds) {
        throw new ValidationError(`axes.${axis}.value or targetBounds is required.`)
      }
      if (!rule.target) {
        throw new ValidationError(`axes.${axis}.target is required when verifying target bounds.`)
      }
      targetValue = getBoundsAnchor(targetBounds, axis, rule.target)
    }

    const offset = rule.offset === undefined ? 0 : rule.offset
    if (typeof offset !== 'number' || !Number.isFinite(offset)) {
      throw new ValidationError(`axes.${axis}.offset must be a finite number.`)
    }

    const tolerance = rule.tolerance === undefined ? 0.01 : rule.tolerance
    if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
      throw new ValidationError(`axes.${axis}.tolerance must be a finite non-negative number.`)
    }

    const error = sourceValue - (targetValue + offset)
    errors[axis] = error
    passed[axis] = Math.abs(error) <= tolerance
  }

  if (checked === 0) {
    throw new ValidationError('At least one axis rule is required.')
  }

  return {
    ok: Object.values(passed).every(Boolean),
    errors,
    passed
  }
}
