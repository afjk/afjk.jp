export async function buildImageSkySphereGlb(fileOrBlob, options = {}) {
  const {
    THREE,
    GLTFExporter,
    radius = 50,
    widthSegments = 64,
    heightSegments = 32,
  } = options;

  if (!THREE) throw new Error('THREE is required');
  if (!GLTFExporter) throw new Error('GLTFExporter is required');

  const bitmap = await createImageBitmap(fileOrBlob);

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(bitmap, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.BackSide,
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
  bitmap.close?.();

  return {
    arrayBuffer,
    width: canvas.width,
    height: canvas.height,
  };
}
