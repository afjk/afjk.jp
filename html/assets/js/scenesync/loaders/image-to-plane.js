import { createImageCanvasForScene } from './image-optimizer.js';

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
export async function buildPlaneGlbFromImage(
  file,
  { THREE, GLTFExporter, maxPixel = 2048, maxEdgeMeters = 2, onOptimized } = {}
) {
  if (!THREE || !GLTFExporter) {
    throw new Error('THREE and GLTFExporter are required');
  }

  const optimized = await createImageCanvasForScene(file, {
    maxPixel,
    label: 'image-plane',
  });
  const { canvas, textureWidth, textureHeight } = optimized;
  onOptimized?.(optimized);

  // Create texture from canvas
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  // Calculate plane size
  const { width: planeWidth, height: planeHeight } = planeSizeFromImage(textureWidth, textureHeight, maxEdgeMeters);

  // Create plane geometry and material
  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  // Create mesh and wrap in Group
  const mesh = new THREE.Mesh(geometry, material);
  // Lift mesh so the bottom edge sits on the group's origin (y=0).
  // This matches the existing GLB import which grounds objects via groundOffset.
  mesh.position.y = planeHeight / 2;
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
