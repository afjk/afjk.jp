import * as THREE from 'three';
import { createSceneSyncRendererOptions } from '../../scenesync-export/viewer/three-runtime.js';

const GRID_SIZE = 20;
const GRID_DIVISIONS = 20;
const PLACEMENT_FLOOR_SIZE = 100;

export async function createThreeApp() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x222222);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(5, 5, 5);
  // 立体視メディアの左目メッシュ（layer 1）を非XR表示でも見せる。
  // WebXR 中は three.js が左目カメラに layer 1、右目カメラに layer 2 を割り当てる。
  camera.layers.enable(1);

  // Scene state must remain usable when neither WebGPU nor WebGL2 is available.
  // Never expose a partially initialized renderer to the editor.
  let renderer = null;
  let pmremGenerator = null;
  let renderingError = null;
  let rendererInitialized = false;
  try {
    renderer = new THREE.WebGPURenderer(createSceneSyncRendererOptions({ antialias: true }));
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    await renderer.init();
    rendererInitialized = true;
    renderer.xr.enabled = true;
    try {
      renderer.xr.setReferenceSpaceType('local-floor');
    } catch (e) {
      console.warn('[XR] setReferenceSpaceType failed:', e);
    }
    pmremGenerator = new THREE.PMREMGenerator(renderer);
  } catch (error) {
    renderingError = error;
    // In this pinned Three.js, dispose() calls async setAnimationLoop(null),
    // which retries a rejected init and leaks an unhandled rejection. A failed
    // backend never starts a render loop; discard its unattached canvas instead.
    try {
      if (rendererInitialized) renderer.dispose();
      renderer?.domElement.remove();
    } catch (disposeError) {
      console.warn('[rendering] failed to dispose unavailable renderer:', disposeError);
    }
    renderer = null;
    console.warn('[rendering] unavailable; continuing with scene state and presence:', error);
  }

  // Controls need a DOM target even without a renderer. It is never used as an
  // image source or an interactive viewport in state-only mode.
  const viewport = renderer?.domElement || document.createElement('canvas');
  viewport.hidden = !renderer;
  document.body.appendChild(viewport);

  scene.add(new THREE.AmbientLight(0xffffff, 0.3));

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);

  const grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS, 0x888888, 0x666666);
  grid.userData.role = 'grid-helper';
  scene.add(grid);

  const placementFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(PLACEMENT_FLOOR_SIZE, PLACEMENT_FLOOR_SIZE),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
  );
  placementFloor.name = 'Placement Floor';
  placementFloor.rotation.x = -Math.PI / 2;
  placementFloor.position.y = 0;
  placementFloor.visible = true;
  placementFloor.userData.role = 'placement-floor';
  placementFloor.userData.isPlacementTarget = true;
  placementFloor.userData.nonSerializable = true;
  scene.add(placementFloor);

  function handleResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer?.setSize(window.innerWidth, window.innerHeight);
  }

  window.addEventListener('resize', handleResize);

  let animationFrame = null;
  let disposed = false;
  function setAnimationLoop(callback) {
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    animationFrame = null;
    if (disposed) return;
    if (renderer) {
      renderer.setAnimationLoop(callback);
    } else if (callback) {
      // Clocks, tweens, physics and Loomlets run independently of drawing.
      const tick = time => {
        animationFrame = window.requestAnimationFrame(tick);
        callback(time, null);
      };
      animationFrame = window.requestAnimationFrame(tick);
    }
  }

  function dispose() {
    if (disposed) return;
    setAnimationLoop(null);
    disposed = true;
    window.removeEventListener('resize', handleResize);
    pmremGenerator?.dispose();
    renderer?.dispose();
    viewport.remove();
  }

  return {
    scene,
    camera,
    renderer,
    pmremGenerator,
    viewport,
    renderingError,
    setAnimationLoop,
    dispose,
  };
}
