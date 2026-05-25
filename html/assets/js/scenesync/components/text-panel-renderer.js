// ── text-panel-renderer.js ──────────────────────────────────────
// Text Panel v2 renderer (plain text / Markdown, scroll, clipping)
// 安全性対応：ctx.font設定、character wrap、overflow判定、scroll非奪取
// ───────────────────────────────────────────────────────────────

export const DEFAULT_TEXT_LAYOUT = {
  version: 1,
  width: 2.4,
  height: 1.6,
  padding: 0.12,
  lineHeight: 1.35,
  mode: 'scroll',
};

export const DEFAULT_TEXT_SCROLL = {
  y: 0,
};

export function normalizeTextAsset(asset, info = {}) {
  const source = asset && typeof asset === 'object' ? asset : {};

  const layoutSource =
    source.layout && typeof source.layout === 'object'
      ? source.layout
      : {};
  const scrollSource =
    source.scroll && typeof source.scroll === 'object'
      ? source.scroll
      : {};
  const fontSize = Number(source.fontSize);

  return {
    type: 'text',
    source: source.source || 'inline',
    ...(source.url ? { url: source.url } : {}),
    text: typeof source.text === 'string' ? source.text : '',
    format: source.format === 'markdown' ? 'markdown' : 'plain',
    fontFamily: source.fontFamily || 'system-sans',
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 32,
    fontWeight: source.fontWeight || 'normal',
    fontStyle: source.fontStyle || 'normal',
    color: source.color || '#ffffff',
    backgroundColor: source.backgroundColor || 'rgba(0,0,0,0.65)',
    align: ['left', 'center', 'right'].includes(source.align)
      ? source.align
      : 'left',
    layout: {
      ...DEFAULT_TEXT_LAYOUT,
      ...layoutSource,
    },
    scroll: {
      ...DEFAULT_TEXT_SCROLL,
      ...scrollSource,
    },
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setCanvasFont(ctx, style) {
  const fontStyle = style.fontStyle || 'normal';
  const fontWeight = style.fontWeight || 'normal';
  const fontSize = Number.isFinite(style.fontSize) ? style.fontSize : 32;
  const fontFamily = style.fontFamily || 'system-sans';
  const resolvedFamily =
    fontFamily === 'system-sans'
      ? 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      : fontFamily === 'monospace'
      ? '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
      : fontFamily;

  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${resolvedFamily}`;
}

function wrapLongToken(ctx, token, maxWidth) {
  const lines = [];
  let current = '';

  for (const char of Array.from(token)) {
    const next = current + char;
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push(current);
      current = char;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function wrapPlainText(ctx, text, maxWidth, fontSizePx, fontFamily, fontWeight, fontStyle) {
  const lines = [];
  const paragraphs = text.split(/\n/);

  for (const para of paragraphs) {
    if (!para.trim()) {
      lines.push({ text: '', type: 'blank', fontSize: fontSizePx });
      continue;
    }

    let currentLine = '';
    const words = para.split(/(\s+)/);

    for (const word of words) {
      if (!word) continue;

      const testLine = currentLine + word;
      const metrics = ctx.measureText(testLine);

      if (metrics.width <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine.trim()) {
          lines.push({
            text: currentLine.trimEnd(),
            type: 'paragraph',
            fontSize: fontSizePx,
            fontFamily,
            fontWeight,
            fontStyle,
          });
        }

        // Word が maxWidth を超える場合は character wrap
        if (ctx.measureText(word).width > maxWidth) {
          const wrappedWords = wrapLongToken(ctx, word, maxWidth);
          for (const wrappedWord of wrappedWords) {
            lines.push({
              text: wrappedWord,
              type: 'paragraph',
              fontSize: fontSizePx,
              fontFamily,
              fontWeight,
              fontStyle,
            });
          }
          currentLine = '';
        } else {
          currentLine = word;
        }
      }
    }

    if (currentLine.trim()) {
      lines.push({
        text: currentLine.trimEnd(),
        type: 'paragraph',
        fontSize: fontSizePx,
        fontFamily,
        fontWeight,
        fontStyle,
      });
    }
  }

  return lines;
}

function parseMarkdownBlocks(markdown) {
  if (!markdown) return [];

  const blocks = [];
  const lines = markdown.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      blocks.push({ type: 'blank' });
      i++;
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.+)/.exec(trimmed);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2],
      });
      i++;
      continue;
    }

    // Fenced code block
    if (/^```|^~~~/.test(trimmed)) {
      const fence = trimmed.slice(0, 3);
      const codeLines = [];
      i++;
      while (i < lines.length) {
        const codeLine = lines[i];
        if (new RegExp(`^${fence}`).test(codeLine.trim())) {
          i++;
          break;
        }
        codeLines.push(codeLine);
        i++;
      }
      blocks.push({
        type: 'code',
        text: codeLines.join('\n'),
      });
      continue;
    }

    // Blockquote
    if (/^>\s+/.test(trimmed)) {
      blocks.push({
        type: 'quote',
        text: trimmed.replace(/^>\s+/, ''),
      });
      i++;
      continue;
    }

    // Ordered list
    const orderedMatch = /^(\d+)\.\s+(.+)/.exec(trimmed);
    if (orderedMatch) {
      blocks.push({
        type: 'ordered',
        index: parseInt(orderedMatch[1], 10),
        text: orderedMatch[2],
      });
      i++;
      continue;
    }

    // Bullet list
    const bulletMatch = /^[-*+]\s+(.+)/.exec(trimmed);
    if (bulletMatch) {
      blocks.push({
        type: 'bullet',
        text: bulletMatch[1],
      });
      i++;
      continue;
    }

    // Paragraph
    blocks.push({
      type: 'paragraph',
      text: trimmed,
    });
    i++;
  }

  return blocks;
}

function wrapMarkdownLine(ctx, text, maxWidth, fontSize, fontFamily, fontWeight, fontStyle) {
  const lines = [];
  let currentLine = '';
  const words = text.split(/(\s+)/);

  for (const word of words) {
    if (!word) continue;

    const testLine = currentLine + word;
    const metrics = ctx.measureText(testLine);

    if (metrics.width <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine.trim()) {
        lines.push(currentLine.trimEnd());
      }

      // Long word character wrap
      if (ctx.measureText(word).width > maxWidth) {
        const wrappedWords = wrapLongToken(ctx, word, maxWidth);
        for (const wrappedWord of wrappedWords) {
          lines.push(wrappedWord);
        }
        currentLine = '';
      } else {
        currentLine = word;
      }
    }
  }

  if (currentLine.trim()) {
    lines.push(currentLine.trimEnd());
  }

  return lines;
}

export function renderTextPanelCanvas(asset, options = {}) {
  const pixelsPerUnit = options.pixelsPerUnit || 512;
  const layout = asset.layout || DEFAULT_TEXT_LAYOUT;
  const fontSizePx = asset.fontSize || 32;
  const fontFamily = asset.fontFamily || 'system-sans';
  const fontWeight = asset.fontWeight || 'normal';
  const fontStyle = asset.fontStyle || 'normal';

  const canvasWidth = Math.max(256, Math.round(layout.width * pixelsPerUnit));
  const canvasHeight = Math.max(256, Math.round(layout.height * pixelsPerUnit));
  const paddingPx = layout.padding * pixelsPerUnit;
  const contentWidth = canvasWidth - 2 * paddingPx;
  const lineHeightRatio = layout.lineHeight || 1.35;

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    return { canvas, metrics: {} };
  }

  // Set font early for measure operations
  setCanvasFont(ctx, asset);

  // Parse text
  const blocks = asset.format === 'markdown'
    ? parseMarkdownBlocks(asset.text || '')
    : [];

  const layoutLines = [];

  if (asset.format === 'markdown') {
    for (const block of blocks) {
      if (block.type === 'blank') {
        layoutLines.push({
          text: '',
          type: 'blank',
          fontSize: fontSizePx,
          fontFamily,
          fontWeight,
          fontStyle,
          height: fontSizePx * lineHeightRatio * 0.5,
        });
        continue;
      }

      let lineFontSize = fontSizePx;
      let lineText = block.text || '';
      let lineFamily = fontFamily;
      let lineWeight = fontWeight;
      let lineStyle = fontStyle;

      if (block.type === 'heading') {
        const scales = { 1: 1.45, 2: 1.25, 3: 1.1 };
        lineFontSize = fontSizePx * (scales[block.level] || 1);
      } else if (block.type === 'code') {
        lineFontSize = fontSizePx * 0.9;
        lineFamily = 'monospace';
      } else if (block.type === 'quote') {
        lineFontSize = fontSizePx * 0.95;
      }

      setCanvasFont(ctx, {
        fontSize: lineFontSize,
        fontFamily: lineFamily,
        fontWeight: lineWeight,
        fontStyle: lineStyle,
      });

      const wrappedLines = wrapMarkdownLine(
        ctx,
        lineText,
        contentWidth,
        lineFontSize,
        lineFamily,
        lineWeight,
        lineStyle,
      );

      for (const wrappedLine of wrappedLines) {
        let prefix = '';
        if (block.type === 'bullet') {
          prefix = '• ';
        } else if (block.type === 'ordered') {
          prefix = `${block.index}. `;
        } else if (block.type === 'quote') {
          prefix = '> ';
        }

        layoutLines.push({
          text: prefix + wrappedLine,
          type: block.type,
          fontSize: lineFontSize,
          fontFamily: lineFamily,
          fontWeight: lineWeight,
          fontStyle: lineStyle,
          height: lineFontSize * lineHeightRatio,
        });
      }
    }
  } else {
    // Plain text
    setCanvasFont(ctx, asset);
    const wrappedLines = wrapPlainText(ctx, asset.text || '', contentWidth, fontSizePx, fontFamily, fontWeight, fontStyle);
    layoutLines.push(...wrappedLines.map(line => ({
      ...line,
      height: line.fontSize * lineHeightRatio,
    })));
  }

  // Calculate content height
  let contentHeight = 0;
  for (const line of layoutLines) {
    contentHeight += line.height;
  }

  const viewportHeight = canvasHeight - 2 * paddingPx;
  const scrollY = 0;

  // Draw background
  ctx.fillStyle = asset.backgroundColor;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Draw content with clipping
  ctx.save();
  ctx.rect(paddingPx, paddingPx, contentWidth, viewportHeight);
  ctx.clip();

  let y = paddingPx - scrollY;
  for (const line of layoutLines) {
    setCanvasFont(ctx, line);
    ctx.fillStyle = asset.color;
    ctx.textBaseline = 'top';

    if (asset.align === 'center') {
      ctx.textAlign = 'center';
      ctx.fillText(line.text, canvasWidth / 2, y);
    } else if (asset.align === 'right') {
      ctx.textAlign = 'right';
      ctx.fillText(line.text, canvasWidth - paddingPx, y);
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(line.text, paddingPx, y);
    }

    y += line.height;
  }

  ctx.restore();

  return {
    canvas,
    metrics: {
      contentHeight,
      viewportHeight,
      lineCount: layoutLines.length,
      overflow: contentHeight > viewportHeight,
    },
  };
}
