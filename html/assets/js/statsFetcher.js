export class StatsFetcher {
  constructor({ endpoint, selectors }) {
    this.endpoint = endpoint;
    this.selectors = selectors;
  }

  async run() {
    try {
      const response = await fetch(this.endpoint, { cache: 'no-cache' });
      if (!response.ok) return;
      const stats = await response.json();
      this.update(stats);
    } catch (error) {
      console.warn('Failed to load stats', error);
    }
  }

  update(data = {}) {
    const p2p = data.p2p || { count: 0, bytes: 0 };
    const pipe = data.pipe || { count: 0, bytes: 0 };
    const torrent = data.torrent || { count: 0, bytes: 0 };
    const total = p2p.count + pipe.count + torrent.count;

    this.setText(this.selectors.total, this.formatNumber(total));
    this.setText(this.selectors.p2p, this.formatNumber(p2p.count));
    this.setText(this.selectors.relay, this.formatNumber(pipe.count));
    this.setText(this.selectors.torrent, this.formatNumber(torrent.count));
    this.setText(this.selectors.bytes, this.formatBytes(pipe.bytes));
  }

  setText(selector, value) {
    const el = document.querySelector(selector);
    if (el) {
      el.textContent = value;
    }
  }

  formatNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  formatBytes(bytes = 0) {
    if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + ' TB';
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + ' KB';
    return `${bytes} B`;
  }
}
