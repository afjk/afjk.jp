import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

function toVector3(position) {
  if (!position) return null;
  if (position.isVector3) return position.clone();
  if (Array.isArray(position) && position.length >= 3) {
    return new THREE.Vector3(position[0], position[1], position[2]);
  }
  return null;
}

export class GLBFileLoader {
  constructor(options = {}) {
    this.maxDimension = options.maxDimension ?? 10;
    this.dracoPath = options.dracoPath ?? '/draco/';
    this.dracoLoader = null;
    this.gltfLoader = this._createGLTFLoader();
  }

  _createGLTFLoader() {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(this.dracoPath);
    this.dracoLoader = dracoLoader;

    const gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(dracoLoader);
    return gltfLoader;
  }

  _load(url) {
    return new Promise((resolve, reject) => {
      this.gltfLoader.load(url, resolve, undefined, reject);
    });
  }

  _buildModel(gltf, position) {
    const wrapper = new THREE.Group();
    wrapper.add(gltf.scene);
    gltf.scene.rotateY(Math.PI);

    wrapper.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrapper);
    const size = box.getSize(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);

    if (maxDimension > this.maxDimension) {
      wrapper.scale.setScalar(this.maxDimension / maxDimension);
      wrapper.updateMatrixWorld(true);
    }

    const adjustedBox = new THREE.Box3().setFromObject(wrapper);
    const groundOffset = -adjustedBox.min.y;
    const targetPosition = toVector3(position) || new THREE.Vector3();
    targetPosition.y += groundOffset;
    wrapper.position.copy(targetPosition);

    const metadata = {
      id: globalThis.crypto?.randomUUID?.() || `glb_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      fileName: null,
      fileSize: null,
      addedAt: Date.now(),
      position: {
        x: wrapper.position.x,
        y: wrapper.position.y,
        z: wrapper.position.z,
      },
      scale: {
        x: wrapper.scale.x,
        y: wrapper.scale.y,
        z: wrapper.scale.z,
      },
      rotation: {
        x: wrapper.quaternion.x,
        y: wrapper.quaternion.y,
        z: wrapper.quaternion.z,
        w: wrapper.quaternion.w,
      },
      type: 'glb',
      source: 'url',
    };

    wrapper.userData = {
      ...wrapper.userData,
      dropRaycastTarget: true,
      scenesync: {
        ...wrapper.userData?.scenesync,
        glbMetadata: metadata,
      },
    };

    return { wrapper, metadata };
  }

  async loadFromUrl(url, position, scene, onLoaded) {
    if (!url || !scene) {
      throw new Error('必要なパラメータが不足しています');
    }

    const gltf = await this._load(url);
    const { wrapper, metadata } = this._buildModel(gltf, position);
    scene.add(wrapper);

    if (onLoaded) {
      await onLoaded(wrapper, metadata);
    }

    return wrapper;
  }

  async loadFromFile(file, position, scene, onLoaded) {
    if (!file || !scene) {
      throw new Error('必要なパラメータが不足しています');
    }

    const objectURL = URL.createObjectURL(file);

    try {
      const model = await this.loadFromUrl(objectURL, position, scene);
      const metadata = model.userData?.scenesync?.glbMetadata;
      if (metadata) {
        metadata.fileName = file.name;
        metadata.fileSize = file.size;
        metadata.source = 'file';
      }
      if (onLoaded) {
        await onLoaded(model, metadata);
      }
      return model;
    } catch (error) {
      throw new Error(`GLBファイル "${file.name}" の読み込みに失敗: ${error.message}`);
    } finally {
      URL.revokeObjectURL(objectURL);
    }
  }

  dispose() {
    this.dracoLoader?.dispose?.();
  }
}
