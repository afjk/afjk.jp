const LINK_STORAGE_KEY = 'scenesync.linkToken';

export class LinkManager {
  constructor(baseUrl = window.location.origin + '/presence/api') {
    this.baseUrl = baseUrl;
    this.linkToken = null;
    this.linkId = null;
    this.expiresAt = null;
    this.onStatusChange = null;

    // localStorage から復元
    try {
      const saved = JSON.parse(localStorage.getItem(LINK_STORAGE_KEY) || 'null');
      if (saved && saved.expiresAt > Date.now()) {
        this.linkToken = saved.linkToken;
        this.linkId = saved.linkId;
        this.expiresAt = saved.expiresAt;
      }
    } catch {}
  }

  #saveLinkToStorage() {
    if (this.linkToken) {
      localStorage.setItem(LINK_STORAGE_KEY, JSON.stringify({
        linkToken: this.linkToken,
        linkId: this.linkId,
        expiresAt: this.expiresAt
      }));
    } else {
      localStorage.removeItem(LINK_STORAGE_KEY);
    }
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
      this.#saveLinkToStorage();

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

      this.linkToken = null;
      this.linkId = null;
      this.expiresAt = null;
      this.#saveLinkToStorage();

      if (this.onStatusChange) {
        this.onStatusChange({
          isLinked: false
        });
      }

      return { ok: true };
    } catch (err) {
      throw err;
    }
  }

  isLinked() {
    return !!this.linkToken;
  }

  getLinkToken() {
    if (!this.linkToken) return null;
    if (this.expiresAt && Date.now() > this.expiresAt) {
      this.linkToken = null;
      this.linkId = null;
      this.expiresAt = null;
      this.#saveLinkToStorage();
      return null;
    }
    return this.linkToken;
  }
}

export function createLinkManager(baseUrl) {
  return new LinkManager(baseUrl);
}
