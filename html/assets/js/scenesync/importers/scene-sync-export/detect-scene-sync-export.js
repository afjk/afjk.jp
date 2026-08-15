export function isZipFile(file) {
  if (!file) return false;
  const name = (file.name || '').toLowerCase();
  return name.endsWith('.zip');
}

export function isSingleHtmlFile(file) {
  if (!file) return false;
  const name = (file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  return name.endsWith('.html') || name.endsWith('.htm') || type === 'text/html';
}
