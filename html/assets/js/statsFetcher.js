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
    const summary = data.summary || {};
    const p2p = summary.p2p || { count: 0, bytes: 0 };
    const pipe = summary.pipe || { count: 0, bytes: 0 };
    const torrent = summary.torrent || { count: 0, bytes: 0 };
    const stream = data.stream || { sessions: 0, bytes: 0 };
    const total = p2p.count + pipe.count + torrent.count;
    const totalBytes = (p2p.bytes || 0) + (pipe.bytes || 0) + (torrent.bytes || 0);

    this.setText(this.selectors.total, this.formatNumber(total));
    this.setText(this.selectors.p2p, this.formatNumber(p2p.count));
    this.setText(this.selectors.relay, this.formatNumber(pipe.count));
    this.setText(this.selectors.torrent, this.formatNumber(torrent.count));
    this.setText(this.selectors.bytes, this.formatBytes(totalBytes));
    this.setText(this.selectors.stream, this.formatBytes(stream.bytes));
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
