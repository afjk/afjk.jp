import { normalizeDisplayName } from '../utils/display-name.js';

function validateDisplayName(name) {
  const normalized = normalizeDisplayName(name);
  if (!normalized) {
    return { valid: false, message: '表示名を入力してください。', normalized };
  }
  return { valid: true, normalized };
}

function shouldAutoFocusInput() {
  return !window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function formatRoomLabel(roomCode) {
  const value = String(roomCode || '').trim();
  if (!value) return '';
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}

export class WelcomeDialog {
  constructor({ onStartInRoom, onCreateNewRoom }) {
    this.onStartInRoom = onStartInRoom;
    this.onCreateNewRoom = onCreateNewRoom;
    this.mode = 'first-run';
    this.el = null;
    this.inputEl = null;
    this.errorEl = null;
    this.startButtonEl = null;
    this.roomCode = '';
  }

  createDialogElement() {
    const dialog = document.createElement('div');
    dialog.id = 'welcome-dialog';
    dialog.className = 'welcome-dialog';
    dialog.innerHTML = `
      <div class="welcome-overlay"></div>
      <div class="welcome-content">
        <h1>Scene Syncへようこそ</h1>
        <p class="welcome-description">同じ空間を一緒に編集できる実験的なデモです。</p>

        <p class="welcome-text">近くの人とは、すぐに同じ空間に入れます。<br>
        <span class="welcome-note">※ 同じWi-FiやLANでは、同じルームが使われます。</span></p>

        <p class="welcome-text">別のグループで使いたい場合は、新しいルームを作ってください。<br>
        <span class="welcome-note">URLを共有すれば、離れた場所の人も参加できます。</span></p>

        <p class="welcome-text">まず、表示名を入力してください。</p>

        <div class="welcome-form">
          <label class="form-group">
            <div class="form-label">表示名</div>
            <input type="text" id="welcome-display-name" class="form-input" placeholder="例: sync-san" maxlength="32">
            <div id="welcome-error" class="form-error" style="display: none;"></div>
          </label>
        </div>

        <div class="welcome-actions">
          <button id="welcome-start-room" class="welcome-btn primary">このルームで始める</button>
          <button id="welcome-new-room" class="welcome-btn">新しいルームを作る</button>
        </div>

        <button id="welcome-close" class="welcome-close-btn" style="display: none;">閉じる</button>
      </div>
    `;
    return dialog;
  }

  open(mode = 'first-run', savedDisplayName = '', options = {}) {
    this.mode = mode;
    this.roomCode = options.roomCode || '';

    if (!this.el) {
      this.el = this.createDialogElement();
      document.body.appendChild(this.el);

      this.inputEl = this.el.querySelector('#welcome-display-name');
      this.errorEl = this.el.querySelector('#welcome-error');
      this.startButtonEl = this.el.querySelector('#welcome-start-room');

      this.startButtonEl.addEventListener('click', () => this.handleStartRoom());
      this.el.querySelector('#welcome-new-room').addEventListener('click', () => this.handleNewRoom());
      this.el.querySelector('#welcome-close').addEventListener('click', () => this.close());

      this.inputEl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          this.handleStartRoom();
        }
      });
    }

    this.inputEl.value = normalizeDisplayName(savedDisplayName);
    if (shouldAutoFocusInput()) {
      this.inputEl.focus();
    }
    this.clearError();
    this.updateStartButtonLabel();

    if (mode === 'help') {
      this.el.querySelector('#welcome-close').style.display = 'block';
      this.inputEl.readOnly = false;
    } else {
      this.el.querySelector('#welcome-close').style.display = 'none';
      this.inputEl.readOnly = false;
    }

    this.el.style.display = 'flex';
  }

  updateStartButtonLabel() {
    const roomLabel = formatRoomLabel(this.roomCode);
    this.startButtonEl.textContent = roomLabel
      ? `このルーム（${roomLabel}）に入る`
      : 'このルームで始める';
  }

  close() {
    if (this.inputEl && document.activeElement === this.inputEl) {
      this.inputEl.blur();
    }
    if (this.el) {
      this.el.style.display = 'none';
    }
  }

  clearError() {
    this.errorEl.style.display = 'none';
    this.errorEl.textContent = '';
  }

  showError(message) {
    this.errorEl.textContent = message;
    this.errorEl.style.display = 'block';
  }

  getDisplayName() {
    return normalizeDisplayName(this.inputEl.value);
  }

  handleStartRoom() {
    const validation = validateDisplayName(this.getDisplayName());

    if (!validation.valid) {
      this.showError(validation.message);
      return;
    }

    this.close();
    this.onStartInRoom(validation.normalized);
  }

  handleNewRoom() {
    const validation = validateDisplayName(this.getDisplayName());

    if (!validation.valid) {
      this.showError(validation.message);
      return;
    }

    this.close();
    this.onCreateNewRoom(validation.normalized);
  }
}

export function createWelcomeDialog({ onStartInRoom, onCreateNewRoom }) {
  return new WelcomeDialog({ onStartInRoom, onCreateNewRoom });
}

