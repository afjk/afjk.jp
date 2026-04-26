import * as THREE from 'three';

export class CoordinateTransformer {
  constructor(camera, renderer, scene, options = {}) {
    this.camera = camera;
    this.renderer = renderer;
    this.scene = scene;
    this.getRaycastTargets = options.getRaycastTargets;
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
  }

  screenToWorld(clientX, clientY, domElement) {
    const rect = domElement.getBoundingClientRect();

    if (!rect.width || !rect.height) {
      return this._fallbackPoint();
    }

    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    const targets = this._getValidRaycastTargets();
    if (targets.length > 0) {
      const hits = this.raycaster.intersectObjects(targets, true);
      if (hits.length > 0) {
        return hits[0].point.clone();
      }
    }

    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const groundPoint = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(groundPlane, groundPoint)) {
      return groundPoint;
    }

    return this._fallbackPoint();
  }

  _getValidRaycastTargets() {
    const targets = this.getRaycastTargets?.();
    if (!Array.isArray(targets)) return [];
    return targets.filter(Boolean);
  }

  _fallbackPoint() {
    const fallbackPoint = new THREE.Vector3();
    this.raycaster.ray.at(5, fallbackPoint);
    return fallbackPoint;
  }

  dispose() {}
}
