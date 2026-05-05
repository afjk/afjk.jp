export async function importTextUrl(url, ctx) {
  let response;
  try {
    response = await fetch(url, { mode: 'cors' });
  } catch (err) {
    ctx.showToast({
      type: 'error',
      message: `テキストURLのフェッチに失敗しました: ${err?.message || 'Failed to fetch'}`,
    });
    throw err;
  }

  if (!response.ok) {
    const err = new Error(`HTTP ${response.status}`);
    ctx.showToast({
      type: 'error',
      message: `テキストURLの読み込みに失敗しました: ${err.message}`,
    });
    throw err;
  }

  const text = await response.text();

  const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'remote.txt');

  if (typeof ctx.textImporter !== 'function') {
    const err = new Error('textImporter is not configured');
    ctx.showToast({
      type: 'error',
      message: 'テキストURL importer が設定されていません',
    });
    throw err;
  }

  await ctx.textImporter(text, filename);

  return { objectId: null, payload: null };
}
