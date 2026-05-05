import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_SHAPE,
  CONFIDENCE,
  classifyByExtension,
  classifyByGPano,
  classifyByAspect,
  classifyByFilename,
  detectImageShape,
} from '../../../html/assets/js/scenesync/loaders/image-shape-detector.js';

// Test helpers
function makeFile(name, size = 1024) {
  return { name, size };
}

function makeDeps(opts = {}) {
  const {
    xmp = undefined,
    size = { width: 100, height: 100 },
    alpha = false,
    exifrThrows = false,
    sizeThrows = false,
  } = opts;

  return {
    exifr: {
      parse: async () => {
        if (exifrThrows) throw new Error('xmp');
        return xmp;
      },
    },
    hasAlpha: async () => alpha,
    getImageSize: async () => {
      if (sizeThrows) throw new Error('decode');
      return size;
    },
  };
}

// classifyByExtension tests
test('classifyByExtension: .hdr extension', () => {
  const result = classifyByExtension('room.hdr');
  assert.equal(result.shape, IMAGE_SHAPE.HDRI);
  assert.equal(result.confidence, CONFIDENCE.HIGH);
  assert.equal(result.reason, 'extension:hdr/exr');
});

test('classifyByExtension: .exr extension (uppercase)', () => {
  const result = classifyByExtension('room.EXR');
  assert.equal(result.shape, IMAGE_SHAPE.HDRI);
  assert.equal(result.confidence, CONFIDENCE.HIGH);
});

test('classifyByExtension: .png returns null', () => {
  const result = classifyByExtension('cat.png');
  assert.equal(result, null);
});

test('classifyByExtension: no extension', () => {
  const result = classifyByExtension('noext');
  assert.equal(result, null);
});

test('classifyByExtension: null filename', () => {
  const result = classifyByExtension(null);
  assert.equal(result, null);
});

// classifyByAspect tests
test('classifyByAspect: 4096×2048 (2:1)', () => {
  const result = classifyByAspect(4096, 2048);
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result.confidence, CONFIDENCE.MEDIUM);
  assert.equal(result.reason, 'aspect-2to1');
});

test('classifyByAspect: 2048×1024 (2:1)', () => {
  const result = classifyByAspect(2048, 1024);
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result.confidence, CONFIDENCE.MEDIUM);
});

test('classifyByAspect: 1024×512 (width too small)', () => {
  const result = classifyByAspect(1024, 512);
  assert.equal(result, null);
});

test('classifyByAspect: 4096×2100 (within tolerance)', () => {
  const result = classifyByAspect(4096, 2100);
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result.confidence, CONFIDENCE.MEDIUM);
});

test('classifyByAspect: 4000×2000 (boundary, OK)', () => {
  const result = classifyByAspect(4000, 2000);
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
});

test('classifyByAspect: 1920×1080', () => {
  const result = classifyByAspect(1920, 1080);
  assert.equal(result, null);
});

test('classifyByAspect: zero height', () => {
  const result = classifyByAspect(4096, 0);
  assert.equal(result, null);
});

// classifyByFilename tests
test('classifyByFilename: pano_01.jpg', () => {
  const result = classifyByFilename('pano_01.jpg');
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result.confidence, CONFIDENCE.LOW);
  assert.equal(result.reason, 'filename-hint');
});

test('classifyByFilename: room-360.png', () => {
  const result = classifyByFilename('room-360.png');
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result.confidence, CONFIDENCE.LOW);
});

test('classifyByFilename: equirect.jpeg', () => {
  const result = classifyByFilename('equirect.jpeg');
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result.confidence, CONFIDENCE.LOW);
});

test('classifyByFilename: sphere-image.jpg', () => {
  const result = classifyByFilename('sphere-image.jpg');
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
});

test('classifyByFilename: airplane.jpg (avoid false positive)', () => {
  const result = classifyByFilename('airplane.jpg');
  assert.equal(result, null);
});

test('classifyByFilename: myphoto.jpg', () => {
  const result = classifyByFilename('myphoto.jpg');
  assert.equal(result, null);
});

test('classifyByFilename: null', () => {
  const result = classifyByFilename(null);
  assert.equal(result, null);
});

// classifyByGPano tests
test('classifyByGPano: ProjectionType equirectangular', () => {
  const result = classifyByGPano({ ProjectionType: 'equirectangular' });
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result.confidence, CONFIDENCE.HIGH);
  assert.equal(result.reason, 'gpano-xmp');
});

test('classifyByGPano: GPano:ProjectionType equirectangular', () => {
  const result = classifyByGPano({ 'GPano:ProjectionType': 'equirectangular' });
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result.confidence, CONFIDENCE.HIGH);
});

test('classifyByGPano: cylindrical returns null', () => {
  const result = classifyByGPano({ ProjectionType: 'cylindrical' });
  assert.equal(result, null);
});

test('classifyByGPano: undefined', () => {
  const result = classifyByGPano(undefined);
  assert.equal(result, null);
});

test('classifyByGPano: null', () => {
  const result = classifyByGPano(null);
  assert.equal(result, null);
});

// detectImageShape integration tests
test('detectImageShape: .hdr file returns HDRI/HIGH', async () => {
  const file = makeFile('room.hdr');
  const deps = makeDeps({ size: { width: 512, height: 512 } });
  const result = await detectImageShape(file, deps);
  assert.equal(result.shape, IMAGE_SHAPE.HDRI);
  assert.equal(result.confidence, CONFIDENCE.HIGH);
  assert.equal(result.reason, 'extension:hdr/exr');
  assert.equal(result.metadata.ext, 'hdr');
});

test('detectImageShape: GPano present overrides aspect', async () => {
  const file = makeFile('pano.jpg');
  const deps = makeDeps({
    xmp: { ProjectionType: 'equirectangular' },
    size: { width: 1024, height: 512 },
  });
  const result = await detectImageShape(file, deps);
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result.confidence, CONFIDENCE.HIGH);
  assert.equal(result.reason, 'gpano-xmp');
  assert.equal(result.metadata.gpano, true);
});

test('detectImageShape: 4096×2048 without GPano returns MEDIUM', async () => {
  const file = makeFile('photo.jpg');
  const deps = makeDeps({ size: { width: 4096, height: 2048 } });
  const result = await detectImageShape(file, deps);
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result.confidence, CONFIDENCE.MEDIUM);
  assert.equal(result.reason, 'aspect-2to1');
});

test('detectImageShape: pano filename hint', async () => {
  const file = makeFile('pano_photo.jpg');
  const deps = makeDeps({ size: { width: 1024, height: 512 } });
  const result = await detectImageShape(file, deps);
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result.confidence, CONFIDENCE.LOW);
  assert.equal(result.reason, 'filename-hint');
  assert.equal(result.metadata.filenameHint, true);
});

test('detectImageShape: normal photo returns PLANE/HIGH', async () => {
  const file = makeFile('photo.jpg');
  const deps = makeDeps({ size: { width: 1920, height: 1080 } });
  const result = await detectImageShape(file, deps);
  assert.equal(result.shape, IMAGE_SHAPE.PLANE);
  assert.equal(result.confidence, CONFIDENCE.HIGH);
  assert.equal(result.reason, 'default-plane');
});

test('detectImageShape: null file', async () => {
  const deps = makeDeps();
  const result = await detectImageShape(null, deps);
  assert.equal(result.shape, IMAGE_SHAPE.UNKNOWN);
  assert.equal(result.confidence, CONFIDENCE.HIGH);
  assert.equal(result.reason, 'no-file');
});

test('detectImageShape: getImageSize throws', async () => {
  const file = makeFile('photo.jpg');
  const deps = makeDeps({ sizeThrows: true });
  const result = await detectImageShape(file, deps);
  assert.equal(result.shape, IMAGE_SHAPE.UNKNOWN);
  assert.equal(result.reason, 'image-decode-failed');
});

test('detectImageShape: exifr throws (continues with other detection)', async () => {
  const file = makeFile('pano.jpg');
  const deps = makeDeps({ exifrThrows: true, size: { width: 4096, height: 2048 } });
  const result = await detectImageShape(file, deps);
  assert.equal(result.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result.confidence, CONFIDENCE.MEDIUM);
  assert.equal(result.reason, 'aspect-2to1');
  assert.equal(result.metadata.gpano, false);
});

test('detectImageShape: includes metadata', async () => {
  const file = makeFile('photo.jpg');
  const deps = makeDeps({ alpha: true, size: { width: 2400, height: 1200 } });
  const result = await detectImageShape(file, deps);
  assert.equal(result.metadata.width, 2400);
  assert.equal(result.metadata.height, 1200);
  assert.equal(result.metadata.aspect, 2);
  assert.equal(result.metadata.hasAlpha, true);
  assert.equal(result.metadata.ext, 'jpg');
});

test('detectImageShape: aspect ratio boundary cases', async () => {
  // Just within tolerance (2:1 with 5% tolerance = 1.9 to 2.1)
  const file1 = makeFile('photo.jpg');
  const deps1 = makeDeps({ size: { width: 2048, height: 1024 } });
  const result1 = await detectImageShape(file1, deps1);
  assert.equal(result1.shape, IMAGE_SHAPE.SPHERE_INSIDE);
  assert.equal(result1.confidence, CONFIDENCE.MEDIUM);

  // Outside tolerance (1.89 aspect, below 1.9)
  const file2 = makeFile('photo.jpg');
  const deps2 = makeDeps({ size: { width: 2048, height: 1084 } });
  const result2 = await detectImageShape(file2, deps2);
  // Should not match aspect-2to1
  assert.notEqual(result2.reason, 'aspect-2to1');
});
