export class SceneSyncApiError extends Error {
  constructor(status, message, body) {
    super(message)
    this.name = 'SceneSyncApiError'
    this.status = status
    this.body = body
  }
}

export class SceneSyncClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.SCENE_SYNC_BASE_URL || 'https://afjk.jp/presence/api/ai'
  }

  async postJson(path, body) {
    const url = this.baseUrl + path
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      let errorBody = null
      try {
        errorBody = await response.json()
      } catch (e) {
        // ignore parse error
      }
      const message = errorBody?.error || errorBody?.message || `HTTP ${response.status}`
      throw new SceneSyncApiError(response.status, message, errorBody)
    }

    return response.json()
  }

  async redeem(code) {
    return this.postJson('/link/redeem', { code })
  }

  async revoke(sessionId) {
    return this.postJson('/link/revoke', { sessionId })
  }

  async getScene(roomId, sessionId) {
    return this.postJson(`/room/${roomId}/scene`, { sessionId })
  }

  async broadcast(roomId, sessionId, payload) {
    return this.postJson(`/room/${roomId}/broadcast`, {
      sessionId,
      payload
    })
  }

  async aiCommand(roomId, sessionId, action, params = {}, options = {}) {
    const timeout = options.timeout || 30000
    const body = {
      sessionId,
      action,
      params
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(this.baseUrl + `/room/${roomId}/ai-command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      if (!response.ok) {
        let errorBody = null
        try {
          errorBody = await response.json()
        } catch (e) {
          // ignore parse error
        }
        const message = errorBody?.error || errorBody?.message || `HTTP ${response.status}`
        throw new SceneSyncApiError(response.status, message, errorBody)
      }

      return response.json()
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
