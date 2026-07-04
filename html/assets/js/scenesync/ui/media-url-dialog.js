import { detectStereoMediaFromName, stereoMediaLabel } from '../loaders/stereo-media.js';

/**
 * メディアURL登録ダイアログ。
 *
 * 動画 / 画像 URL と表示形式（2D / 3D SBS / 3D TB / VR180 系）を指定して
 * シーンに追加する。形式が「自動判定」の場合は URL のファイル名から推定し、
 * 判定結果をダイアログ内にライブ表示する。
 *
 * 期待する DOM（index.html 側で定義）:
 * - #media-url-dialog（.pairing-dialog モーダル）
 * - #media-url-input, #media-url-format, #media-url-hint
 * - #media-url-add-btn, #media-url-cancel-btn
 */
export function initMediaUrlDialog({ onSubmit, showToast } = {}) {
  const dialog = document.getElementById('media-url-dialog');
  const input = document.getElementById('media-url-input');
  const formatSelect = document.getElementById('media-url-format');
  const hint = document.getElementById('media-url-hint');
  const addBtn = document.getElementById('media-url-add-btn');
  const cancelBtn = document.getElementById('media-url-cancel-btn');

  if (!dialog || !input || !formatSelect || !addBtn) {
    return { open: () => {}, close: () => {}, dispose: () => {} };
  }

  function parseFormatValue(value) {
    if (!value || value === 'auto') return null;
    const [projection, stereoLayout] = value.split(':');
    return { projection, stereoLayout };
  }

  function updateHint() {
    if (!hint) return;
    const value = formatSelect.value;
    if (value !== 'auto') {
      const format = parseFormatValue(value);
      hint.textContent = format ? `形式: ${stereoMediaLabel(format)}` : '';
      return;
    }
    const url = input.value.trim();
    if (!url) {
      hint.textContent = '自動判定: ファイル名の vr180 / sbs / tb 等から推定します';
      return;
    }
    const detected = detectStereoMediaFromName(url);
    hint.textContent = detected
      ? `自動判定: ${stereoMediaLabel(detected)}`
      : '自動判定: 2D（立体視ヒントなし）';
  }

  function close() {
    dialog.style.display = 'none';
  }

  function open() {
    input.value = '';
    formatSelect.value = 'auto';
    updateHint();
    dialog.style.display = 'flex';
    requestAnimationFrame(() => input.focus());
  }

  function submit() {
    const url = input.value.trim();
    if (!/^https?:\/\//i.test(url)) {
      showToast?.('http(s) で始まる URL を入力してください');
      input.focus();
      return;
    }
    const mediaFormat = parseFormatValue(formatSelect.value);
    close();
    Promise.resolve(onSubmit?.(url, mediaFormat)).catch((error) => {
      console.warn('[media-url-dialog] import failed:', error);
    });
  }

  const onInput = () => updateHint();
  const onKeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  const onBackdropClick = (event) => {
    if (event.target === dialog) close();
  };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);
  formatSelect.addEventListener('change', onInput);
  addBtn.addEventListener('click', submit);
  cancelBtn?.addEventListener('click', close);
  dialog.addEventListener('mousedown', onBackdropClick);

  function dispose() {
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeydown);
    formatSelect.removeEventListener('change', onInput);
    addBtn.removeEventListener('click', submit);
    cancelBtn?.removeEventListener('click', close);
    dialog.removeEventListener('mousedown', onBackdropClick);
  }

  return { open, close, dispose };
}
