import { CoordinateTransformer } from '../utils/coordinate-utils.js';
import { GLBFileLoader } from '../loaders/glb-file-loader.js';
import { parseUriList, extractUrlFromText } from '../loaders/url-classifier.js';
import { generateTemporaryImageObjectId } from '../loaders/image-preview.js';

function isGlbFile(file) {
  return !!file && /\.glb$/i.test(file.name || '');
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
    };
  }

  return {
    position: fallbackPosition,
    targetKind: 'scene',
    clientX: undefined,
    clientY: undefined,
    upness: undefined,
  };
}

const SKY_DROP_UPNESS_THRESHOLD = 0.35;

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
      THREE: ThreeModule,
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

  _fallbackScenePositionFromEvent(event) {
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      return this.coordinateTransformer.screenToWorld(
        event.clientX,
        event.clientY,
        this.renderer.domElement
      );
    }

    return this._defaultDropPosition();
  }

  _createDropRay(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();

    const ndc = new this.THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
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

  _findPlacementHit(raycaster) {
    const targets = this.getPlacementTargets?.() || [];

    if (!targets.length) return null;

    const hits = raycaster.intersectObjects(targets, true);
    return hits[0] || null;
  }

  _dropPositionFromEvent(event) {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
      return {
        position: this._defaultDropPosition(),
        targetKind: 'scene',
        clientX: undefined,
        clientY: undefined,
        upness: undefined,
      };
    }

    const rayInfo = this._createDropRay(event);
    const hit = this._findPlacementHit(rayInfo.raycaster);

    const debugTargetKind = hit
      ? 'scene-hit'
      : rayInfo.upness > SKY_DROP_UPNESS_THRESHOLD
        ? 'sky'
        : 'scene-fallback';

    this.lastDropDetection = {
      hit: !!hit,
      hitObject: hit?.object?.name || null,
      hitObjectType: hit?.object?.type || null,
      hitDistance: hit?.distance ?? null,
      upness: rayInfo.upness,
      threshold: SKY_DROP_UPNESS_THRESHOLD,
      targetKind: debugTargetKind,
      clientX: event.clientX,
      clientY: event.clientY,
    };

    console.debug('[drag-drop] drop detection', this.lastDropDetection);

    if (hit) {
      return {
        position: hit.point.clone(),
        targetKind: 'scene',
        clientX: event.clientX,
        clientY: event.clientY,
        upness: rayInfo.upness,
      };
    }

    if (rayInfo.upness > SKY_DROP_UPNESS_THRESHOLD) {
      return {
        position: this._defaultDropPosition(),
        targetKind: 'sky',
        clientX: event.clientX,
        clientY: event.clientY,
        upness: rayInfo.upness,
      };
    }

    return {
      position: this._fallbackScenePositionFromEvent(event),
      targetKind: 'scene',
      clientX: event.clientX,
      clientY: event.clientY,
      upness: rayInfo.upness,
    };
  }

  async _loadFile(file, position) {
    const objectId = `web-${Math.random().toString(36).slice(2, 10)}`;
    const loadInfo = { objectId, file, position, source: 'file' };

    if (this.onLoadStart) {
      await this.onLoadStart(loadInfo);
    }

    try {
      const model = await this.glbLoader.loadFromFile(file, position, this.scene);
      model.userData.objectId = objectId;
      model.userData.name = file.name;

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

  async handleFile(file, positionContext) {
    const normalized = normalizePositionContext(
      positionContext,
      this._defaultDropPosition()
    );

    if (isGlbFile(file)) {
      return this._loadFile(file, normalized.position);
    }

    if (this.imageImporter && isSupportedImageFile(file)) {
      const objectId = generateTemporaryImageObjectId();
      const loadInfo = {
        objectId,
        file,
        position: normalized.position,
        source: 'image',
        targetKind: normalized.targetKind,
        temporary: true,
      };

      const toastMessage = normalized.targetKind === 'sky'
        ? 'Skybox画像を準備中…'
        : '画像を準備中…';
      this.showToast?.(toastMessage);
      if (this.onLoadStart) {
        await this.onLoadStart(loadInfo);
      }

      try {
        await this.imageImporter(file, normalized.position, {
          targetKind: normalized.targetKind,
          clientX: normalized.clientX,
          clientY: normalized.clientY,
          upness: normalized.upness,
          tempObjectId: objectId,
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
