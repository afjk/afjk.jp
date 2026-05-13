import * as THREE from 'three';

export function createThreeApp() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x222222);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(5, 5, 5);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  renderer.xr.enabled = true;
  try {
    renderer.xr.setReferenceSpaceType('local-floor');
  } catch (e) {
    console.warn('[XR] setReferenceSpaceType failed:', e);
  }

  const pmremGenerator = new THREE.PMREMGenerator(renderer);

  scene.add(new THREE.AmbientLight(0xffffff, 0.3));

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);

  const grid = new THREE.GridHelper(20, 20, 0x888888, 0x666666);
  grid.userData.role = 'grid-helper';
  scene.add(grid);

  const placementFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
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
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  window.addEventListener('resize', handleResize);

  function dispose() {
    window.removeEventListener('resize', handleResize);
    pmremGenerator.dispose();
    renderer.dispose();
  }

  return {
    scene,
    camera,
    renderer,
    pmremGenerator,
    dispose,
  };
}
