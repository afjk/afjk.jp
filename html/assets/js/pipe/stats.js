const STATS_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? `http://${location.hostname}:8787`
  : '/presence';

class StatsDashboard {
  constructor({
    refreshBtn,
    typeFilter,
    windowSelect,
    limitSelect,
    autoRefreshSelect,
    downloadBtn,
    updatedLabel,
    summaryContainer,
    tableBody,
  }) {
    this.refreshBtn = document.querySelector(refreshBtn);
    this.typeFilter = document.querySelector(typeFilter);
    this.windowSelect = document.querySelector(windowSelect);
    this.limitSelect = document.querySelector(limitSelect);
    this.autoRefreshSelect = document.querySelector(autoRefreshSelect);
    this.downloadBtn = document.querySelector(downloadBtn);
    this.updatedLabel = document.querySelector(updatedLabel);
    this.summaryContainer = document.querySelector(summaryContainer);
    this.tableBody = document.querySelector(tableBody);
    this.autoTimer = null;
  }

  init() {
    if (!this.tableBody) return;
    this.bindEvents();
    this.loadStats();
    this.scheduleAutoRefresh();
  }

  bindEvents() {
    this.refreshBtn?.addEventListener('click', () => this.loadStats());
    this.typeFilter?.addEventListener('change', () => this.loadStats());
    this.windowSelect?.addEventListener('change', () => this.loadStats());
    this.limitSelect?.addEventListener('change', () => this.loadStats());

    this.autoRefreshSelect?.addEventListener('change', () => {
      this.scheduleAutoRefresh();
      this.loadStats();
    });

    this.downloadBtn?.addEventListener('click', () => {
      const url = this.csvUrl();
      window.open(url, '_blank');
    });
  }

  statsUrl() {
    const limit = this.limitSelect?.value || '100';
    const type = this.typeFilter?.value;
    const params = new URLSearchParams({ limit });
    if (type) params.set('type', type);
    return `${STATS_BASE}/stats?${params.toString()}`;
  }

  csvUrl() {
    const limit = this.limitSelect?.value || '100';
    const type = this.typeFilter?.value;
    const params = new URLSearchParams({ limit, format: 'csv' });
    if (type) params.set('type', type);
    return `${STATS_BASE}/stats/export?${params.toString()}`;
  }

  scheduleAutoRefresh() {
    if (this.autoTimer) clearInterval(this.autoTimer);
    const interval = Number(this.autoRefreshSelect?.value || 0);
    if (interval > 0) {
      this.autoTimer = setInterval(() => this.loadStats(), interval * 1000);
    }
  }

  async loadStats() {
    if (!this.tableBody) return;
    this.tableBody.innerHTML = '<tr><td colspan="7" class="muted">Loading…</td></tr>';
    try {
      const response = await fetch(this.statsUrl());
      if (!response.ok) throw new Error(response.statusText);
      const payload = await response.json();
      this.renderSummary(payload.summary || {});
      const logs = this.applyWindowFilter(payload.logs || []);
      this.renderLogs(logs);
      if (this.updatedLabel) {
        this.updatedLabel.textContent = `Updated ${new Date().toLocaleTimeString()}`;
      }
    } catch (error) {
      this.tableBody.innerHTML = `<tr><td colspan="7" class="muted">Failed: ${error.message}</td></tr>`;
    }
  }

  applyWindowFilter(logs) {
    const windowValue = this.windowSelect?.value;
    if (!windowValue) return logs;
    const now = Date.now();
    let cutoff = 0;
    if (windowValue === '5m') cutoff = now - 5 * 60 * 1000;
    else if (windowValue === '1h') cutoff = now - 60 * 60 * 1000;
    else if (windowValue === '24h') cutoff = now - 24 * 60 * 60 * 1000;
    return logs.filter(entry => (entry.ts || 0) >= cutoff);
  }

  renderSummary(summary) {
    if (!this.summaryContainer) return;
    this.summaryContainer.innerHTML = '';
    ['p2p', 'pipe', 'torrent'].forEach(type => {
      const entry = summary?.[type] || { count: 0, bytes: 0 };
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <h2>${type.toUpperCase()}</h2>
        <div class="summary-value">${entry.count}</div>
        <div class="muted">${this.formatBytes(entry.bytes)} transferred</div>
      `;
      this.summaryContainer.appendChild(card);
    });
  }

  renderLogs(logs) {
    if (!logs.length) {
      this.tableBody.innerHTML = '<tr><td colspan="7" class="muted">No data</td></tr>';
      return;
    }
    this.tableBody.innerHTML = '';
    logs.slice().reverse().forEach(entry => {
      const row = document.createElement('tr');
      const ts = new Date(entry.ts || Date.now()).toLocaleString();
      const meta = entry.meta || {};
      row.innerHTML = `
        <td>${ts}</td>
        <td><span class="badge ${entry.type}">${entry.type}</span></td>
        <td>${this.formatBytes(entry.bytes)}</td>
        <td>${meta.transport || meta.profile || '—'}</td>
        <td>${meta.chunkSize ? this.formatBytes(meta.chunkSize) : '—'}</td>
        <td>${meta.handshakeMs ? meta.handshakeMs + ' ms' : '—'}</td>
        <td>${meta.transferMs ? meta.transferMs + ' ms' : '—'}</td>
      `;
      this.tableBody.appendChild(row);
    });
  }

  formatBytes(value) {
    if (!value) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = Number(value);
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    const fixed = size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1);
    return `${fixed} ${units[unit]}`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const dashboard = new StatsDashboard({
    refreshBtn: '#refresh',
    typeFilter: '#type-filter',
    windowSelect: '#window',
    limitSelect: '#limit',
    autoRefreshSelect: '#auto-refresh',
    downloadBtn: '#download',
    updatedLabel: '#updated',
    summaryContainer: '#summary',
    tableBody: '#log-rows',
  });
  dashboard.init();
});
