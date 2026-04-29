const STORAGE_KEYS = {
  linkToken: 'scenesync.linkToken',
  linkId: 'scenesync.linkId',
  expiresAt: 'scenesync.linkExpiresAt',
  roomId: 'scenesync.linkRoomId',
  userId: 'scenesync.linkUserId',
};

const linkStorage = window.sessionStorage;

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

  _hasValidLink() {
    return !!(this.linkId && this.roomId && this.expiresAt && this.expiresAt > Date.now());
  }

  _loadFromStorage() {
    try {
      const token = linkStorage.getItem(STORAGE_KEYS.linkToken);
      const linkId = linkStorage.getItem(STORAGE_KEYS.linkId);
      const expiresAtStr = linkStorage.getItem(STORAGE_KEYS.expiresAt);
      const roomId = linkStorage.getItem(STORAGE_KEYS.roomId);

      if (!linkId || !expiresAtStr || !roomId) {
        return;
      }

      const expiresAt = Number(expiresAtStr);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        this._clearStorage();
        return;
      }

      this.linkToken = token || null;
      this.linkId = linkId;
      this.expiresAt = expiresAt;
      this.roomId = roomId;
    } catch (e) {
      console.warn('[LinkManager] failed to restore from sessionStorage', e);
    }
  }

  _saveToStorage() {
    try {
      if (!this._hasValidLink()) return;
      if (this.linkToken) {
        linkStorage.setItem(STORAGE_KEYS.linkToken, this.linkToken);
      } else {
        linkStorage.removeItem(STORAGE_KEYS.linkToken);
      }
      linkStorage.setItem(STORAGE_KEYS.linkId, this.linkId);
      linkStorage.setItem(STORAGE_KEYS.expiresAt, String(this.expiresAt));
      linkStorage.setItem(STORAGE_KEYS.roomId, this.roomId);
    } catch (e) {
      console.warn('[LinkManager] failed to save to sessionStorage', e);
    }
  }

  _clearStorage() {
    try {
      Object.values(STORAGE_KEYS).forEach(k => linkStorage.removeItem(k));
    } catch (e) {
      console.warn('[LinkManager] failed to clear sessionStorage', e);
    }
  }

  clearLocal() {
    this.linkToken = null;
    this.linkId = null;
    this.expiresAt = null;
    this.roomId = null;
    this._clearStorage();
  }

  establishLink({ linkToken = null, linkId, expiresAt, roomId }) {
    if (!linkId || !expiresAt || !roomId) {
      return false;
    }

    const expires = Number(expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      this.clearLocal();
      return false;
    }

    this.linkToken = linkToken;
    this.linkId = linkId;
    this.expiresAt = expires;
    this.roomId = roomId;
    this._saveToStorage();

    if (this.onStatusChange) {
      this.onStatusChange({
        isLinked: true,
        expiresAt: this.expiresAt
      });
    }

    return true;
  }

  async initiatePairing(roomId, userId, peerId = null) {
    try {
      const res = await fetch(`${this.baseUrl}/link/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, userId, peerId })
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
      this.establishLink(data);

      return data;
    } catch (err) {
      throw err;
    }
  }

  async revoke() {
    if (!this.linkId) return { ok: true };
    try {
      const headers = {
        'Content-Type': 'application/json',
      };
      if (this.linkToken) {
        headers.Authorization = `Bearer ${this.linkToken}`;
      }
      const res = await fetch(`${this.baseUrl}/link/revoke`, {
        method: 'POST',
        headers,
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
    if (!this._hasValidLink()) {
      this.clearLocal();
      return false;
    }
    return true;
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
