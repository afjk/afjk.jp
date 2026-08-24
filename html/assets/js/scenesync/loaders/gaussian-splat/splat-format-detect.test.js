import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPPORTED_PLY_ENCODING,
  UnsupportedSplatInputError,
  detectSplatContainer,
  extensionOf,
  gaussianSplatGlbName,
  isGaussianSplatFileName,
  readPlyEncoding,
  reviveImportError,
  serializeImportError,
} from './splat-format-detect.js';

const ascii = (text) => new TextEncoder().encode(text);

test('magic bytes win over the extension', () => {
  assert.equal(detectSplatContainer(ascii('ply\nformat'), 'mislabelled.spz').inputFormat, 'ply');

  const glb = new Uint8Array(8);
  new DataView(glb.buffer).setUint32(0, 0x46546c67, true);
  assert.equal(detectSplatContainer(glb, 'model.ply').container, 'glb');

  assert.equal(detectSplatContainer(new Uint8Array([0x1f, 0x8b, 0, 0]), 'x.bin').inputFormat, 'spz');
  assert.equal(detectSplatContainer(ascii('NGSP____'), 'x.bin').inputFormat, 'spz');
});

test('a .sog bundle is a zip that splat-transform mounts itself', () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  assert.deepEqual(detectSplatContainer(zip, 'room.sog'), {
    container: 'raw', inputFormat: 'sog', extension: 'sog',
  });
});

test('any other zip has to be opened before its format is known', () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  assert.deepEqual(detectSplatContainer(zip, 'capture.zip'), {
    container: 'zip', inputFormat: null, extension: 'zip',
  });
});

test('formats without a magic fall back to the extension', () => {
  for (const extension of ['sog', 'lcc2', 'lcc', 'splat', 'ksplat']) {
    const detected = detectSplatContainer(new Uint8Array([1, 2, 3, 4]), `scene.${extension}`);
    assert.deepEqual(detected, { container: 'raw', inputFormat: extension, extension });
  }
});

test('an unknown file is reported as unknown rather than guessed at', () => {
  assert.deepEqual(detectSplatContainer(new Uint8Array([1, 2, 3, 4]), 'scan.xyz'), {
    container: 'unknown', inputFormat: null, extension: 'xyz',
  });
});

test('isGaussianSplatFileName covers every supported drop', () => {
  for (const name of ['a.ply', 'a.PLY', 'a.spz', 'a.sog', 'a.lcc2', 'a.lcc', 'a.splat', 'a.ksplat', 'a.zip']) {
    assert.equal(isGaussianSplatFileName(name), true, name);
  }
  for (const name of ['a.glb', 'a.png', 'a.html', '', null]) {
    assert.equal(isGaussianSplatFileName(name), false, String(name));
  }
});

test('gaussianSplatGlbName swaps the extension', () => {
  assert.equal(gaussianSplatGlbName('capture.ply'), 'capture.glb');
  assert.equal(gaussianSplatGlbName('scan.SPZ'), 'scan.glb');
  assert.equal(gaussianSplatGlbName('room.sog'), 'room.glb');
  assert.equal(gaussianSplatGlbName('room.v2.ply'), 'room.v2.glb');
  assert.equal(gaussianSplatGlbName('site.lcc2.zip'), 'site.lcc2.glb');
  assert.equal(gaussianSplatGlbName(''), 'gaussian-splats.glb');
});

test('extensionOf ignores directories and dotfiles', () => {
  assert.equal(extensionOf('a/b/c.ply'), 'ply');
  assert.equal(extensionOf('C:\\scans\\room.SOG'), 'sog');
  assert.equal(extensionOf('.gitignore'), '');
  assert.equal(extensionOf('noextension'), '');
});

test('an import error survives a round trip through postMessage', () => {
  const original = new UnsupportedSplatInputError('だめでした', 'not-gaussian-splat');
  const revived = reviveImportError(structuredClone(serializeImportError(original)));

  assert.ok(revived instanceof UnsupportedSplatInputError);
  assert.equal(revived.variant, 'not-gaussian-splat');
  assert.equal(revived.message, 'だめでした');
});

test('an ordinary error keeps its message and becomes a plain Error', () => {
  const revived = reviveImportError(serializeImportError(new RangeError('out of range')));
  assert.equal(revived.constructor, Error);
  assert.equal(revived.message, 'out of range');
});

test('readPlyEncoding reads the header line', () => {
  const header = (format) => ascii(`ply\nformat ${format} 1.0\nelement vertex 1\nend_header\n`);

  assert.equal(readPlyEncoding(header('binary_little_endian')), SUPPORTED_PLY_ENCODING);
  assert.equal(readPlyEncoding(header('binary_big_endian')), 'binary_big_endian');
  assert.equal(readPlyEncoding(header('ascii')), 'ascii');
});

test('readPlyEncoding reports nothing for a file without a header', () => {
  assert.equal(readPlyEncoding(new Uint8Array([0, 1, 2, 3])), null);
});

test('readPlyEncoding only looks at the header, not the payload', () => {
  // A binary payload that happens to contain the word "format" further in must
  // not be mistaken for a header line.
  const bytes = new Uint8Array(4096);
  bytes.set(ascii('ply\nformat binary_little_endian 1.0\nend_header\n'), 0);
  bytes.set(ascii('\nformat ascii 1.0'), 3000);

  assert.equal(readPlyEncoding(bytes), SUPPORTED_PLY_ENCODING);
});
