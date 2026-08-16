import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SH_C0 = 0.2820947917738781;

const positions = [
  [-0.6, -0.4, 0.0], [0.0, -0.4, 0.0], [0.6, -0.4, 0.0],
  [-0.6, 0.2, 0.0], [0.0, 0.2, 0.0], [0.6, 0.2, 0.0],
  [-0.3, 0.8, 0.0], [0.3, 0.8, 0.0],
];
const rotations = Array.from({ length: 8 }, () => [0, 0, 0, 1]);
const scales = [
  [0.18, 0.10, 0.06], [0.14, 0.14, 0.06], [0.10, 0.18, 0.06],
  [0.20, 0.10, 0.06], [0.15, 0.15, 0.06], [0.10, 0.20, 0.06],
  [0.17, 0.11, 0.06], [0.11, 0.17, 0.06],
];
const opacities = Array.from({ length: 8 }, () => [0.95]);
const colors = [
  [1.0, 0.2, 0.2], [0.2, 1.0, 0.2], [0.2, 0.4, 1.0],
  [1.0, 0.8, 0.2], [0.8, 0.2, 1.0], [0.2, 1.0, 1.0],
  [1.0, 0.5, 0.1], [0.9, 0.9, 0.9],
];
const sh0 = colors.map((rgb) => rgb.map((channel) => (channel - 0.5) / SH_C0));

function align4(value) {
  return (value + 3) & ~3;
}

function flatten(values) {
  return values.flatMap((value) => value);
}

function float32Bytes(values) {
  const array = new Float32Array(flatten(values));
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

const sources = [
  ['POSITION', positions, 'VEC3'],
  ['ROTATION', rotations, 'VEC4'],
  ['SCALE', scales, 'VEC3'],
  ['OPACITY', opacities, 'SCALAR'],
  ['SH0', sh0, 'VEC3'],
];

const binaryParts = [];
const bufferViews = [];
const accessors = [];
const accessorByName = new Map();
let binaryLength = 0;

for (const [name, values, type] of sources) {
  const alignedOffset = align4(binaryLength);
  if (alignedOffset > binaryLength) {
    binaryParts.push(Buffer.alloc(alignedOffset - binaryLength));
    binaryLength = alignedOffset;
  }

  const bytes = float32Bytes(values);
  binaryParts.push(bytes);
  const bufferView = bufferViews.length;
  bufferViews.push({ buffer: 0, byteOffset: binaryLength, byteLength: bytes.byteLength });

  const accessor = {
    bufferView,
    byteOffset: 0,
    componentType: 5126,
    count: values.length,
    type,
  };
  if (name === 'POSITION') {
    accessor.min = [0, 1, 2].map((axis) => Math.min(...positions.map((p) => p[axis])));
    accessor.max = [0, 1, 2].map((axis) => Math.max(...positions.map((p) => p[axis])));
  }

  accessorByName.set(name, accessors.length);
  accessors.push(accessor);
  binaryLength += bytes.byteLength;
}

const binary = Buffer.concat(binaryParts);
const gltf = {
  asset: { version: '2.0', generator: 'SceneSync Issue #526 minimal KHR_gaussian_splatting fixture' },
  extensionsUsed: ['KHR_gaussian_splatting'],
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'MinimalGaussianSplats' }],
  meshes: [{
    name: 'MinimalGaussianSplats',
    primitives: [{
      mode: 0,
      attributes: {
        POSITION: accessorByName.get('POSITION'),
        'KHR_gaussian_splatting:ROTATION': accessorByName.get('ROTATION'),
        'KHR_gaussian_splatting:SCALE': accessorByName.get('SCALE'),
        'KHR_gaussian_splatting:OPACITY': accessorByName.get('OPACITY'),
        'KHR_gaussian_splatting:SH_DEGREE_0_COEF_0': accessorByName.get('SH0'),
      },
      extensions: {
        KHR_gaussian_splatting: {
          kernel: 'ellipse',
          colorSpace: 'srgb_rec709_display',
          projection: 'perspective',
          sortingMethod: 'cameraDistance',
        },
      },
    }],
  }],
  buffers: [{ byteLength: binary.byteLength }],
  bufferViews,
  accessors,
};

const jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
const paddedJsonLength = align4(jsonBytes.byteLength);
const paddedBinLength = align4(binary.byteLength);
const totalLength = 12 + 8 + paddedJsonLength + 8 + paddedBinLength;
const glb = Buffer.alloc(totalLength);
let offset = 0;

glb.writeUInt32LE(0x46546c67, offset); offset += 4;
glb.writeUInt32LE(2, offset); offset += 4;
glb.writeUInt32LE(totalLength, offset); offset += 4;
glb.writeUInt32LE(paddedJsonLength, offset); offset += 4;
glb.writeUInt32LE(0x4e4f534a, offset); offset += 4;
jsonBytes.copy(glb, offset);
glb.fill(0x20, offset + jsonBytes.byteLength, offset + paddedJsonLength);
offset += paddedJsonLength;
glb.writeUInt32LE(paddedBinLength, offset); offset += 4;
glb.writeUInt32LE(0x004e4942, offset); offset += 4;
binary.copy(glb, offset);

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(currentDir, '../html/scenesync/experiments/fixtures/minimal-khr-gaussian-splatting.glb');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, glb);
console.log(`${outputPath} (${glb.byteLength} bytes)`);
