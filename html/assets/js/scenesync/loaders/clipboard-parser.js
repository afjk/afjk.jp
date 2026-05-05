// ── clipboard-parser.js ──────────────────────────────────────
// クリップボードペイロードの解析
// ───────────────────────────────────────────────────────────

const MAX_TEXT_LENGTH = 20000;

function isLikelyHttpUrl(text) {
  if (!text) return false;
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function extractHtmlUrls(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // img[src] を優先
  const img = doc.querySelector('img[src]');
  if (img?.src) {
    return img.src;
  }

  // a[href] を次に試す
  const link = doc.querySelector('a[href]');
  if (link?.href) {
    return link.href;
  }

  return null;
}

// ClipboardEvent.clipboardData を解析
export function parseClipboardDataTransfer(dataTransfer) {
  if (!dataTransfer) {
    return { kind: 'empty' };
  }

  const items = Array.from(dataTransfer.items || []);

  // 優先順位1: 画像ファイル
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        return { kind: 'file', file };
      }
    }
  }

  // 優先順位2: その他ファイル
  if (dataTransfer.files?.length > 0) {
    return { kind: 'file', file: dataTransfer.files[0] };
  }

  // 優先順位3: text/uri-list
  const uriList = dataTransfer.getData('text/uri-list');
  if (uriList) {
    const urls = uriList.split('\n').filter(line => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('#');
    });
    if (urls.length > 0) {
      return { kind: 'url', url: urls[0] };
    }
  }

  // 優先順位4: text/html から URL 抽出
  const html = dataTransfer.getData('text/html');
  if (html) {
    const url = extractHtmlUrls(html);
    if (url) {
      return { kind: 'url', url };
    }
  }

  // 優先順位5: text/plain がURL
  const plainText = dataTransfer.getData('text/plain');
  if (plainText) {
    const trimmed = plainText.trim();
    if (isLikelyHttpUrl(trimmed)) {
      return { kind: 'url', url: trimmed };
    }

    // 優先順位6: 通常テキスト
    const text = plainText.slice(0, MAX_TEXT_LENGTH);
    if (text) {
      return { kind: 'text', text, filename: 'clipboard.txt' };
    }
  }

  return { kind: 'empty' };
}

// navigator.clipboard.read() 対応
export async function parseNavigatorClipboardItems(items) {
  if (!items) {
    return { kind: 'empty' };
  }

  for (const item of items) {
    // 画像ファイル優先
    if (item.types.includes('image/png') || item.types.includes('image/jpeg') || item.types.includes('image/webp')) {
      try {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const file = new File([blob], 'clipboard-image', { type });
            return { kind: 'file', file };
          }
        }
      } catch (err) {
        console.warn('[clipboard] image file extraction failed:', err);
      }
    }
  }

  // テキスト抽出 (text/plain, text/uri-list, text/html)
  for (const item of items) {
    if (item.types.includes('text/uri-list')) {
      try {
        const blob = await item.getType('text/uri-list');
        const text = await blob.text();
        const urls = text.split('\n').filter(line => {
          const trimmed = line.trim();
          return trimmed && !trimmed.startsWith('#');
        });
        if (urls.length > 0) {
          return { kind: 'url', url: urls[0] };
        }
      } catch (err) {
        console.warn('[clipboard] uri-list extraction failed:', err);
      }
    }

    if (item.types.includes('text/html')) {
      try {
        const blob = await item.getType('text/html');
        const html = await blob.text();
        const url = extractHtmlUrls(html);
        if (url) {
          return { kind: 'url', url };
        }
      } catch (err) {
        console.warn('[clipboard] html extraction failed:', err);
      }
    }

    if (item.types.includes('text/plain')) {
      try {
        const blob = await item.getType('text/plain');
        const text = await blob.text();
        const trimmed = text.trim();
        if (isLikelyHttpUrl(trimmed)) {
          return { kind: 'url', url: trimmed };
        }

        const sliced = text.slice(0, MAX_TEXT_LENGTH);
        if (sliced) {
          return { kind: 'text', text: sliced, filename: 'clipboard.txt' };
        }
      } catch (err) {
        console.warn('[clipboard] text extraction failed:', err);
      }
    }
  }

  return { kind: 'empty' };
}
