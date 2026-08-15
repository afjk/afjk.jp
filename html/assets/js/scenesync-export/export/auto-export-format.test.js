import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_EXPORT_FORMAT,
  base64EncodedByteLength,
  DEFAULT_AUTO_SINGLE_HTML_THRESHOLD_BYTES,
  estimateSingleHtmlExport,
  selectAutoExportFormat,
} from './auto-export-format.js';

test('base64 estimate follows exact 4 * ceil(n / 3) boundaries', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(base64EncodedByteLength), [0, 4, 4, 4, 8, 8, 8]);
});

test('Auto chooses Single HTML at the threshold and ZIP above it', () => {
  const common = { requestedFormat: AUTO_EXPORT_FORMAT, thresholdBytes: 100, singleHtmlSupported: true, staticZipSupported: true };
  assert.equal(selectAutoExportFormat({ ...common, estimatedBytes: 99 }).format, 'single-html');
  assert.equal(selectAutoExportFormat({ ...common, estimatedBytes: 100 }).format, 'single-html');
  const above = selectAutoExportFormat({ ...common, estimatedBytes: 101 });
  assert.equal(above.format, 'static-zip');
  assert.equal(above.reason, 'single-html-estimate-exceeds-threshold');
});

test('estimate includes primitive document, image/GLB base64, modules and binary runtime', () => {
  const primitive = estimateSingleHtmlExport({
    sceneDocument: { objects: [{ asset: { type: 'primitive' } }] },
    manifest: {}, fixedOverheadBytes: 0,
  });
  const image = estimateSingleHtmlExport({
    sceneDocument: { objects: [] }, manifest: {}, files: { 'assets/image.png': new Uint8Array(3) }, fixedOverheadBytes: 0,
  });
  const glb = estimateSingleHtmlExport({
    sceneDocument: { objects: [] }, manifest: {}, files: { 'assets/model.glb': new Uint8Array(4) }, fixedOverheadBytes: 0,
  });
  const runtime = estimateSingleHtmlExport({
    sceneDocument: {}, manifest: {}, viewerFiles: { 'viewer/rapier/rapier_wasm3d_bg.wasm': new Uint8Array(5) }, fixedOverheadBytes: 0,
  });
  assert(primitive > 0);
  assert(image > primitive);
  assert(glb > image);
  assert(runtime > primitive);
});

test('Auto falls back for missing assets and unavailable Single HTML dependencies', () => {
  const missing = selectAutoExportFormat({ estimatedBytes: 1, missingAssets: [{ id: 'image' }] });
  assert.deepEqual(missing, {
    format: 'static-zip', reason: 'missing-assets-static-zip-fidelity', warning: 'external-assets-not-embedded',
  });
  const unsupported = selectAutoExportFormat({ estimatedBytes: 1, singleHtmlSupported: false, staticZipSupported: false });
  assert.equal(unsupported.format, null);
  assert.equal(unsupported.reason, 'required-viewer-dependency-unavailable');
});

test('forced modes retain user choice and forced large Single HTML warns', () => {
  assert.equal(selectAutoExportFormat({ requestedFormat: 'static-zip' }).reason, 'forced-static-zip');
  const single = selectAutoExportFormat({
    requestedFormat: 'single-html', estimatedBytes: DEFAULT_AUTO_SINGLE_HTML_THRESHOLD_BYTES + 1,
  });
  assert.equal(single.format, 'single-html');
  assert.equal(single.warning, 'single-html-estimate-exceeds-auto-threshold');
  const unavailable = selectAutoExportFormat({ requestedFormat: 'single-html', singleHtmlSupported: false });
  assert.equal(unavailable.format, null);
  assert.equal(unavailable.reason, 'single-html-required-dependency-unembeddable');
});
