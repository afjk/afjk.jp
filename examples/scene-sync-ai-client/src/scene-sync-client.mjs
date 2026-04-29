import {
  assertAiCommand,
  assertCode,
  assertPrimitiveAsset,
  assertRoomId,
  assertScenePayload,
  assertSessionId,
} from './validators.mjs';

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
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    return data;
  }
}
