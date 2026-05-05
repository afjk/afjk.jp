import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planeSizeFromCanvas,
  layoutText,
  normalizeTextInput,
} from '../../../html/assets/js/scenesync/loaders/text-to-plane.js';

test('normalizeTextInput', async (t) => {
  await t.test('returns plain text unchanged', () => {
    const input = 'Hello World';
    const result = normalizeTextInput(input);
    assert.equal(result, input);
  });

  await t.test('unifies line endings from CRLF to LF', () => {
    const input = 'line1\r\nline2\r\nline3';
    const result = normalizeTextInput(input);
    assert.equal(result, 'line1\nline2\nline3');
  });

  await t.test('trims leading and trailing whitespace', () => {
    const input = '  hello world  \n';
    const result = normalizeTextInput(input);
    assert.equal(result, 'hello world');
  });

  await t.test('handles null and undefined as empty string', () => {
    assert.equal(normalizeTextInput(null), '');
    assert.equal(normalizeTextInput(undefined), '');
  });

  await t.test('truncates text exceeding maxChars with ellipsis', () => {
    const input = 'a'.repeat(5001);
    const result = normalizeTextInput(input, { maxChars: 5000 });
    assert.equal(result.length, 5000);
    assert.equal(result[result.length - 1], '…');
  });

  await t.test('respects custom maxChars', () => {
    const input = 'a'.repeat(1000);
    const result = normalizeTextInput(input, { maxChars: 100 });
    assert.equal(result.length, 100);
  });
});

test('planeSizeFromCanvas', async (t) => {
  await t.test('normalizes to maxEdgeMeters with 2048x1024', () => {
    const { width, height } = planeSizeFromCanvas(2048, 1024, 2);
    assert.equal(width, 2);
    assert.equal(height, 1);
  });

  await t.test('normalizes to maxEdgeMeters with 1024x2048', () => {
    const { width, height } = planeSizeFromCanvas(1024, 2048, 2);
    assert.equal(width, 1);
    assert.equal(height, 2);
  });

  await t.test('maintains aspect ratio for square canvas', () => {
    const { width, height } = planeSizeFromCanvas(1024, 1024, 2);
    assert.equal(width, 2);
    assert.equal(height, 2);
  });

  await t.test('respects custom maxEdgeMeters', () => {
    const { width, height } = planeSizeFromCanvas(2048, 1024, 4);
    assert.equal(width, 4);
    assert.equal(height, 2);
  });

  await t.test('maintains aspect ratio with custom maxEdgeMeters', () => {
    const { width, height } = planeSizeFromCanvas(800, 600, 1);
    assert.equal(width, 1);
    const expectedHeight = 600 / 800;
    assert.equal(Math.abs(height - expectedHeight) < 0.001, true);
  });
});

test('layoutText', async (t) => {
  await t.test('returns lines array and computed height', () => {
    const text = 'Hello\nWorld';
    const result = layoutText(text, {
      canvasWidth: 2048,
      padding: 64,
      fontSizePx: 48,
      lineHeight: 1.4,
    });
    assert(Array.isArray(result.lines));
    assert(typeof result.height === 'number');
  });

  await t.test('plain text mode splits on newlines', () => {
    const text = 'line1\nline2\nline3';
    const result = layoutText(text, {
      canvasWidth: 2048,
      padding: 64,
      fontSizePx: 48,
      lineHeight: 1.4,
      markdown: false,
    });
    assert(result.lines.length >= 3);
  });

  await t.test('markdown mode detects heading level 1', () => {
    const text = '# Title\nBody text';
    const result = layoutText(text, {
      canvasWidth: 2048,
      padding: 64,
      fontSizePx: 48,
      lineHeight: 1.4,
      markdown: true,
    });
    const headingLine = result.lines.find(line => line.style?.heading === 1);
    assert(headingLine, 'should have level 1 heading');
  });

  await t.test('markdown mode detects heading level 2', () => {
    const text = '## Subtitle\nBody';
    const result = layoutText(text, {
      canvasWidth: 2048,
      padding: 64,
      fontSizePx: 48,
      lineHeight: 1.4,
      markdown: true,
    });
    const headingLine = result.lines.find(line => line.style?.heading === 2);
    assert(headingLine, 'should have level 2 heading');
  });

  await t.test('markdown mode detects heading level 3', () => {
    const text = '### Small\nBody';
    const result = layoutText(text, {
      canvasWidth: 2048,
      padding: 64,
      fontSizePx: 48,
      lineHeight: 1.4,
      markdown: true,
    });
    const headingLine = result.lines.find(line => line.style?.heading === 3);
    assert(headingLine, 'should have level 3 heading');
  });

  await t.test('markdown mode converts bullet points with -', () => {
    const text = '- item1\n- item2';
    const result = layoutText(text, {
      canvasWidth: 2048,
      padding: 64,
      fontSizePx: 48,
      lineHeight: 1.4,
      markdown: true,
    });
    const bulletLines = result.lines.filter(line => line.style?.bullet);
    assert(bulletLines.length >= 2, 'should have bullet points');
    assert(bulletLines[0].text.includes('•'), 'bullet text should contain bullet char');
  });

  await t.test('markdown mode converts bullet points with *', () => {
    const text = '* item1\n* item2';
    const result = layoutText(text, {
      canvasWidth: 2048,
      padding: 64,
      fontSizePx: 48,
      lineHeight: 1.4,
      markdown: true,
    });
    const bulletLines = result.lines.filter(line => line.style?.bullet);
    assert(bulletLines.length >= 2, 'should have bullet points');
  });

  await t.test('height is clamped between 256 and 8192', () => {
    const tinyText = 'x';
    const tinyResult = layoutText(tinyText, {
      canvasWidth: 2048,
      padding: 64,
      fontSizePx: 48,
      lineHeight: 1.4,
    });
    assert(tinyResult.height >= 256, 'height should be at least 256');

    const hugeText = 'x\n'.repeat(300);
    const hugeResult = layoutText(hugeText, {
      canvasWidth: 2048,
      padding: 64,
      fontSizePx: 48,
      lineHeight: 1.4,
    });
    assert(hugeResult.height <= 8192, 'height should not exceed 8192');
  });

  await t.test('respects custom padding', () => {
    const text = 'Hello';
    const resultSmall = layoutText(text, {
      canvasWidth: 2048,
      padding: 10,
      fontSizePx: 48,
      lineHeight: 1.4,
    });
    const resultLarge = layoutText(text, {
      canvasWidth: 2048,
      padding: 200,
      fontSizePx: 48,
      lineHeight: 1.4,
    });
    assert(resultLarge.height > resultSmall.height, 'larger padding should increase height');
  });

  await t.test('word wraps long lines', () => {
    const longLine = 'This is a very long line that should wrap within the canvas width constraints';
    const result = layoutText(longLine, {
      canvasWidth: 200,
      padding: 10,
      fontSizePx: 48,
      lineHeight: 1.4,
    });
    assert(result.lines.length > 1, 'long line should wrap into multiple lines');
  });

  await t.test('handles empty paragraphs', () => {
    const text = 'para1\n\n\npara2';
    const result = layoutText(text, {
      canvasWidth: 2048,
      padding: 64,
      fontSizePx: 48,
      lineHeight: 1.4,
    });
    assert(result.lines.length >= 2, 'should handle multiple empty lines');
  });

  await t.test('applies heading font sizes correctly', () => {
    const text = '# H1\n## H2\n### H3\nBody';
    const result = layoutText(text, {
      canvasWidth: 2048,
      padding: 64,
      fontSizePx: 48,
      lineHeight: 1.4,
      markdown: true,
    });

    const h1 = result.lines.find(line => line.style?.heading === 1);
    const h2 = result.lines.find(line => line.style?.heading === 2);
    const h3 = result.lines.find(line => line.style?.heading === 3);

    assert(h1 && h1.style.fontSize > 48, 'H1 should be larger than base');
    assert(h2 && h2.style.fontSize > 48, 'H2 should be larger than base');
    assert(h3 && h3.style.fontSize > 48, 'H3 should be larger than base');
    assert(h1.style.fontSize > h2.style.fontSize, 'H1 should be larger than H2');
    assert(h2.style.fontSize > h3.style.fontSize, 'H2 should be larger than H3');
  });
});
