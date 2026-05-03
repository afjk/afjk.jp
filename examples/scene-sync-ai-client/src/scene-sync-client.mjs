import {
  assertAiCommand,
  assertCode,
  assertPrimitiveAsset,
  assertRoomId,
  assertScenePayload,
  assertSessionId,
} from './validators.mjs';

function errorCodeFromStatus(status) {
  if (status === 400 || status === 422) return 'validation_error';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409 || status === 410) return 'conflict';
  return 'internal_error';
}

function retryableFromStatus(status) {
  return status === 409 || status === 410 || status >= 500;
}

function extractErrorDetails(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }

  if (body.error && typeof body.error === 'object') {
    return body.error;
  }

  if (typeof body.error === 'string') {
    return {
      message: body.error,
    };
  }

  return body;
}

export class SceneSyncApiError extends Error {
  constructor(status, body, fallbackMessage = `HTTP ${status}`) {
    const error = extractErrorDetails(body);
    const message = error?.message || body?.message || fallbackMessage;
    super(message);

    this.name = 'SceneSyncApiError';
    this.status = status;
    this.code = error?.code || errorCodeFromStatus(status);
    this.retryable = typeof error?.retryable === 'boolean' ? error.retryable : retryableFromStatus(status);
    this.body = body;
    this.details = error?.details || body?.details || null;
  }
}

export class SceneSyncClient {
  constructor(baseUrl = process.env.SCENE_SYNC_BASE_URL || 'https://afjk.jp/presence/api/ai') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async redeem(code) {
    assertCode(code);
    return this.#post('/link/redeem', { code });
  }

  async getScene(roomId, sessionId) {
    assertRoomId(roomId);
    assertSessionId(sessionId);
    return this.#post(`/room/${encodeURIComponent(roomId)}/scene`, { sessionId });
  }

  async broadcast(roomId, sessionId, payload) {
    assertRoomId(roomId);
    assertSessionId(sessionId);
    assertScenePayload(payload);
    assertPrimitiveAsset(payload);
    return this.#post(`/room/${encodeURIComponent(roomId)}/broadcast`, {
      sessionId,
      payload,
    });
  }

  async aiCommand(roomId, sessionId, action, params = {}) {
    assertRoomId(roomId);
    assertSessionId(sessionId);
    assertAiCommand(action, params);
    return this.#post(`/room/${encodeURIComponent(roomId)}/ai-command`, {
      sessionId,
      action,
      params,
    });
  }

  async revoke(sessionId) {
    assertSessionId(sessionId);
    return this.#post('/link/revoke', { sessionId });
  }

  async #post(path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new SceneSyncApiError(response.status, data);
    }
    return data;
  }
}
