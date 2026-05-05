import { test } from 'node:test';
import * as assert from 'node:assert';

// Mock DOMParser for Node environment
global.DOMParser = class {
  parseFromString(htmlString, mimeType) {
    const mockDoc = {
      querySelector: (selector) => {
        if (selector === 'img[src]') {
          if (htmlString.includes('<img')) {
            const match = htmlString.match(/src=['"]([^'"]+)['"]/);
            return match ? { src: match[1] } : null;
          }
        }
        if (selector === 'a[href]') {
          if (htmlString.includes('<a')) {
            const match = htmlString.match(/href=['"]([^'"]+)['"]/);
            return match ? { href: match[1] } : null;
          }
        }
        return null;
      },
    };
    return mockDoc;
  }
};

// Import after mock setup
import { parseClipboardDataTransfer, parseNavigatorClipboardItems } from '../../../html/assets/js/scenesync/loaders/clipboard-parser.js';

test('parseClipboardDataTransfer - text/plain URL', (t) => {
  const dataTransfer = {
    items: [],
    files: null,
    types: ['text/plain'],
    getData: (type) => {
      if (type === 'text/plain') return 'https://example.com/model.glb';
      return '';
    },
  };

  const result = parseClipboardDataTransfer(dataTransfer);
  assert.deepStrictEqual(result, { kind: 'url', url: 'https://example.com/model.glb' });
});

test('parseClipboardDataTransfer - text/plain normal text', (t) => {
  const dataTransfer = {
    items: [],
    files: null,
    types: ['text/plain'],
    getData: (type) => {
      if (type === 'text/plain') return 'hello scene sync';
      return '';
    },
  };

  const result = parseClipboardDataTransfer(dataTransfer);
  assert.deepStrictEqual(result, { kind: 'text', text: 'hello scene sync', filename: 'clipboard.txt' });
});

test('parseClipboardDataTransfer - text/html img', (t) => {
  const dataTransfer = {
    items: [],
    files: null,
    types: ['text/html'],
    getData: (type) => {
      if (type === 'text/html') return '<img src="https://example.com/image.png">';
      return '';
    },
  };

  const result = parseClipboardDataTransfer(dataTransfer);
  assert.deepStrictEqual(result, { kind: 'url', url: 'https://example.com/image.png' });
});

test('parseClipboardDataTransfer - text/html anchor', (t) => {
  const dataTransfer = {
    items: [],
    files: null,
    types: ['text/html'],
    getData: (type) => {
      if (type === 'text/html') return '<a href="https://example.com/model.glb">model</a>';
      return '';
    },
  };

  const result = parseClipboardDataTransfer(dataTransfer);
  assert.deepStrictEqual(result, { kind: 'url', url: 'https://example.com/model.glb' });
});

test('parseClipboardDataTransfer - text/uri-list', (t) => {
  const dataTransfer = {
    items: [],
    files: null,
    types: ['text/uri-list'],
    getData: (type) => {
      if (type === 'text/uri-list') return 'https://example.com/image.jpg\n# comment';
      return '';
    },
  };

  const result = parseClipboardDataTransfer(dataTransfer);
  assert.deepStrictEqual(result, { kind: 'url', url: 'https://example.com/image.jpg' });
});

test('parseClipboardDataTransfer - empty clipboard', (t) => {
  const dataTransfer = {
    items: [],
    files: null,
    types: [],
    getData: () => '',
  };

  const result = parseClipboardDataTransfer(dataTransfer);
  assert.deepStrictEqual(result, { kind: 'empty' });
});

test('parseClipboardDataTransfer - null dataTransfer', (t) => {
  const result = parseClipboardDataTransfer(null);
  assert.deepStrictEqual(result, { kind: 'empty' });
});

test('parseClipboardDataTransfer - long text truncation', (t) => {
  const longText = 'a'.repeat(25000);
  const dataTransfer = {
    items: [],
    files: null,
    types: ['text/plain'],
    getData: (type) => {
      if (type === 'text/plain') return longText;
      return '';
    },
  };

  const result = parseClipboardDataTransfer(dataTransfer);
  assert.strictEqual(result.kind, 'text');
  assert.strictEqual(result.text.length, 20000);
  assert.strictEqual(result.filename, 'clipboard.txt');
});

test('parseClipboardDataTransfer - image file priority', (t) => {
  const mockFile = { name: 'image.png' };
  const dataTransfer = {
    items: [
      {
        kind: 'file',
        type: 'image/png',
        getAsFile: () => mockFile,
      },
    ],
    files: null,
    types: ['Files'],
    getData: (type) => {
      if (type === 'text/plain') return 'https://example.com/fallback.jpg';
      return '';
    },
  };

  const result = parseClipboardDataTransfer(dataTransfer);
  assert.deepStrictEqual(result, { kind: 'file', file: mockFile });
});

test('parseClipboardDataTransfer - file without image', (t) => {
  const mockFile = { name: 'document.glb' };
  const dataTransfer = {
    items: [],
    files: [mockFile],
    types: ['Files'],
    getData: () => '',
  };

  const result = parseClipboardDataTransfer(dataTransfer);
  assert.deepStrictEqual(result, { kind: 'file', file: mockFile });
});

test('parseClipboardDataTransfer - whitespace URL', (t) => {
  const dataTransfer = {
    items: [],
    files: null,
    types: ['text/plain'],
    getData: (type) => {
      if (type === 'text/plain') return '  https://example.com/model.glb  ';
      return '';
    },
  };

  const result = parseClipboardDataTransfer(dataTransfer);
  assert.deepStrictEqual(result, { kind: 'url', url: 'https://example.com/model.glb' });
});

test('parseClipboardDataTransfer - invalid URL fallback to text', (t) => {
  const dataTransfer = {
    items: [],
    files: null,
    types: ['text/plain'],
    getData: (type) => {
      if (type === 'text/plain') return 'not a url, just text';
      return '';
    },
  };

  const result = parseClipboardDataTransfer(dataTransfer);
  assert.deepStrictEqual(result, { kind: 'text', text: 'not a url, just text', filename: 'clipboard.txt' });
});

test('parseClipboardDataTransfer - http URL', (t) => {
  const dataTransfer = {
    items: [],
    files: null,
    types: ['text/plain'],
    getData: (type) => {
      if (type === 'text/plain') return 'http://example.com/image.png';
      return '';
    },
  };

  const result = parseClipboardDataTransfer(dataTransfer);
  assert.deepStrictEqual(result, { kind: 'url', url: 'http://example.com/image.png' });
});

// NOTE: ClipboardImportManager.handlePasteEvent tests require DOM environment
// Manual test cases:
// 1. force:false + isEditingTarget:true → returns false
// 2. force:true + isEditingTarget:true → returns true (imports)
// 3. empty payload → returns false
// These are tested in browser integration tests
