import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_EXPORT_FORMAT,
  base64EncodedByteLength,
  DEFAULT_AUTO_SINGLE_HTML_THRESHOLD_BYTES,
  estimateSingleHtmlExport,
  normalizeAutoSingleHtmlThresholdBytes,
  selectAutoExportFormat,
  utf8ByteLength,
} from './auto-export-format.js';
import { buildSingleHtmlDocument } from './single-html-format.js';

test('base64 estimate follows exact 4 * ceil(n / 3) boundaries', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(base64EncodedByteLength), [0, 4, 4, 4, 8, 8, 8]);
});

test('estimator exactly matches generated HTML with rewrites, CSS, escaping, MIME and binary assets', async () => {
  const longPath = `assets/${'長い-path_<&>'.repeat(180)}.glb`;
  const manyImports = Array.from({ length: 1500 }, (_, index) => `import value${index} from './module-${index}.js';`).join('\n');
  const input = {
    sceneDocument: { title: '雪<scene>&', objects: [{ asset: { type: 'primitive' } }] },
    manifest: { notes: ['<script>\u2028&'], viewer: { entry: 'self' } },
    files: {
      'assets/image.png': new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      [longPath]: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'model/gltf-binary' }),
    },
    viewerFiles: {
      'viewer/viewer.css': '.x::before{content:"</style>雪"}',
      'viewer/player-shell.css': '.player{color:red}',
      'scenesync/handoff/source.css': '.handoff{display:block}',
      'viewer/deep/entry.js': `${manyImports}\nexport const marker = '</script>雪';`,
      'viewer/rapier/rapier.js': 'const wasm = new URL("rapier_wasm3d_bg.wasm","<deleted>"); export { wasm };',
      'viewer/rapier/rapier_wasm3d_bg.wasm': new Uint8Array([1, 2, 3, 4, 5]),
    },
  };
  const estimated = estimateSingleHtmlExport(input);
  const actual = utf8ByteLength(await buildSingleHtmlDocument(input));
  assert.equal(estimated, actual);
});

test('Auto chooses Single HTML at the threshold and ZIP above it', () => {
  const common = { requestedFormat: AUTO_EXPORT_FORMAT, thresholdBytes: 100, singleHtmlSupported: true, staticZipSupported: true };
  assert.equal(selectAutoExportFormat({ ...common, estimatedBytes: 99 }).format, 'single-html');
  assert.equal(selectAutoExportFormat({ ...common, estimatedBytes: 100 }).format, 'single-html');
  const above = selectAutoExportFormat({ ...common, estimatedBytes: 101 });
  assert.equal(above.format, 'static-zip');
  assert.equal(above.reason, 'single-html-estimate-exceeds-threshold');
});

test('invalid Auto thresholds use the documented default', () => {
  for (const invalid of [null, -1, NaN, '32', Infinity, 3.5]) {
    assert.equal(normalizeAutoSingleHtmlThresholdBytes(invalid), DEFAULT_AUTO_SINGLE_HTML_THRESHOLD_BYTES);
  }
  assert.equal(normalizeAutoSingleHtmlThresholdBytes(0), 0);
  assert.equal(normalizeAutoSingleHtmlThresholdBytes(123), 123);
});

test('Auto falls back for missing assets and custom thumbnails', () => {
  const missing = selectAutoExportFormat({ estimatedBytes: 1, missingAssets: [{ id: 'image' }] });
  assert.equal(missing.format, 'static-zip');
  assert.equal(missing.reason, 'unembedded-external-assets-prefer-static-zip');
  assert.deepEqual(missing.warnings, ['external-assets-not-embedded']);
  const thumbnail = selectAutoExportFormat({ estimatedBytes: 1, hasCustomThumbnail: true });
  assert.equal(thumbnail.format, 'static-zip');
  assert.equal(thumbnail.reason, 'custom-thumbnail-requires-static-zip');
});

test('forced modes retain user choice, aggregate warnings, and reject unsupported thumbnail', () => {
  assert.equal(selectAutoExportFormat({ requestedFormat: 'static-zip' }).reason, 'forced-static-zip');
  const single = selectAutoExportFormat({
    requestedFormat: 'single-html', estimatedBytes: DEFAULT_AUTO_SINGLE_HTML_THRESHOLD_BYTES + 1,
    missingAssets: [{ id: 'external' }],
  });
  assert.equal(single.format, 'single-html');
  assert.deepEqual(single.warnings, ['single-html-estimate-exceeds-auto-threshold', 'external-assets-not-embedded']);
  assert.equal(selectAutoExportFormat({ requestedFormat: 'single-html', hasCustomThumbnail: true }).reason, 'single-html-custom-thumbnail-unsupported');
  const unavailable = selectAutoExportFormat({ requestedFormat: 'single-html', singleHtmlSupported: false });
  assert.equal(unavailable.format, null);
  assert.equal(unavailable.reason, 'single-html-required-dependency-unembeddable');
});
