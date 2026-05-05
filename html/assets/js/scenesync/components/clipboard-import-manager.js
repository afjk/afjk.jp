// ── clipboard-import-manager.js ───────────────────────────
// クリップボード貼り付けの管理
// ──────────────────────────────────────────────────────────

import {
  parseClipboardDataTransfer,
  parseNavigatorClipboardItems,
} from '../loaders/clipboard-parser.js';

function defaultIsEditingTarget(target) {
  const el = target instanceof Element ? target : null;
  if (!el) return false;

  if (el.closest('input, textarea, select, [contenteditable="true"]')) return true;
  if (el.closest('.cm-editor, .monaco-editor')) return true;
  if (el.closest('#scene-json-editor, #selected-object-json-editor, #dsl-editor')) return true;

  return false;
}

export class ClipboardImportManager {
  constructor(options) {
    const {
      container = document,
      getDefaultPosition,
      getPastePosition,
      handleFile,
      handleUrl,
      handleText,
      showToast,
      isEditingTarget = defaultIsEditingTarget,
    } = options || {};

    this.container = container;
    this.getDefaultPosition = getDefaultPosition || (() => null);
    this.getPastePosition = getPastePosition || (() => null);
    this.handleFile = handleFile || (() => Promise.resolve(null));
    this.handleUrl = handleUrl || (() => Promise.resolve(null));
    this.handleText = handleText || (() => Promise.resolve(null));
    this.showToast = showToast || (() => {});
    this.isEditingTarget = isEditingTarget;

    this._boundPaste = this._onPaste.bind(this);
    this._isDisposed = false;

    this._register();
  }

  _register() {
    this.container?.addEventListener('paste', this._boundPaste);
  }

  _resolvePosition() {
    return this.getPastePosition?.() || this.getDefaultPosition?.() || null;
  }

  async _onPaste(event) {
    // 編集対象中は無視
    if (this.isEditingTarget?.(event.target)) {
      return;
    }

    const payload = parseClipboardDataTransfer(event.clipboardData);
    if (!payload || payload.kind === 'empty') {
      return;
    }

    event.preventDefault();
    await this.importPayload(payload, this._resolvePosition());
  }

  async importPayload(payload, position) {
    switch (payload.kind) {
      case 'file':
        try {
          await this.handleFile(payload.file, position);
        } catch (err) {
          console.warn('[clipboard] file import failed:', err);
          this.showToast?.(err?.message || 'ファイルの読み込みに失敗しました');
        }
        break;

      case 'url':
        try {
          this.showToast?.('クリップボードからURLを読み込みます');
          await this.handleUrl(payload.url, position);
        } catch (err) {
          console.warn('[clipboard] url import failed:', err);
          this.showToast?.(err?.message || 'URLの追加に失敗しました');
        }
        break;

      case 'text':
        try {
          this.showToast?.('クリップボードからテキストを追加しました');
          await this.handleText(payload.text, position, payload.filename);
        } catch (err) {
          console.warn('[clipboard] text import failed:', err);
          this.showToast?.(err?.message || 'テキストの読み込みに失敗しました');
        }
        break;

      default:
        this.showToast?.('このクリップボード内容は読み込めません');
    }
  }

  // navigator.clipboard fallback (for future context menu)
  async pasteFromNavigatorClipboard(position) {
    if (navigator.clipboard?.read) {
      try {
        const items = await navigator.clipboard.read();
        const payload = await parseNavigatorClipboardItems(items);
        return await this.importPayload(payload, position || this._resolvePosition());
      } catch (err) {
        console.warn('[clipboard] navigator.clipboard.read failed:', err);
      }
    }

    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        const isUrl = text.trim().startsWith('http://') || text.trim().startsWith('https://');
        const payload = isUrl
          ? { kind: 'url', url: text.trim() }
          : { kind: 'text', text, filename: 'clipboard.txt' };
        return await this.importPayload(payload, position || this._resolvePosition());
      } catch (err) {
        console.warn('[clipboard] navigator.clipboard.readText failed:', err);
      }
    }

    this.showToast?.('クリップボードを読み取れません');
    return null;
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.container?.removeEventListener('paste', this._boundPaste);
  }
}
