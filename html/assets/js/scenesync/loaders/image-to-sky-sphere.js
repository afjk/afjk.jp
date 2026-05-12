import { createImageCanvasForScene } from './image-optimizer.js';

export async function buildImageSkySphereGlb(fileOrBlob, options = {}) {
  const {
    THREE,
    GLTFExporter,
    radius = 50,
    widthSegments = 64,
    heightSegments = 32,
    maxPixel = 4096,
    onOptimized,
  } = options;

  if (!THREE) throw new Error('THREE is required');
  if (!GLTFExporter) throw new Error('GLTFExporter is required');

  const optimized = await createImageCanvasForScene(fileOrBlob, {
    maxPixel,
    label: 'sky-sphere',
  });
  const { canvas } = optimized;
  onOptimized?.(optimized);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
  // GLB化後も内側から見えるように、面の向きをジオメトリ側で反転する
  geometry.scale(-1, 1, 1);
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.FrontSide,
  });

  const sphere = new THREE.Mesh(geometry, material);
  sphere.name = 'sky-sphere';

  const scene = new THREE.Scene();
  scene.add(sphere);

  const exporter = new GLTFExporter();

  const arrayBuffer = await new Promise((resolve, reject) => {
    exporter.parse(
      scene,
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

  texture.dispose?.();
  geometry.dispose?.();
  material.dispose?.();

  return {
    arrayBuffer,
    width: optimized.textureWidth,
    height: optimized.textureHeight,
    originalWidth: optimized.originalWidth,
    originalHeight: optimized.originalHeight,
    optimized: optimized.resized,
    maxPixel: optimized.maxPixel,
  };
}
