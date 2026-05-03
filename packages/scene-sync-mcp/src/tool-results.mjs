function statusToErrorCode(status) {
  if (status === 400 || status === 422) return 'validation_error'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409 || status === 410) return 'conflict'
  return 'internal_error'
}

function statusToRetryable(status) {
  return status === 409 || status === 410 || status >= 500
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeToolError(error) {
  if (error && typeof error === 'object') {
    if (error.error && isPlainObject(error.error) && typeof error.error.code === 'string') {
      return {
        code: error.error.code,
        message: error.error.message || error.message || 'Unexpected error',
        retryable: error.error.retryable ?? false,
        ...(error.error.details ? { details: error.error.details } : {})
      }
    }

    if (typeof error.code === 'string' && typeof error.message === 'string') {
      return {
        code: error.code,
        message: error.message,
        retryable: error.retryable ?? false,
        ...(error.details ? { details: error.details } : {})
      }
    }

    if (error.name === 'ValidationError') {
      return {
        code: error.code || 'validation_error',
        message: error.message || 'Validation error',
        retryable: error.retryable ?? false,
        ...(error.details ? { details: error.details } : {})
      }
    }

    if (error.name === 'SceneSyncApiError') {
      const code = statusToErrorCode(error.status)
      return {
        code,
        message: error.message || `HTTP ${error.status}`,
        retryable: error.retryable ?? statusToRetryable(error.status),
        ...(typeof error.status === 'number' ? { status: error.status } : {}),
        ...(error.details ? { details: error.details } : {}),
        ...(error.body ? { body: error.body } : {})
      }
    }

    if (error.name === 'AbortError') {
      return {
        code: 'internal_error',
        message: 'Request timed out.',
        retryable: true
      }
    }

    if (typeof error.message === 'string') {
      return {
        code: 'internal_error',
        message: error.message,
        retryable: true
      }
    }
  }

  if (typeof error === 'string') {
    return {
      code: 'internal_error',
      message: error,
      retryable: false
    }
  }

  return {
    code: 'internal_error',
    message: 'Unexpected error',
    retryable: true
  }
}

export function jsonResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }
    ]
  }
}

export function errorResult(error, details = null) {
  const normalized = normalizeToolError(error)
  if (details) {
    normalized.details = details
  }
  const result = {
    ok: false,
    error: normalized
  }
  return jsonResult(result)
}

export function successResult(data) {
  return jsonResult({
    ok: true,
    ...data
  })
}
