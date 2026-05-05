// Plane size calculation from image dimensions
export function planeSizeFromImage(width, height, maxEdgeMeters = 2) {
  const maxPx = Math.max(width, height);
  const scale = maxEdgeMeters / maxPx;
  return {
    width: width * scale,
    height: height * scale,
  };
}

// Convert image File to carrier GLB (ArrayBuffer)
export async function buildPlaneGlbFromImage(file, { THREE, GLTFExporter, maxPixel = 4096, maxEdgeMeters = 2 } = {}) {
  if (!THREE || !GLTFExporter) {
    throw new Error('THREE and GLTFExporter are required');
  }

  // Read image as bitmap
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;

  // Downsample if exceeds maxPixel
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  if (width > maxPixel || height > maxPixel) {
    const maxDim = Math.max(width, height);
    const scale = maxPixel / maxDim;
    width = Math.floor(width * scale);
    height = Math.floor(height * scale);
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(bitmap, 0, 0, width, height);
  } else {
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(bitmap, 0, 0);
  }

  // Create texture from canvas
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  // Calculate plane size
  const { width: planeWidth, height: planeHeight } = planeSizeFromImage(width, height, maxEdgeMeters);

  // Create plane geometry and material
  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
  });

  // Create mesh and wrap in Group
  const mesh = new THREE.Mesh(geometry, material);
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

  return arrayBuffer;
}
