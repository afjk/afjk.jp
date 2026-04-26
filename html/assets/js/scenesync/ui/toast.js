let toastTimer = null;

export function showToast(message, duration = 2500) {
  const el = document.getElementById('toast');
  if (!el) return;

  el.textContent = message;
  el.classList.add('show');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, duration);
}
