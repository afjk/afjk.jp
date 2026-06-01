const API_BASE_URL = `${window.location.origin}/presence/api/ai`;
const STORAGE_KEYS = {
  roomId: 'scenesync.devtool.roomId',
  sessionId: 'scenesync.devtool.sessionId',
  expiresAt: 'scenesync.devtool.expiresAt',
  history: 'scenesync.devtool.history',
};
const MAX_HISTORY = 8;
const DEFAULT_PAYLOAD = {
  kind: 'scene-add',
  objectId: 'dev-cube-1',
  name: 'Dev Cube',
  position: [0, 0.5, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
  asset: {
    type: 'primitive',
    primitive: 'box',
    color: '#ff8800',
  },
};

const elements = {
  roomId: document.querySelector('#roomId'),
  sessionId: document.querySelector('#sessionId'),
  pairCode: document.querySelector('#pairCode'),
  sessionStatus: document.querySelector('#sessionStatus'),
  sessionMeta: document.querySelector('#sessionMeta'),
  payloadInput: document.querySelector('#payloadInput'),
  payloadInspector: document.querySelector('#payloadInspector'),
  previewOutput: document.querySelector('#previewOutput'),
  validationOutput: document.querySelector('#validationOutput'),
  responseOutput: document.querySelector('#responseOutput'),
  resolvedRoute: document.querySelector('#resolvedRoute'),
  redeemButton: document.querySelector('#redeemButton'),
  formatButton: document.querySelector('#formatButton'),
  sendButton: document.querySelector('#sendButton'),
  snapshotButton: document.querySelector('#snapshotButton'),
  clearHistoryButton: document.querySelector('#clearHistoryButton'),
  historyList: document.querySelector('#historyList'),
  editorModeButtons: document.querySelectorAll('[data-editor-mode]'),
};

function loadJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function getHistory() {
  return loadJson(STORAGE_KEYS.history, []);
}

function setHistory(history) {
  saveJson(STORAGE_KEYS.history, history.slice(0, MAX_HISTORY));
}

function saveSession() {
  window.localStorage.setItem(STORAGE_KEYS.roomId, elements.roomId.value.trim());
  window.localStorage.setItem(STORAGE_KEYS.sessionId, elements.sessionId.value.trim());
}

function setStoredExpiry(expiresAt) {
  if (expiresAt) {
    window.localStorage.setItem(STORAGE_KEYS.expiresAt, String(expiresAt));
  } else {
    window.localStorage.removeItem(STORAGE_KEYS.expiresAt);
  }
}

function hydrateSession() {
  const params = new URLSearchParams(window.location.search);
  elements.roomId.value = params.get('room') || window.localStorage.getItem(STORAGE_KEYS.roomId) || '';
  elements.sessionId.value = params.get('sessionId') || window.localStorage.getItem(STORAGE_KEYS.sessionId) || '';
  updateSessionStatus();
}

function hydratePayload() {
  elements.payloadInput.value = JSON.stringify(DEFAULT_PAYLOAD, null, 2);
  syncPayloadState();
}

function updateSessionStatus() {
  const roomId = elements.roomId.value.trim();
  const sessionId = elements.sessionId.value.trim();
  const expiresAt = Number(window.localStorage.getItem(STORAGE_KEYS.expiresAt) || 0);

  if (!roomId || !sessionId) {
    elements.sessionStatus.textContent = 'No stored session';
    elements.sessionMeta.textContent = 'Redeem a 6-digit code or paste room and session values.';
    return;
  }

  elements.sessionStatus.textContent = 'Ready';
  elements.sessionMeta.textContent = expiresAt > 0
    ? `Room ${roomId} • expires ${new Date(expiresAt).toLocaleString()}`
    : `Room ${roomId} • expiry unknown`;
}

function renderValidation(errors) {
  if (!errors.length) {
    elements.validationOutput.textContent = 'No validation errors.';
    elements.validationOutput.classList.remove('console-error');
    elements.validationOutput.classList.add('console-warning');
    return;
  }

  elements.validationOutput.textContent = errors.join('\n');
  elements.validationOutput.classList.remove('console-warning');
  elements.validationOutput.classList.add('console-error');
}

function formatLabel(value) {
  const raw = String(value ?? 'Value')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Value';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function makePathAttribute(path) {
  return escapeHtml(JSON.stringify(path));
}

function getObjectMeta(value) {
  if (!isPlainObject(value)) return '';
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : '';
  const objectId = typeof value.objectId === 'string' && value.objectId.trim() ? value.objectId.trim() : '';
  if (name && objectId) return `${name} / ${objectId}`;
  return name || objectId;
}

function getNumericConfig(path, value) {
  const key = String(path[path.length - 1] ?? '').toLowerCase();
  const parent = String(path[path.length - 2] ?? '').toLowerCase();
  const absValue = Math.abs(Number(value) || 0);
  let min = -100;
  let max = 100;
  let step = 0.01;

  if (['position'].includes(parent) || ['x', 'y', 'z'].includes(key)) {
    min = -20;
    max = 20;
  } else if (['scale'].includes(parent) || key.includes('scale')) {
    min = 0;
    max = 10;
  } else if (['rotation'].includes(parent) || key.includes('rotation')) {
    min = -1;
    max = 1;
  } else if (['opacity', 'alpha', 'volume', 'weight', 'intensity'].some((token) => key.includes(token))) {
    min = 0;
    max = 1;
    step = 0.001;
  }

  if (absValue > Math.max(Math.abs(min), Math.abs(max))) {
    const range = Math.ceil(absValue * 1.25);
    min = Math.min(min, -range);
    max = Math.max(max, range);
  }

  return { min, max, step };
}

function renderPrimitiveControl(label, value, path) {
  const pathAttribute = makePathAttribute(path);
  const labelText = escapeHtml(formatLabel(label));

  if (typeof value === 'boolean') {
    return `
      <label class="inspector-row inspector-row-boolean">
        <span>${labelText}</span>
        <input type="checkbox" ${value ? 'checked' : ''} data-inspector-type="boolean" data-inspector-path="${pathAttribute}">
      </label>
    `;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const { min, max, step } = getNumericConfig(path, value);
    const safeValue = escapeHtml(String(value));
    return `
      <label class="inspector-row inspector-row-number">
        <span>${labelText}</span>
        <div class="number-field">
          <input type="range" min="${min}" max="${max}" step="${step}" value="${safeValue}" data-inspector-type="number" data-inspector-path="${pathAttribute}">
          <input type="number" step="${step}" value="${safeValue}" data-inspector-type="number" data-inspector-path="${pathAttribute}">
        </div>
      </label>
    `;
  }

  if (typeof value === 'string') {
    const safeValue = escapeHtml(value);
    const isColor = /^#[0-9a-f]{6}$/i.test(value);
    return `
      <label class="inspector-row inspector-row-text">
        <span>${labelText}</span>
        <div class="${isColor ? 'text-field text-field-color' : 'text-field'}">
          ${isColor ? `<input type="color" value="${safeValue}" data-inspector-type="string" data-inspector-path="${pathAttribute}">` : ''}
          <input type="text" value="${safeValue}" spellcheck="false" data-inspector-type="string" data-inspector-path="${pathAttribute}">
        </div>
      </label>
    `;
  }

  const jsonValue = value === null ? 'null' : JSON.stringify(value);
  return `
    <label class="inspector-row inspector-row-text">
      <span>${labelText}</span>
      <input type="text" value="${escapeHtml(jsonValue)}" spellcheck="false" data-inspector-type="json" data-inspector-path="${pathAttribute}">
    </label>
  `;
}

function renderInspectorValue(value, path = [], label = 'Payload') {
  if (Array.isArray(value)) {
    const rows = value.map((item, index) => renderInspectorValue(item, [...path, index], `[${index}]`)).join('');
    return `
      <fieldset class="inspector-group">
        <legend>${escapeHtml(formatLabel(label))}</legend>
        <div class="inspector-children">${rows || '<p class="inspector-empty">[]</p>'}</div>
      </fieldset>
    `;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    const meta = getObjectMeta(value);
    const rows = entries.map(([key, item]) => renderInspectorValue(item, [...path, key], key)).join('');
    return `
      <fieldset class="inspector-group">
        <legend>
          <span>${escapeHtml(formatLabel(label))}</span>
          ${meta ? `<small>${escapeHtml(meta)}</small>` : ''}
        </legend>
        <div class="inspector-children">${rows || '<p class="inspector-empty">{}</p>'}</div>
      </fieldset>
    `;
  }

  return renderPrimitiveControl(label, value, path);
}

function renderInspector(parsed) {
  if (!parsed) {
    elements.payloadInspector.innerHTML = '<p class="inspector-empty">Preview unavailable.</p>';
    return;
  }

  elements.payloadInspector.innerHTML = renderInspectorValue(parsed);
}

function setEditorMode(mode) {
  const isJson = mode === 'json';
  elements.payloadInput.classList.toggle('is-hidden', !isJson);
  elements.payloadInspector.classList.toggle('is-hidden', isJson);
  elements.editorModeButtons.forEach((button) => {
    const isActive = button.dataset.editorMode === mode;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });
}

function validatePayload(value) {
  const errors = [];
  let parsed = null;
  let route = 'broadcast';

  if (!value.trim()) {
    errors.push('Payload JSON is required.');
    return { errors, parsed, route };
  }

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    errors.push(`Invalid JSON: ${error.message}`);
    return { errors, parsed, route };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('Payload must be a JSON object.');
    return { errors, parsed, route };
  }

  if (parsed.kind === 'ai-command') {
    route = 'ai-command';
    if (typeof parsed.action !== 'string' || !parsed.action.trim()) {
      errors.push('ai-command requires action.');
    }
    if (parsed.params !== undefined && (typeof parsed.params !== 'object' || parsed.params === null || Array.isArray(parsed.params))) {
      errors.push('ai-command params must be an object when provided.');
    }
    if (parsed.action === 'focusObject' && typeof parsed.params?.objectId !== 'string') {
      errors.push('focusObject requires params.objectId.');
    }
    if (
      ['uploadGlbFromUrl', 'addImageFromUrl', 'addVideoFromUrl', 'addTextFromUrl', 'setSkyboxFromImageUrl']
        .includes(parsed.action)
      && typeof parsed.params?.url !== 'string'
    ) {
      errors.push(`${parsed.action} requires params.url.`);
    }
  } else {
    if (typeof parsed.kind !== 'string' || !parsed.kind.trim()) {
      errors.push('payload.kind is required.');
    }
    if (parsed.kind === 'scene-add' && parsed.asset?.type === 'primitive') {
      if (typeof parsed.asset.primitive !== 'string' || !parsed.asset.primitive) {
        errors.push('primitive scene-add requires payload.asset.primitive.');
      }
      if (typeof parsed.asset.color !== 'string' || !parsed.asset.color) {
        errors.push('primitive scene-add requires payload.asset.color.');
      }
    }
  }

  return { errors, parsed, route };
}

function syncPayloadState(options = {}) {
  const { renderInspectorView = true } = options;
  const { errors, parsed, route } = validatePayload(elements.payloadInput.value);
  renderValidation(errors);
  elements.resolvedRoute.textContent = route;
  elements.previewOutput.textContent = parsed ? JSON.stringify(parsed, null, 2) : 'Preview unavailable.';
  elements.sendButton.disabled = errors.length > 0;
  if (renderInspectorView) {
    renderInspector(parsed);
  }
  return { errors, parsed, route };
}

function setValueAtPath(root, path, value) {
  let target = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    target = target[path[index]];
  }
  target[path[path.length - 1]] = value;
}

function mirrorInspectorControls(path, value) {
  const serializedPath = JSON.stringify(path);
  elements.payloadInspector.querySelectorAll('[data-inspector-path]').forEach((control) => {
    if (control.dataset.inspectorPath !== serializedPath) return;
    if (control.type === 'checkbox') {
      control.checked = Boolean(value);
    } else {
      control.value = String(value);
    }
  });
}

function readInspectorValue(control) {
  if (control.dataset.inspectorType === 'boolean') {
    return control.checked;
  }
  if (control.dataset.inspectorType === 'number') {
    if (['', '-', '.', '-.'].includes(control.value)) return undefined;
    const number = Number(control.value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (control.dataset.inspectorType === 'json') {
    try {
      return JSON.parse(control.value);
    } catch {
      return undefined;
    }
  }
  return control.value;
}

function handleInspectorInput(event) {
  const control = event.target.closest('[data-inspector-path]');
  if (!control) return;

  const path = JSON.parse(control.dataset.inspectorPath);
  const value = readInspectorValue(control);
  if (value === undefined) return;

  const { parsed } = validatePayload(elements.payloadInput.value);
  if (!parsed) return;

  setValueAtPath(parsed, path, value);
  elements.payloadInput.value = JSON.stringify(parsed, null, 2);
  mirrorInspectorControls(path, value);
  syncPayloadState({ renderInspectorView: false });
}

function renderResult(target, value, isError = false) {
  target.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  target.classList.toggle('console-error', isError);
}

async function postJson(path, body) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

function storeHistoryEntry(route, payload) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    route,
    roomId: elements.roomId.value.trim(),
    sessionId: elements.sessionId.value.trim(),
    payload,
    createdAt: new Date().toISOString(),
  };
  const history = [entry, ...getHistory()];
  setHistory(history);
  renderHistory();
}

function renderHistory() {
  const history = getHistory();
  if (!history.length) {
    elements.historyList.innerHTML = '<p class="history-empty">No payload history yet.</p>';
    return;
  }

  elements.historyList.innerHTML = history.map((entry) => {
    const preview = JSON.stringify(entry.payload);
    return `
      <article class="history-item">
        <div>
          <p><strong>${escapeHtml(entry.route)}</strong></p>
          <p class="meta">${escapeHtml(entry.roomId)} • ${escapeHtml(new Date(entry.createdAt).toLocaleString())}</p>
          <p>${escapeHtml(preview.length > 140 ? `${preview.slice(0, 140)}...` : preview)}</p>
        </div>
        <div class="history-actions">
          <button type="button" data-history-action="reuse" data-history-id="${escapeHtml(entry.id)}">Reuse</button>
          <button type="button" data-history-action="send" data-history-id="${escapeHtml(entry.id)}">Send Again</button>
        </div>
      </article>
    `;
  }).join('');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function requireRoomAndSession() {
  const roomId = elements.roomId.value.trim();
  const sessionId = elements.sessionId.value.trim();
  const errors = [];
  if (!roomId) errors.push('roomId is required.');
  if (!sessionId) errors.push('sessionId is required.');
  if (errors.length) {
    renderValidation(errors);
    throw new Error('Missing roomId or sessionId.');
  }
  return { roomId, sessionId };
}

async function handleRedeem() {
  const code = elements.pairCode.value.trim();
  if (!/^\d{6}$/.test(code)) {
    renderValidation(['Pairing code must be a 6-digit string.']);
    return;
  }

  try {
    renderResult(elements.responseOutput, 'Redeeming pairing code...');
    const result = await postJson('/link/redeem', { code });
    elements.roomId.value = result.roomId || '';
    elements.sessionId.value = result.sessionId || '';
    saveSession();
    setStoredExpiry(result.expiresAt || null);
    updateSessionStatus();
    renderResult(elements.responseOutput, result);
  } catch (error) {
    renderResult(elements.responseOutput, error.message, true);
  }
}

async function handleSend(entryOverride = null) {
  try {
    const { roomId, sessionId } = requireRoomAndSession();
    const payloadState = entryOverride
      ? validatePayload(JSON.stringify(entryOverride.payload))
      : syncPayloadState();
    if (payloadState.errors.length) {
      return;
    }

    saveSession();
    const { parsed, route } = payloadState;
    renderResult(elements.responseOutput, 'Sending request...');

    const result = route === 'ai-command'
      ? await postJson(`/room/${encodeURIComponent(roomId)}/ai-command`, {
        sessionId,
        action: parsed.action,
        params: parsed.params || {},
        requestId: parsed.requestId,
        targetPeerId: parsed.targetPeerId,
      })
      : await postJson(`/room/${encodeURIComponent(roomId)}/broadcast`, {
        sessionId,
        payload: parsed,
      });

    if (!entryOverride) {
      storeHistoryEntry(route, parsed);
    }
    renderResult(elements.responseOutput, result);
  } catch (error) {
    renderResult(elements.responseOutput, error.message, true);
  }
}

async function handleSnapshot() {
  try {
    const { roomId, sessionId } = requireRoomAndSession();
    saveSession();
    renderResult(elements.responseOutput, 'Fetching scene snapshot...');
    const result = await postJson(`/room/${encodeURIComponent(roomId)}/scene`, { sessionId });
    renderResult(elements.responseOutput, result);
  } catch (error) {
    renderResult(elements.responseOutput, error.message, true);
  }
}

function reuseHistoryEntry(entry) {
  elements.roomId.value = entry.roomId || '';
  elements.sessionId.value = entry.sessionId || '';
  elements.payloadInput.value = JSON.stringify(entry.payload, null, 2);
  saveSession();
  updateSessionStatus();
  syncPayloadState();
}

function bindEvents() {
  elements.roomId.addEventListener('input', () => {
    saveSession();
    updateSessionStatus();
  });
  elements.sessionId.addEventListener('input', () => {
    saveSession();
    updateSessionStatus();
  });
  elements.payloadInput.addEventListener('input', syncPayloadState);
  elements.payloadInspector.addEventListener('input', handleInspectorInput);
  elements.payloadInspector.addEventListener('change', handleInspectorInput);
  elements.editorModeButtons.forEach((button) => {
    button.addEventListener('click', () => setEditorMode(button.dataset.editorMode));
  });
  elements.redeemButton.addEventListener('click', handleRedeem);
  elements.formatButton.addEventListener('click', () => {
    const { parsed } = syncPayloadState();
    if (parsed) {
      elements.payloadInput.value = JSON.stringify(parsed, null, 2);
      syncPayloadState();
    }
  });
  elements.sendButton.addEventListener('click', () => handleSend());
  elements.snapshotButton.addEventListener('click', handleSnapshot);
  elements.clearHistoryButton.addEventListener('click', () => {
    setHistory([]);
    renderHistory();
  });
  elements.historyList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-history-id]');
    if (!button) return;

    const history = getHistory();
    const entry = history.find((item) => item.id === button.dataset.historyId);
    if (!entry) return;

    if (button.dataset.historyAction === 'reuse') {
      reuseHistoryEntry(entry);
      return;
    }

    reuseHistoryEntry(entry);
    await handleSend(entry);
  });
}

hydrateSession();
hydratePayload();
renderHistory();
bindEvents();
