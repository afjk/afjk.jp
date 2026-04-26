import * as THREE from 'three';

export class CoordinateTransformer {
  constructor(camera, renderer, scene) {
    this.camera = camera;
    this.renderer = renderer;
    this.scene = scene;
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
  }

  screenToWorld(clientX, clientY, domElement) {
    const rect = domElement.getBoundingClientRect();

    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    if (hits.length > 0) {
      return hits[0].point.clone();
    }

    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const groundPoint = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(groundPlane, groundPoint)) {
      return groundPoint;
    }

    const fallbackPoint = new THREE.Vector3();
    this.raycaster.ray.at(5, fallbackPoint);
    return fallbackPoint;
  }

  dispose() {}
}
