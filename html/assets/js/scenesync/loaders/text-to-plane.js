// Text/Markdown to plane GLB converter

/**
 * Normalize and sanitize input text
 * @param {string} raw - Raw input text
 * @param {object} opts - { maxChars = 5000 }
 * @returns {string} Normalized text with truncation if needed
 */
export function normalizeTextInput(raw, { maxChars = 5000 } = {}) {
  if (!raw) return '';

  // Unify line endings
  let text = String(raw).replace(/\r\n/g, '\n');

  // Trim leading/trailing whitespace
  text = text.trim();

  // Truncate if exceeds maxChars
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 1) + '…';
  }

  return text;
}

/**
 * Simple Markdown parsing for phase 1 subset
 * Returns styled text lines and computed canvas height
 * Note (Phase 1): Wrapped lines from bullet items do not preserve the bullet
 * indent. Suitable for short labels and titles.
 * @param {string} text - Normalized text (or markdown)
 * @param {object} opts
 *   - canvasWidth: number (px)
 *   - padding: number (px)
 *   - fontSizePx: number (px)
 *   - lineHeight: number (unitless ratio)
 *   - fontFamily: string
 *   - markdown: boolean (default true)
 * @returns {{ lines: Array<{text: string, style: object}>, height: number }}
 */
export function layoutText(text, {
  canvasWidth,
  padding = 64,
  fontSizePx = 48,
  lineHeight = 1.4,
  fontFamily = 'system-ui, sans-serif',
  markdown = true,
} = {}) {
  const lines = [];
  const contentWidth = canvasWidth - 2 * padding;
  const lineHeightPx = fontSizePx * lineHeight;
  let totalHeight = padding;

  // Split input into logical paragraphs
  const paragraphs = text.split(/\n\n+/);

  // Parse markdown or plain text
  let rawLines = [];
  if (markdown) {
    for (const para of paragraphs) {
      const paraLines = para.split('\n');
      for (const line of paraLines) {
        // Heading: # / ## / ### at line start
        let headingLevel = 0;
        let content = line;
        if (/^###\s+/.test(line)) {
          headingLevel = 3;
          content = line.replace(/^###\s+/, '');
        } else if (/^##\s+/.test(line)) {
          headingLevel = 2;
          content = line.replace(/^##\s+/, '');
        } else if (/^#\s+/.test(line)) {
          headingLevel = 1;
          content = line.replace(/^#\s+/, '');
        } else if (/^---$/.test(line.trim())) {
          // Horizontal rule - special marker
          rawLines.push({ text: '───────────────────', style: { hrule: true } });
          continue;
        } else if (/^[\-\*]\s+/.test(line)) {
          // Bullet point
          content = line.replace(/^[\-\*]\s+/, '');
          rawLines.push({ text: `• ${content}`, style: { bullet: true } });
          continue;
        }

        if (content.trim()) {
          const style = {};
          if (headingLevel > 0) {
            style.heading = headingLevel;
            const scales = { 1: 1.6, 2: 1.3, 3: 1.1 };
            style.fontSize = fontSizePx * scales[headingLevel];
            style.bold = true;
          }
          // Process inline markdown: **bold**, *italic* (phase 1: bold only)
          content = content.replace(/\*\*(.+?)\*\*/g, (m, inner) => inner); // Extract bold text
          rawLines.push({ text: content, style });
        }
      }
      // Paragraph separator (small gap)
      if (para !== paragraphs[paragraphs.length - 1]) {
        rawLines.push({ text: '', style: { gap: true } });
      }
    }
  } else {
    // Plain text mode
    const allLines = text.split('\n');
    for (const line of allLines) {
      rawLines.push({ text: line, style: {} });
    }
  }

  // Word-wrap and estimate height
  for (const lineItem of rawLines) {
    if (lineItem.style?.gap) {
      totalHeight += lineHeightPx * 0.5; // Gap between paragraphs
      continue;
    }

    const fontSize = lineItem.style?.fontSize || fontSizePx;
    const isBold = lineItem.style?.bold || false;
    const content = lineItem.text;

    // Simple word-wrap by space or character
    const words = content.split(/(\s+)/);
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine + word;
      // Rough width estimate: avg char width ~ fontSize * 0.5
      const estWidth = testLine.length * fontSize * 0.55;

      if (estWidth > contentWidth && currentLine.length > 0) {
        // Flush current line
        lines.push({ text: currentLine.trim(), style: { fontSize, bold: isBold, ...lineItem.style } });
        totalHeight += fontSize * lineHeight;
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine.trim()) {
      lines.push({ text: currentLine.trim(), style: { fontSize, bold: isBold, ...lineItem.style } });
      totalHeight += fontSize * lineHeight;
    }
  }

  // Add bottom padding
  totalHeight += padding;

  // Clamp height between 256 and 8192
  totalHeight = Math.max(256, Math.min(8192, Math.ceil(totalHeight)));

  return { lines, height: totalHeight };
}

/**
 * Calculate plane size from canvas dimensions
 * Normalizes longer edge to maxEdgeMeters, maintains aspect ratio
 * @param {number} canvasWidth - Canvas width in pixels
 * @param {number} canvasHeight - Canvas height in pixels
 * @param {number} maxEdgeMeters - Target for longest edge (default 2.0)
 * @returns {{ width: number, height: number }}
 */
export function planeSizeFromCanvas(canvasWidth, canvasHeight, maxEdgeMeters = 2) {
  const maxDim = Math.max(canvasWidth, canvasHeight);
  const scale = maxEdgeMeters / maxDim;
  return {
    width: canvasWidth * scale,
    height: canvasHeight * scale,
  };
}

/**
 * Render text to canvas and return CanvasTexture-ready canvas
 * @private
 */
function renderTextToCanvas(text, opts) {
  const {
    canvasWidth = 2048,
    padding = 64,
    fontFamily = 'system-ui, sans-serif',
    fontSizePx = 48,
    lineHeight = 1.4,
    textColor = '#111111',
    bgColor = '#ffffff',
    markdown = true,
  } = opts;

  const { lines, height: canvasHeight } = layoutText(text, {
    canvasWidth,
    padding,
    fontSizePx,
    lineHeight,
    fontFamily,
    markdown,
  });

  // Create canvas
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  // Fill background
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Text color
  ctx.fillStyle = textColor;

  // Render lines
  let y = padding;
  for (const line of lines) {
    if (line.style?.gap) {
      y += fontSizePx * lineHeight * 0.5;
      continue;
    }

    const fontSize = line.style?.fontSize || fontSizePx;
    const isBold = line.style?.bold || false;
    const fontStr = `${isBold ? 'bold ' : ''}${fontSize}px ${fontFamily}`;
    ctx.font = fontStr;
    ctx.textBaseline = 'top';

    // Horizontal rule special case
    if (line.style?.hrule) {
      const lineY = y + fontSize * 0.4;
      ctx.strokeStyle = textColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding, lineY);
      ctx.lineTo(canvasWidth - padding, lineY);
      ctx.stroke();
    } else {
      ctx.fillText(line.text, padding, y);
    }

    y += fontSize * lineHeight;
  }

  return { canvas, lines, height: canvasHeight };
}

/**
 * Build text plane GLB
 * @param {string} text - Plain text or markdown
 * @param {object} opts
 *   - THREE: three module
 *   - GLTFExporter: GLTFExporter class
 *   - maxEdgeMeters: number (default 2.0)
 *   - canvasWidth: number (default 2048)
 *   - padding: number (default 64)
 *   - fontFamily: string (default 'system-ui, sans-serif')
 *   - fontSizePx: number (default 48)
 *   - lineHeight: number (default 1.4)
 *   - textColor: string (default '#111111')
 *   - bgColor: string (default '#ffffff')
 *   - markdown: boolean (default true)
 * @returns {Promise<{arrayBuffer: ArrayBuffer, width: number, height: number, lineCount: number}>}
 */
export async function buildTextPlaneGlb(text, {
  THREE,
  GLTFExporter,
  maxEdgeMeters = 2,
  canvasWidth = 2048,
  padding = 64,
  fontFamily = 'system-ui, sans-serif',
  fontSizePx = 48,
  lineHeight = 1.4,
  textColor = '#111111',
  bgColor = '#ffffff',
  markdown = true,
} = {}) {
  if (!THREE || !GLTFExporter) {
    throw new Error('THREE and GLTFExporter are required');
  }

  const normalizedText = normalizeTextInput(text);
  if (!normalizedText) {
    throw new Error('Text is empty after normalization');
  }

  // Render to canvas
  const { canvas, lines } = renderTextToCanvas(normalizedText, {
    canvasWidth,
    padding,
    fontFamily,
    fontSizePx,
    lineHeight,
    textColor,
    bgColor,
    markdown,
  });

  const canvasHeight = canvas.height;

  // Create texture
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  // Calculate plane size
  const { width: planeWidth, height: planeHeight } = planeSizeFromCanvas(
    canvasWidth,
    canvasHeight,
    maxEdgeMeters
  );

  // Create plane geometry and material
  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    transparent: false,
    toneMapped: false,
  });

  // Create mesh and group
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = planeHeight / 2;
  const group = new THREE.Group();
  group.add(mesh);

  // Export to GLB
  const exporter = new GLTFExporter();
  const arrayBuffer = await new Promise((resolve, reject) => {
    exporter.parse(
      group,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          reject(new Error('GLTFExporter did not return ArrayBuffer'));
        }
      },
      (error) => reject(error),
      { binary: true, embedImages: true }
    );
  });

  return {
    arrayBuffer,
    width: planeWidth,
    height: planeHeight,
    lineCount: lines.length,
  };
}
