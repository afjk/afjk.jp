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

export function errorResult(message, details = null) {
  const result = {
    ok: false,
    error: message
  }
  if (details) {
    result.details = details
  }
  return jsonResult(result)
}

export function successResult(data) {
  return jsonResult({
    ok: true,
    ...data
  })
}
