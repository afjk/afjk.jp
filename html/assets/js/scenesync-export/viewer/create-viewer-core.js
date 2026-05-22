import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { isValidSceneDocument } from './scene-document.js';
import { createStaticAssetResolver } from './static-asset-resolver.js';
import { Loom } from './loom/loom.js';
import { LoomSceneSync } from './loom/loom-scenesync.js';

const DRACO_DECODER_PATH = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/';

function buildPrimitive(assetDef) {
  const color = assetDef.color || '#888888';
  const mat = new THREE.MeshStandardMaterial({ color });

  let geo;
  switch (assetDef.primitive) {
    case 'sphere':   geo = new THREE.SphereGeometry(0.5, 32, 16); break;
    case 'cylinder': geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); break;
    case 'cone':     geo = new THREE.ConeGeometry(0.5, 1, 32); break;
    case 'plane':    geo = new THREE.PlaneGeometry(1, 1); break;
    case 'torus':    geo = new THREE.TorusGeometry(0.5, 0.2, 16, 64); break;
    default:         geo = new THREE.BoxGeometry(1, 1, 1);
  }

  return new THREE.Mesh(geo, mat);
}

function applyTransform(obj, entry) {
  if (Array.isArray(entry.position) && entry.position.length >= 3) {
    obj.position.fromArray(entry.position);
  }
  if (Array.isArray(entry.rotation) && entry.rotation.length >= 4) {
    obj.quaternion.fromArray(entry.rotation);
  }
  if (Array.isArray(entry.scale) && entry.scale.length >= 3) {
    obj.scale.fromArray(entry.scale);
  }
  if (entry.visible === false) {
    obj.visible = false;
  }
}

function setupAnimation(mixer, gltf, animState) {
  const clips = gltf.animations;
  if (!Array.isArray(clips) || clips.length === 0) return null;
  if (animState && animState.enabled === false) return null;

  const clipIndex = Number.isInteger(animState?.clip) ? animState.clip : 0;
  const safeIndex = Math.max(0, Math.min(clipIndex, clips.length - 1));
  const clip = clips[safeIndex];

  const action = mixer.clipAction(clip);
  action.reset();

  const mode = animState?.mode === 'once' ? THREE.LoopOnce : THREE.LoopRepeat;
  action.setLoop(mode, Infinity);
  action.clampWhenFinished = mode === THREE.LoopOnce;

  const speed = Number.isFinite(animState?.speed) ? animState.speed : 1;
  action.timeScale = speed;

  action.play();
  return action;
}

export async function createViewerCore({
  scene,
  renderer,
  pmremGenerator,
  sceneDoc,
  onMissingAsset,
  onProgress,
}) {
  if (!isValidSceneDocument(sceneDoc)) {
    throw new Error('Invalid scene document');
  }

  const resolver = createStaticAssetResolver();
  const mixers = [];
  const clock = new THREE.Clock();
  const objectMap = new Map();

  // Ambient + directional lights as fallback
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);

  // GLB loader with Draco
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
  const gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);

  // Load environment (HDRI)
  let envLoaded = false;
  if (sceneDoc.skybox?.asset?.path) {
    try {
      const rgbeLoader = new RGBELoader();
      const texture = await rgbeLoader.loadAsync(resolver.resolveAsset(sceneDoc.skybox.asset));
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const envMap = pmremGenerator.fromEquirectangular(texture).texture;
      scene.environment = envMap;
      scene.background = envMap;
      texture.dispose();
      envLoaded = true;
    } catch {
      onMissingAsset?.({ kind: 'skybox', path: sceneDoc.skybox.asset.path });
    }
  }

  if (!envLoaded) {
    scene.background = new THREE.Color(0x222233);
  }

  const total = sceneDoc.objects.length;
  let loaded = 0;

  // Load scene objects
  for (const entry of sceneDoc.objects) {
    const assetDef = entry.asset;

    if (!assetDef || assetDef.type === 'primitive') {
      const mesh = buildPrimitive(assetDef || {});
      applyTransform(mesh, entry);
      mesh.userData.objectId = entry.id;
      scene.add(mesh);
      objectMap.set(entry.id, mesh);
    } else if (assetDef.type === 'image') {
      const assetPath = resolver.resolveAsset(assetDef);
      if (!assetPath) {
        onMissingAsset?.({ id: entry.id, kind: 'image', reason: 'no path or url' });
        loaded++;
        onProgress?.(loaded / total);
        continue;
      }

      try {
        const texture = await new THREE.TextureLoader().loadAsync(assetPath);
        texture.colorSpace = THREE.SRGBColorSpace;

        const aspect = (texture.image.width / texture.image.height) || 1;
        const maxEdge = 2;
        const w = aspect >= 1 ? maxEdge : Math.max(maxEdge * aspect, 0.1);
        const h = aspect >= 1 ? Math.max(maxEdge / aspect, 0.1) : maxEdge;

        const geo = new THREE.PlaneGeometry(w, h);
        const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = h / 2; // align origin to bottom edge, matching web runtime

        const group = new THREE.Group();
        group.add(mesh);
        applyTransform(group, entry);
        group.userData.objectId = entry.id;
        scene.add(group);
        objectMap.set(entry.id, group);
      } catch {
        onMissingAsset?.({ id: entry.id, kind: 'image', path: assetPath });
      }
    } else if (assetDef.type === 'video') {
      const assetPath = resolver.resolveAsset(assetDef);
      if (!assetPath) {
        onMissingAsset?.({ id: entry.id, kind: 'video', reason: 'no path or url' });
        loaded++;
        onProgress?.(loaded / total);
        continue;
      }

      try {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';

        // Wait for real dimensions before building geometry
        await new Promise((resolve, reject) => {
          video.addEventListener('loadedmetadata', resolve, { once: true });
          video.addEventListener('error', () => reject(new Error('video load error')), { once: true });
          video.src = assetPath;
        });

        const aspect = (video.videoWidth / video.videoHeight) || (16 / 9);
        const maxEdge = 2;
        const videoW = aspect >= 1 ? maxEdge : Math.max(maxEdge * aspect, 0.1);
        const videoH = aspect >= 1 ? Math.max(maxEdge / aspect, 0.1) : maxEdge;

        const texture = new THREE.VideoTexture(video);
        texture.colorSpace = THREE.SRGBColorSpace;

        const geo = new THREE.PlaneGeometry(videoW, videoH);
        const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = videoH / 2; // align origin to bottom edge, matching web runtime

        const group = new THREE.Group();
        group.add(mesh);
        applyTransform(group, entry);
        group.userData.objectId = entry.id;
        scene.add(group);
        objectMap.set(entry.id, group);

        video.autoplay = true;
        video.play().catch(() => {});
      } catch {
        onMissingAsset?.({ id: entry.id, kind: 'video', path: assetPath });
      }
    } else if (assetDef.type === 'text') {
      const FONT_PRESETS = {
        'system-sans':    'system-ui, -apple-system, "Segoe UI", sans-serif',
        'serif':          'Georgia, "Times New Roman", serif',
        'monospace':      '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        'japanese-sans':  'system-ui, -apple-system, "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif',
        'japanese-serif': '"Hiragino Mincho ProN", "Yu Mincho", serif',
      };

      let text = '';
      if (assetDef.source === 'inline') {
        text = assetDef.text || '';
      } else {
        const assetPath = resolver.resolveAsset(assetDef);
        if (assetPath) {
          try {
            const res = await fetch(assetPath);
            if (res.ok) text = await res.text();
          } catch {}
        }
      }

      const fontSize = assetDef.fontSize || 32;
      const fontFamily = FONT_PRESETS[assetDef.fontFamily] || FONT_PRESETS['system-sans'];
      const fontWeight = assetDef.fontWeight || 'normal';
      const fontStyle = assetDef.fontStyle || 'normal';
      const color = assetDef.color || '#ffffff';
      const bgColor = assetDef.backgroundColor || 'rgba(0,0,0,0.65)';
      const align = assetDef.align || 'center';

      const cw = 1024, ch = 256;
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx2d = canvas.getContext('2d');

      ctx2d.clearRect(0, 0, cw, ch);
      ctx2d.fillStyle = bgColor;
      ctx2d.fillRect(0, 0, cw, ch);

      ctx2d.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
      ctx2d.fillStyle = color;
      ctx2d.textAlign = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
      ctx2d.textBaseline = 'middle';

      const lines = text.split('\n');
      const lineHeight = fontSize * 1.2;
      const startY = (ch - lines.length * lineHeight) / 2 + lineHeight / 2;
      const x = align === 'left' ? 20 : align === 'right' ? cw - 20 : cw / 2;
      for (let i = 0; i < lines.length; i++) {
        ctx2d.fillText(lines[i], x, startY + i * lineHeight);
      }

      const texture = new THREE.CanvasTexture(canvas);
      const geo = new THREE.PlaneGeometry(2, 0.5); // 4:1 canvas aspect (1024×256)
      const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = 0.5 / 2; // align origin to bottom edge, matching web runtime

      const group = new THREE.Group();
      group.add(mesh);
      applyTransform(group, entry);
      group.userData.objectId = entry.id;
      scene.add(group);
      objectMap.set(entry.id, group);
    } else {
      const assetPath = resolver.resolveAsset(assetDef);
      if (!assetPath) {
        onMissingAsset?.({ id: entry.id, kind: 'mesh', reason: 'no path' });
        loaded++;
        onProgress?.(loaded / total);
        continue;
      }

      try {
        const gltf = await gltfLoader.loadAsync(assetPath);

        if (assetDef.visualBasis === 'unity') {
          gltf.scene.rotation.y = Math.PI;
        }

        const wrapper = new THREE.Group();
        wrapper.add(gltf.scene);
        applyTransform(wrapper, entry);
        wrapper.userData.objectId = entry.id;
        scene.add(wrapper);
        objectMap.set(entry.id, wrapper);

        if (Array.isArray(gltf.animations) && gltf.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(wrapper);
          setupAnimation(mixer, gltf, entry.animation);
          mixers.push(mixer);
        }
      } catch {
        onMissingAsset?.({ id: entry.id, kind: 'mesh', path: assetPath });
      }
    }

    loaded++;
    onProgress?.(loaded / total);
  }

  // BGM setup - returns control object
  let bgmAudio = null;
  let bgmReady = false;
  if (sceneDoc.bgm?.asset?.path) {
    const bgmPath = resolver.resolveAsset(sceneDoc.bgm.asset);
    if (bgmPath) {
      bgmAudio = new Audio(bgmPath);
      bgmAudio.loop = sceneDoc.bgm.loop !== false;
      bgmAudio.volume = Math.max(0, Math.min(1, sceneDoc.bgm.volume ?? 1));
      bgmAudio.preload = 'auto';
      bgmReady = true;
    }
  }

  // Loomlet behavior graph runtime
  let loomAdapter = null;
  if (sceneDoc.behaviors) {
    loomAdapter = new LoomSceneSync({
      LoomClass: Loom,
      send: () => {},
      getServerTime: () => performance.now() / 1000,
      getObjectRuntimeTime: (_objectId, now) => now / 1000,
      resolveTarget: (targetId) => objectMap.get(targetId) || null,
      isObjectBeingEdited: () => false,
    });

    loomAdapter.importState(sceneDoc.behaviors);
    loomAdapter.start();
  }

  const api = {
    update() {
      const delta = clock.getDelta();
      for (const m of mixers) m.update(delta);

      if (loomAdapter) {
        loomAdapter.tickObjectGraphs(performance.now());
      }
    },

    getBgmAudio() {
      return bgmReady ? bgmAudio : null;
    },

    dispose() {
      dracoLoader.dispose();
      bgmAudio?.pause();
      loomAdapter?.dispose?.();
    },
  };

  return api;
}
