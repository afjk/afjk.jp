const STORAGE_KEYS = {
  linkToken: 'scenesync.linkToken',
  linkId: 'scenesync.linkId',
  expiresAt: 'scenesync.linkExpiresAt',
  roomId: 'scenesync.linkRoomId',
  userId: 'scenesync.linkUserId',
};

export class LinkManager {
  constructor(baseUrl = window.location.origin + '/presence/api') {
    this.baseUrl = baseUrl;
    this.linkToken = null;
    this.linkId = null;
    this.expiresAt = null;
    this.roomId = null;
    this.onStatusChange = null;

    this._loadFromStorage();
  }

  _loadFromStorage() {
    try {
      const token = localStorage.getItem(STORAGE_KEYS.linkToken);
      const linkId = localStorage.getItem(STORAGE_KEYS.linkId);
      const expiresAtStr = localStorage.getItem(STORAGE_KEYS.expiresAt);
      const roomId = localStorage.getItem(STORAGE_KEYS.roomId);

      if (!token || !linkId || !expiresAtStr || !roomId) {
        return;
      }

      const expiresAt = Number(expiresAtStr);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        this._clearStorage();
        return;
      }

      this.linkToken = token;
      this.linkId = linkId;
      this.expiresAt = expiresAt;
      this.roomId = roomId;
    } catch (e) {
      console.warn('[LinkManager] failed to restore from localStorage', e);
    }
  }

  _saveToStorage() {
    try {
      if (!this.linkToken) return;
      localStorage.setItem(STORAGE_KEYS.linkToken, this.linkToken);
      localStorage.setItem(STORAGE_KEYS.linkId, this.linkId);
      localStorage.setItem(STORAGE_KEYS.expiresAt, String(this.expiresAt));
      localStorage.setItem(STORAGE_KEYS.roomId, this.roomId);
    } catch (e) {
      console.warn('[LinkManager] failed to save to localStorage', e);
    }
  }

  _clearStorage() {
    try {
      Object.values(STORAGE_KEYS).forEach(k => localStorage.removeItem(k));
    } catch (e) {
      console.warn('[LinkManager] failed to clear localStorage', e);
    }
  }

  clearLocal() {
    this.linkToken = null;
    this.linkId = null;
    this.expiresAt = null;
    this.roomId = null;
    this._clearStorage();
  }

  async initiatePairing(roomId, userId) {
    try {
      const res = await fetch(`${this.baseUrl}/link/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, userId })
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to initiate pairing');
      }

      const data = await res.json();
      return {
        code: data.code,
        expiresAt: data.expiresAt
      };
    } catch (err) {
      throw err;
    }
  }

  async redeemCode(code) {
    try {
      const res = await fetch(`${this.baseUrl}/link/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to redeem code');
      }

      const data = await res.json();
      this.linkToken = data.linkToken;
      this.linkId = data.linkId;
      this.expiresAt = data.expiresAt;
      this.roomId = data.roomId;
      this._saveToStorage();

      if (this.onStatusChange) {
        this.onStatusChange({
          isLinked: true,
          expiresAt: this.expiresAt
        });
      }

      return data;
    } catch (err) {
      throw err;
    }
  }

  async revoke() {
    if (!this.linkToken) return { ok: true };
    try {
      const res = await fetch(`${this.baseUrl}/link/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.linkToken}`
        },
        body: JSON.stringify({ linkId: this.linkId })
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to revoke link');
      }

      return { ok: true };
    } catch (err) {
      throw err;
    } finally {
      this.clearLocal();
      if (this.onStatusChange) {
        this.onStatusChange({
          isLinked: false
        });
      }
    }
  }

  isLinked() {
    return !!this.linkToken;
  }

  getLinkToken() {
    if (!this.linkToken) return null;
    if (this.expiresAt && Date.now() > this.expiresAt) {
      this.clearLocal();
      return null;
    }
    return this.linkToken;
  }
}

export function createLinkManager(baseUrl) {
  return new LinkManager(baseUrl);
}
