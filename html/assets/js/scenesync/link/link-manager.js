export class LinkManager {
  constructor(baseUrl = window.location.origin + '/presence/api') {
    this.baseUrl = baseUrl;
    this.linkToken = null;
    this.linkId = null;
    this.expiresAt = null;
    this.onStatusChange = null;
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
      return null;
    }
    return this.linkToken;
  }
}

export function createLinkManager(baseUrl) {
  return new LinkManager(baseUrl);
}
