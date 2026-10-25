// Numeric placement deliberately has no dependency on the renderer or camera.
export function readTextAddInput(text, coordinates) {
  const value = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!value) throw new Error('テキストを入力してください。');
  if (value.length > 5000) throw new Error('テキストは5000文字以内で入力してください。');
  if (coordinates.length !== 3 || coordinates.some(value => String(value).trim() === '' || !Number.isFinite(Number(value)))) {
    throw new Error('X・Y・Zに有限の数値を入力してください。');
  }
  return { text: value, position: coordinates.map(Number) };
}

export function initTextAddDialog({ canAdd, onAdd, showToast, onStateChange, onOpen, onClose, root = document }) {
  const dialog = root.getElementById('text-add-dialog');
  const form = root.getElementById('text-add-form');
  const text = root.getElementById('text-add-content');
  const coordinates = ['x', 'y', 'z'].map(axis => root.getElementById(`text-add-${axis}`));
  const openButton = root.getElementById('add-text-btn');
  const addButton = root.getElementById('text-add-submit');
  const cancelButton = root.getElementById('text-add-cancel');
  const error = root.getElementById('text-add-error');
  // Older cached shells may not include this optional dialog yet.
  if ([dialog, form, text, ...coordinates, openButton, addButton, cancelButton, error].some(element => !element)) return;
  let pending = false;
  function refresh() {
    openButton.disabled = pending || !canAdd();
    addButton.disabled = pending || !canAdd();
    cancelButton.disabled = pending;
    form.setAttribute('aria-busy', String(pending));
  }
  openButton.addEventListener('click', () => {
    if (pending || !canAdd()) return;
    form.reset();
    error.hidden = true;
    onOpen?.();
    dialog.showModal();
    text.focus();
  });
  dialog.addEventListener('close', () => onClose?.());
  cancelButton.addEventListener('click', () => { if (!pending) dialog.close(); });
  // Buttons in the modal must not trigger the editor's Delete/Undo shortcuts.
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!dialog.open || pending) return;
    error.hidden = true;
    try {
      if (!canAdd()) throw new Error('編集モードでシーンの同期が完了してから追加してください。');
      const input = readTextAddInput(text.value, coordinates.map(field => field.value));
      pending = true;
      refresh();
      await onAdd(input);
      dialog.close();
      showToast?.('テキストを追加しました');
    } catch (failure) {
      error.textContent = failure.message || 'テキストを追加できませんでした。';
      error.hidden = false;
    } finally {
      pending = false;
      refresh();
    }
  });
  onStateChange?.(refresh);
  refresh();
}
