import { CoordinateTransformer } from '../utils/coordinate-utils.js';
import { GLBFileLoader } from '../loaders/glb-file-loader.js';
import { parseUriList, extractUrlFromText } from '../loaders/url-classifier.js';
import { generateTemporaryImageObjectId } from '../loaders/image-preview.js';
import { isSingleHtmlFile, isZipFile } from '../importers/scene-sync-export/detect-scene-sync-export.js';
import {
  convertGaussianSplatFileToGlb,
  describeGaussianSplatImportError,
  isGaussianSplatFile,
  LARGE_SOURCE_WARNING_BYTES,
  formatBytes,
} from '../loaders/gaussian-splat/gaussian-splat-file-import.js';

function isGlbFile(file) {
  return !!file && /\.glb$/i.test(file.name || '');
}

function findManagedObjectId(hitObject) {
  let obj = hitObject;
  while (obj) {
    if (obj.userData?.objectId) return obj.userData.objectId;
    obj = obj.parent;
  }
  return null;
}

function isSupportedImageFile(file) {
  if (!file) return false;
  const supportedMimes = ['image/png', 'image/jpeg', 'image/webp'];
  const supportedExts = /\.(png|jpe?g|webp)$/i;
  return supportedMimes.includes(file.type) || supportedExts.test(file.name || '');
}

function isSupportedTextFile(file) {
  if (!file) return false;
  if (file.size > 1 * 1024 * 1024) return false; // 1MB limit
  const supportedMimes = ['text/plain', 'text/markdown'];
  const supportedExts = /\.(txt|md|markdown)$/i;
  return supportedMimes.includes(file.type) || supportedExts.test(file.name || '');
}

function normalizePositionContext(input, fallbackPosition) {
  if (input?.position) {
    return {
      position: input.position,
      targetKind: input.targetKind ?? 'scene',
      clientX: input.clientX,
      clientY: input.clientY,
      upness: input.upness,
      normal: input.normal || null,
      normalArray: input.normalArray || input.normal?.toArray?.() || null,
      rawNormalArray: input.rawNormalArray || null,
      hitObjectId: input.hitObjectId || null,
      surfaceKind: input.surfaceKind || null,
      placementRotation: input.placementRotation || null,
      wallSurfaceOffset: input.wallSurfaceOffset ?? 0,
      hitPoint: input.hitPoint || null,
      placementPosition: input.placementPosition || null,
    };
  }

  // Backward compatibility: old callers pass THREE.Vector3 directly.
  if (input && typeof input.toArray === 'function') {
    return {
      position: input,
      targetKind: 'scene',
      clientX: undefined,
      clientY: undefined,
      upness: undefined,
      normal: null,
      normalArray: null,
      rawNormalArray: null,
      hitObjectId: null,
      surfaceKind: null,
      placementRotation: null,
      wallSurfaceOffset: 0,
      hitPoint: null,
      placementPosition: null,
    };
  }

  return {
    position: fallbackPosition,
    targetKind: 'scene',
    clientX: undefined,
    clientY: undefined,
    upness: undefined,
    normal: null,
    normalArray: null,
    rawNormalArray: null,
    hitObjectId: null,
    surfaceKind: null,
    placementRotation: null,
    wallSurfaceOffset: 0,
    hitPoint: null,
    placementPosition: null,
  };
}

export const SKY_DROP_UPNESS_THRESHOLD = 0.35;
const MAX_GROUND_PLANE_DISTANCE = 10;

export class DragDropManager {
  constructor(options) {
    const {
      container = document,
      camera,
      renderer,
      scene,
      fileInput,
      addBtn,
      dropOverlay,
      showToast,
      onLoaded,
      onLoadStart,
      onLoadEnd,
      getRaycastTargets,
      getPlacementTargets,
      dracoPath,
      maxDimension,
      glbLoader,
      imageImporter,
      textImporter,
      urlImporter,
      wallSurfaceOffset = 0.01,
      THREE: ThreeModule,
      getReplaceTargetForContent = null,
      sceneSyncExportImporter = null,
      gaussianSplatConverter = convertGaussianSplatFileToGlb,
      gaussianSplatUpAxisCorrection = 'none',
    } = options || {};

    if (!camera || !renderer || !scene) {
      throw new Error('必要なオプション（camera, renderer, scene）が不足しています');
    }

    this.container = container;
    this.camera = camera;
    this.renderer = renderer;
    this.scene = scene;
    this.fileInput = fileInput;
    this.addBtn = addBtn;
    this.dropOverlay = dropOverlay;
    this.showToast = showToast;
    this.onLoaded = onLoaded;
    this.onLoadStart = onLoadStart;
    this.onLoadEnd = onLoadEnd;
    this.imageImporter = imageImporter;
    this.textImporter = textImporter;
    this.urlImporter = urlImporter;
    this.getReplaceTargetForContent = getReplaceTargetForContent;
    this.sceneSyncExportImporter = sceneSyncExportImporter;
    this.gaussianSplatConverter = gaussianSplatConverter;
    this.gaussianSplatUpAxisCorrection = gaussianSplatUpAxisCorrection;
    this.wallSurfaceOffset = wallSurfaceOffset;
    this.getPlacementTargets = getPlacementTargets;
    this.THREE = ThreeModule || (globalThis.THREE || {});
    this.coordinateTransformer = new CoordinateTransformer(camera, renderer, scene, {
      getRaycastTargets,
    });
    this.glbLoader = glbLoader || new GLBFileLoader({ dracoPath, maxDimension });
    this.dragCounter = 0;
    this._isDisposed = false;

    this._boundDragEnter = this._onDragEnter.bind(this);
    this._boundDragLeave = this._onDragLeave.bind(this);
    this._boundDragOver = this._onDragOver.bind(this);
    this._boundDrop = this._onDrop.bind(this);
    this._boundFileChange = this._onFileChange.bind(this);
    this._boundAddClick = this._onAddClick.bind(this);

    this._register();
  }

  _register() {
    this.addBtn?.addEventListener('click', this._boundAddClick);
    this.fileInput?.addEventListener('change', this._boundFileChange);
    this.container?.addEventListener('dragenter', this._boundDragEnter);
    this.container?.addEventListener('dragleave', this._boundDragLeave);
    this.container?.addEventListener('dragover', this._boundDragOver);
    this.container?.addEventListener('drop', this._boundDrop);
  }

  _isFileDrag(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }

  _isUrlDrag(event) {
    const types = Array.from(event.dataTransfer?.types || []);
    return types.includes('text/uri-list') || types.includes('text/plain');
  }

  _isDraggableContent(event) {
    return this._isFileDrag(event) || this._isUrlDrag(event);
  }

  _setOverlay(active) {
    if (!this.dropOverlay) return;
    this.dropOverlay.classList.toggle('active', active);
  }

  _defaultDropPosition() {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return this.coordinateTransformer.screenToWorld(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      this.renderer.domElement
    );
  }

  _fallbackScenePositionFromClientPoint(clientX, clientY) {
    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      return this.coordinateTransformer.screenToWorld(
        clientX,
        clientY,
        this.renderer.domElement
      );
    }

    return this._defaultDropPosition();
  }

  _fallbackScenePositionFromEvent(event) {
    return this._fallbackScenePositionFromClientPoint(event?.clientX, event?.clientY);
  }

  _createDropRayFromClientPoint(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();

    const ndc = new this.THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new this.THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);

    const worldUp = new this.THREE.Vector3(0, 1, 0);
    const upness = raycaster.ray.direction.dot(worldUp);

    return {
      raycaster,
      ray: raycaster.ray,
      ndc,
      upness,
    };
  }

  _createDropRay(event) {
    return this._createDropRayFromClientPoint(event.clientX, event.clientY);
  }

  _findPlacementHit(raycaster) {
    const targets = this.getPlacementTargets?.() || [];

    if (!targets.length) return null;

    const hits = raycaster.intersectObjects(targets, true);
    return hits[0] || null;
  }

  _getWorldNormalFromHit(hit) {
    if (!hit?.face?.normal || !hit.object || !this.THREE?.Matrix3) return null;

    const normalMatrix = new this.THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
    return hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
  }

  _getSurfaceKind(normal) {
    if (!normal) return 'unknown';

    const worldUp = new this.THREE.Vector3(0, 1, 0);
    const dotUp = normal.clone().normalize().dot(worldUp);

    if (dotUp > 0.75) return 'floor';
    if (dotUp < -0.75) return 'ceiling';
    return 'wall';
  }

  _createSurfaceQuaternion(normal, rayDirection = null) {
    if (!normal) return null;

    const n = normal.clone().normalize();
    if (rayDirection && typeof rayDirection.clone === 'function') {
      const ray = rayDirection.clone().normalize();
      if (n.dot(ray) > 0) {
        n.multiplyScalar(-1);
      }
    }
    const localForward = new this.THREE.Vector3(0, 0, 1);

    return new this.THREE.Quaternion().setFromUnitVectors(localForward, n);
  }

  _orientNormalTowardRay(normal, rayDirection = null) {
    if (!normal) return null;

    const oriented = normal.clone().normalize();
    if (rayDirection && typeof rayDirection.clone === 'function') {
      const ray = rayDirection.clone().normalize();
      if (oriented.dot(ray) > 0) {
        oriented.multiplyScalar(-1);
      }
    }

    return oriented;
  }

  _nearCameraFallbackPosition(distance = 1.5) {
    const pos = new this.THREE.Vector3();
    const dir = new this.THREE.Vector3();

    this.camera.getWorldPosition(pos);
    this.camera.getWorldDirection(dir);

    return pos.addScaledVector(dir, distance);
  }

  _groundPlanePositionFromRay(ray) {
    const groundPlane = new this.THREE.Plane(new this.THREE.Vector3(0, 1, 0), 0);
    const point = new this.THREE.Vector3();

    if (ray.intersectPlane(groundPlane, point)) {
      const cameraPos = new this.THREE.Vector3();
      this.camera.getWorldPosition(cameraPos);

      if (point.distanceTo(cameraPos) <= MAX_GROUND_PLANE_DISTANCE) {
        return point;
      }
    }

    return null;
  }

  _dropPositionFromClientPoint(clientX, clientY) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return {
        position: this._defaultDropPosition(),
        targetKind: 'scene',
        clientX: undefined,
        clientY: undefined,
        upness: undefined,
      };
    }

    const rayInfo = this._createDropRayFromClientPoint(clientX, clientY);
    const hit = this._findPlacementHit(rayInfo.raycaster);
    const hitNormal = hit ? this._getWorldNormalFromHit(hit) : null;
    const surfaceKind = this._getSurfaceKind(hitNormal);
    const orientedNormal = surfaceKind === 'wall'
      ? this._orientNormalTowardRay(hitNormal, rayInfo.ray.direction)
      : hitNormal;
    const surfaceQuaternion = surfaceKind === 'wall'
      ? this._createSurfaceQuaternion(orientedNormal)
      : null;
    const wallSurfaceOffset = surfaceKind === 'wall' && orientedNormal
      ? this.wallSurfaceOffset
      : 0;
    const placementPosition = hit
      ? (wallSurfaceOffset > 0
        ? hit.point.clone().addScaledVector(orientedNormal, wallSurfaceOffset)
        : hit.point.clone())
      : null;

    const debugTargetKind = hit ? 'scene-hit' : 'scene-fallback';

    const hitObjectId = hit ? findManagedObjectId(hit.object) : null;

    this.lastDropDetection = {
      ...this.lastDropDetection,
      hit: !!hit,
      hitObject: hit?.object?.name || null,
      hitObjectType: hit?.object?.type || null,
      hitObjectId: hitObjectId || null,
      hitDistance: hit?.distance ?? null,
      upness: rayInfo.upness,
      threshold: SKY_DROP_UPNESS_THRESHOLD,
      targetKind: debugTargetKind,
      clientX,
      clientY,
      normal: orientedNormal?.toArray?.() || null,
      rawNormal: hitNormal?.toArray?.() || null,
      surfaceKind,
      placementRotation: surfaceQuaternion?.toArray?.() || null,
      wallSurfaceOffset,
      hitPoint: hit?.point?.toArray?.() || null,
      placementPosition: placementPosition?.toArray?.() || null,
    };

    console.debug('[drag-drop] drop detection', this.lastDropDetection);

    if (hit) {
      return {
        position: placementPosition || hit.point.clone(),
        normal: orientedNormal,
        normalArray: orientedNormal?.toArray?.() || null,
        rawNormalArray: hitNormal?.toArray?.() || null,
        surfaceKind,
        placementRotation: surfaceQuaternion?.toArray?.() || null,
        wallSurfaceOffset,
        hitPoint: hit.point.toArray(),
        placementPosition: (placementPosition || hit.point).toArray(),
        targetKind: 'scene',
        hitObjectId: hitObjectId || null,
        clientX,
        clientY,
        upness: rayInfo.upness,
      };
    }

    const groundPoint = this._groundPlanePositionFromRay(rayInfo.ray);
    const fallbackPosition = groundPoint || this._nearCameraFallbackPosition(1.5);

    this.lastDropDetection = {
      ...this.lastDropDetection,
      hit: false,
      targetKind: 'scene-fallback',
      fallbackKind: groundPoint ? 'ground-plane' : 'camera-near',
      fallbackDistance: groundPoint ? null : 1.5,
      placementPosition: fallbackPosition.toArray(),
      upness: rayInfo.upness,
      clientX,
      clientY,
    };

    return {
      position: fallbackPosition,
      targetKind: 'scene',
      clientX,
      clientY,
      upness: rayInfo.upness,
      fallbackKind: groundPoint ? 'ground-plane' : 'camera-near',
    };
  }

  _dropPositionFromEvent(event) {
    return this._dropPositionFromClientPoint(event?.clientX, event?.clientY);
  }

  getPlacementFromClientPoint(clientX, clientY) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return null;
    }
    return this._dropPositionFromClientPoint(clientX, clientY);
  }

  getPlacementFromPointerEvent(event) {
    if (!event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
      return null;
    }
    return this.getPlacementFromClientPoint(event.clientX, event.clientY);
  }

  async _loadFile(file, position, options = {}) {
    const { originalFile = null, sourceFormat = null } = options;
    const objectId = `web-${Math.random().toString(36).slice(2, 10)}`;
    // The overlay and the object label show the file the user actually dropped,
    // while everything downstream uses the GLB that gets uploaded.
    const displayFile = originalFile || file;
    const loadInfo = { objectId, file: displayFile, position, source: 'file' };

    if (this.onLoadStart) {
      await this.onLoadStart(loadInfo);
    }

    try {
      const model = await this.glbLoader.loadFromFile(file, position, this.scene);
      model.userData.objectId = objectId;
      model.userData.name = displayFile.name;

      if (originalFile) {
        model.userData.importedFrom = {
          fileName: originalFile.name,
          fileSize: originalFile.size,
          convertedTo: file.name,
          ...(sourceFormat ? { sourceFormat } : {}),
        };
      }

      if (this.onLoaded) {
        await this.onLoaded(model, file);
      }

      return model;
    } finally {
      if (this.onLoadEnd) {
        await this.onLoadEnd(loadInfo);
      }
    }
  }

  /**
   * Convert a dropped Gaussian Splat capture into a GLB File.
   *
   * Conversion normally runs in a Worker, but it falls back to the main thread
   * where one cannot be created, and a real capture can hold millions of
   * splats — so the toast goes up first and the work is deferred by a frame to
   * let it paint. Returns null when the file could not be converted; the
   * failure has already been reported to the user by then.
   */
  async _convertGaussianSplatFile(file) {
    if (file.size >= LARGE_SOURCE_WARNING_BYTES) {
      this.showToast?.(`Gaussian Splatを変換中… (${formatBytes(file.size)}、時間がかかる場合があります)`);
    } else {
      this.showToast?.('Gaussian Splatを変換中…');
    }

    // Yield once so the toast is on screen before the main thread is tied up.
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const result = await this.gaussianSplatConverter(file, {
        upAxisCorrection: this.gaussianSplatUpAxisCorrection,
      });

      console.debug('[drag-drop] gaussian splat converted', {
        sourceFormat: result.sourceFormat,
        splatCount: result.splatCount,
        shDegree: result.shDegree,
        sourceBytes: result.sourceBytes,
        glbBytes: result.file.size,
      });

      this.showToast?.(
        `${result.splatCount.toLocaleString()} splats を読み込み中… (SH degree ${result.shDegree})`,
      );

      return { file: result.file, sourceFormat: result.sourceFormat };
    } catch (error) {
      console.warn('[drag-drop] gaussian splat import failed:', error);
      this.showToast?.(describeGaussianSplatImportError(error));
      return null;
    }
  }

  async handleFile(file, positionContext) {
    if (this.sceneSyncExportImporter && (isZipFile(file) || isSingleHtmlFile(file))) {
      const result = await this.sceneSyncExportImporter(file, positionContext);
      if (result?.handled) return null;
    }

    const normalized = normalizePositionContext(
      positionContext,
      this._defaultDropPosition()
    );
    const surfaceKind = normalized.surfaceKind || this._getSurfaceKind(normalized.normal);
    const surfaceQuaternion = normalized.placementRotation
      ? new this.THREE.Quaternion().fromArray(normalized.placementRotation)
      : (surfaceKind === 'wall'
        ? this._createSurfaceQuaternion(normalized.normal)
        : null);
    const placementRotation = surfaceQuaternion?.toArray?.() || null;

    // Gaussian Splat captures become a KHR_gaussian_splatting GLB and then
    // follow the ordinary GLB path, so upload, broadcast and the asset cache
    // need no special case.
    if (isGaussianSplatFile(file)) {
      const converted = await this._convertGaussianSplatFile(file);
      if (!converted) return null;
      return this._loadFile(converted.file, normalized.position, {
        originalFile: file,
        sourceFormat: converted.sourceFormat,
      });
    }

    if (isGlbFile(file)) {
      return this._loadFile(file, normalized.position);
    }

    if (this.imageImporter && isSupportedImageFile(file)) {
      // Skybox intent takes priority for images when looking up.
      const imageSkybox =
        normalized.upness !== undefined &&
        normalized.upness > SKY_DROP_UPNESS_THRESHOLD;
      const effectiveTargetKind = imageSkybox ? 'sky' : normalized.targetKind;
      const effectiveSurfaceKind = imageSkybox ? 'skybox' : surfaceKind;
      const effectiveSurfaceQuaternion = imageSkybox ? null : surfaceQuaternion;
      const effectivePlacementRotation = effectiveSurfaceQuaternion?.toArray?.() || null;

      // Determine replacement target BEFORE calling onLoadStart
      let replaceTargetObjectId = null;
      if (effectiveTargetKind !== 'sky') {
        replaceTargetObjectId = this.getReplaceTargetForContent?.('image', {
          hitObjectId: normalized.hitObjectId,
          targetKind: effectiveTargetKind,
          source: 'file',
          file,
        }) || null;
      }

      const isReplacement = !!replaceTargetObjectId;
      const objectId = isReplacement ? null : generateTemporaryImageObjectId();
      const loadInfo = {
        objectId,
        file,
        position: normalized.position,
        source: 'image',
        targetKind: effectiveTargetKind,
        temporary: !isReplacement,
        normal: normalized.normal,
        normalArray: normalized.normalArray,
        surfaceKind: effectiveSurfaceKind,
        placementRotation: effectivePlacementRotation,
        placementQuaternion: effectiveSurfaceQuaternion,
      };

      // Only show toast for new additions and skybox
      // (replacements show local preview immediately, so toast is unnecessary)
      const shouldShowToast = effectiveTargetKind === 'sky' || !isReplacement;
      if (shouldShowToast) {
        const toastMessage = effectiveTargetKind === 'sky'
          ? 'Skybox画像を準備中…'
          : '画像を準備中…';
        this.showToast?.(toastMessage);
      }
      console.debug('[drag-drop] image placement', {
        targetKind: effectiveTargetKind,
        normal: normalized.normalArray,
        surfaceKind: effectiveSurfaceKind,
        placementRotation: effectivePlacementRotation,
        skyboxOverride: imageSkybox,
        isReplacement,
        replaceTargetObjectId,
      });

      // Only call onLoadStart for new additions, not replacements
      if (!isReplacement && this.onLoadStart) {
        Promise.resolve(this.onLoadStart(loadInfo)).catch((error) => {
          console.warn('[drag-drop] image onLoadStart failed:', error);
        });
      }

      try {
        await this.imageImporter(file, normalized.position, {
          targetKind: effectiveTargetKind,
          clientX: normalized.clientX,
          clientY: normalized.clientY,
          upness: normalized.upness,
          normal: normalized.normal,
          normalArray: normalized.normalArray,
          hitObjectId: normalized.hitObjectId,
          surfaceKind: effectiveSurfaceKind,
          placementQuaternion: effectiveSurfaceQuaternion,
          placementRotation: effectivePlacementRotation,
          tempObjectId: isReplacement ? null : objectId,
          replaceTargetObjectId,
          isReplacement,
        });
      } catch (error) {
        console.warn('[drag-drop] image import failed:', error);
        this.showToast?.(error?.message || '画像の追加に失敗しました');
      } finally {
        if (this.onLoadEnd) {
          await this.onLoadEnd(loadInfo);
        }
      }
      return null;
    }

    if (this.textImporter && isSupportedTextFile(file)) {
      try {
        const text = await file.text();
        await this.textImporter(text, normalized.position, file.name, {
          targetKind: normalized.targetKind,
          clientX: normalized.clientX,
          clientY: normalized.clientY,
          upness: normalized.upness,
          normal: normalized.normal,
          normalArray: normalized.normalArray,
          hitObjectId: normalized.hitObjectId,
          surfaceKind,
          placementQuaternion: surfaceQuaternion,
          placementRotation,
        });
      } catch (error) {
        console.warn('[drag-drop] text import failed:', error);
        this.showToast?.(error?.message || 'テキストの読み込みに失敗しました');
      }
      return null;
    }

    this.showToast?.('未対応のファイル形式です');
    return null;
  }

  _onAddClick() {
    this.fileInput?.click();
  }

  _onFileChange(event) {
    const file = event.target.files?.[0];
    if (file) {
      this.handleFile(file).catch((error) => {
        console.warn('[drag-drop] failed to load file:', error);
        this.showToast?.(error.message || 'GLBの読み込みに失敗しました');
      });
    }

    if (event.target) {
      event.target.value = '';
    }
  }

  _onDragEnter(event) {
    if (!this._isDraggableContent(event)) return;

    event.preventDefault();
    this.dragCounter += 1;
    this._setOverlay(true);
  }

  _onDragLeave(event) {
    if (!this._isDraggableContent(event)) return;

    event.preventDefault();
    this.dragCounter -= 1;
    if (this.dragCounter <= 0) {
      this.dragCounter = 0;
      this._setOverlay(false);
    }
  }

  _onDragOver(event) {
    if (!this._isDraggableContent(event)) return;

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  _onDrop(event) {
    event.preventDefault();
    this.dragCounter = 0;
    this._setOverlay(false);

    const dt = event.dataTransfer;
    if (!dt) return;

    const positionContext = this._dropPositionFromEvent(event);

    // URL ドロップを先に判定（files が空の場合）
    if (!dt.files || dt.files.length === 0) {
      const uriList = dt.getData('text/uri-list');
      const urls = parseUriList(uriList);
      let candidate = urls[0];
      if (!candidate) {
        candidate = extractUrlFromText(dt.getData('text/plain'));
      }
      if (candidate && this.urlImporter) {
        this.urlImporter(candidate, positionContext.position, positionContext).catch((err) => {
          console.warn('[drag-drop] url import failed:', err);
          this.showToast?.(err?.message || 'URLの追加に失敗しました');
        });
      }
      return;
    }

    // ファイルドロップ
    if (!this._isFileDrag(event)) return;

    const file = dt.files?.[0];
    if (!file) return;

    this.handleFile(file, positionContext).catch((error) => {
      console.warn('[drag-drop] failed to load dropped file:', error);
      this.showToast?.(error.message || 'GLBの読み込みに失敗しました');
    });
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.addBtn?.removeEventListener('click', this._boundAddClick);
    this.fileInput?.removeEventListener('change', this._boundFileChange);
    this.container?.removeEventListener('dragenter', this._boundDragEnter);
    this.container?.removeEventListener('dragleave', this._boundDragLeave);
    this.container?.removeEventListener('dragover', this._boundDragOver);
    this.container?.removeEventListener('drop', this._boundDrop);
    this.coordinateTransformer.dispose();
    this.glbLoader.dispose();
  }
}
