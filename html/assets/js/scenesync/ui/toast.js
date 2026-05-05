let toastTimer = null;

export function showToast(input, duration = 2500) {
  const el = document.getElementById('toast');
  if (!el) return;

  const message = typeof input === 'string'
    ? input
    : input?.message || String(input);

  el.textContent = message;
  el.classList.add('show');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, duration);
}
