import { CoordinateTransformer } from '../utils/coordinate-utils.js';
import { GLBFileLoader } from '../loaders/glb-file-loader.js';
import { parseUriList, extractUrlFromText } from '../loaders/url-classifier.js';

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
      dracoPath,
      maxDimension,
      glbLoader,
      imageImporter,
      textImporter,
      urlImporter,
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

  _dropPositionFromEvent(event) {
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      return this.coordinateTransformer.screenToWorld(
        event.clientX,
        event.clientY,
        this.renderer.domElement
      );
    }

    return this._defaultDropPosition();
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

  async handleFile(file, position) {
    if (isGlbFile(file)) {
      return this._loadFile(file, position || this._defaultDropPosition());
    }

    if (this.imageImporter && isSupportedImageFile(file)) {
      const dropPos = position || this._defaultDropPosition();
      try {
        await this.imageImporter(file, dropPos);
      } catch (error) {
        console.warn('[drag-drop] image import failed:', error);
        this.showToast?.(error?.message || '画像の読み込みに失敗しました');
      }
      return null;
    }

    if (this.textImporter && isSupportedTextFile(file)) {
      const dropPos = position || this._defaultDropPosition();
      try {
        const text = await file.text();
        await this.textImporter(text, dropPos, file.name);
      } catch (error) {
        console.warn('[drag-drop] text import failed:', error);
        this.showToast?.(error?.message || 'テキストの読み込みに失敗しました');
      }
      return null;
    }

    this.showToast?.('GLB / 画像 / テキストファイルのみ対応しています');
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

    // URL ドロップを先に判定（files が空の場合）
    if (!dt.files || dt.files.length === 0) {
      const uriList = dt.getData('text/uri-list');
      const urls = parseUriList(uriList);
      let candidate = urls[0];
      if (!candidate) {
        candidate = extractUrlFromText(dt.getData('text/plain'));
      }
      if (candidate && this.urlImporter) {
        const dropPos = this._dropPositionFromEvent(event) || this._defaultDropPosition();
        this.urlImporter(candidate, dropPos).catch((err) => {
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

    this.handleFile(file, this._dropPositionFromEvent(event)).catch((error) => {
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
