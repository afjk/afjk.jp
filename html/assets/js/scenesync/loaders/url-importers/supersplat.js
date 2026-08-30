import {
  LARGE_SOURCE_WARNING_BYTES,
  convertGaussianSplatFileToGlb,
  describeGaussianSplatImportError,
  formatBytes,
} from '../gaussian-splat/gaussian-splat-file-import.js';
import {
  downloadSuperSplatSource,
  resolveSuperSplatScene,
} from '../supersplat-url.js';
import {
  createSuperSplatGlbAssetMetadata,
  createSuperSplatSourceMetadata,
} from '../supersplat-metadata.js';

// splat-transform's SOG reader already produces the orientation Scene Sync
// displayed before the Worker bundle was refreshed. Baking SuperSplat's own
// presentation rotation here applies it twice and turns the GLB upside down.
const SUPERSPLAT_UP_AXIS_CORRECTION = 'none';

function sourceMetadata(resolution, conversion) {
  return {
    gaussianSplatSource: createSuperSplatSourceMetadata(resolution, conversion),
  };
}

/**
 * Import a Downloadable SuperSplat scene through SceneSync's ordinary GLB
 * upload/sync/persistence path. The SceneDocument still sees a normal GLB.
 */
export async function importSuperSplatUrl(url, ctx) {
  try {
    ctx.showToast?.('SuperSplatの公開シーンとライセンスを確認中…');
    const resolver = ctx.resolveSuperSplatScene || resolveSuperSplatScene;
    const resolution = await resolver(url, {
      fetchImpl: ctx.fetchImpl,
      resolverEndpoint: ctx.superSplatResolverEndpoint,
      signal: ctx.signal,
    });

    ctx.showToast?.(
      `SuperSplat「${resolution.title || resolution.sceneId}」を取得中… (${resolution.license.label})`,
    );
    const downloader = ctx.downloadSuperSplatSource || downloadSuperSplatSource;
    const sourceFile = await downloader(resolution, {
      fetchImpl: ctx.fetchImpl,
      ensureJSZip: ctx.ensureJSZip,
      signal: ctx.signal,
      onProgress: ({ phase, index, total }) => {
        if (phase === 'downloading' && total > 1) {
          ctx.showToast?.(`SuperSplatデータを取得中… (${index}/${total})`);
        } else if (phase === 'packaging') {
          ctx.showToast?.('SuperSplatデータを変換用に準備中…');
        }
      },
    });

    const sizeDetail = sourceFile.size >= LARGE_SOURCE_WARNING_BYTES
      ? ` (${formatBytes(sourceFile.size)}、時間がかかる場合があります)`
      : '';
    ctx.showToast?.(`Gaussian SplatをGLBへ変換中…${sizeDetail}`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const converter = ctx.convertGaussianSplatFileToGlb || convertGaussianSplatFileToGlb;
    const glbAssetMetadata = createSuperSplatGlbAssetMetadata(resolution);
    const conversion = await converter(sourceFile, {
      // Keep the decoded SOG basis. A viewer-only 180° Z correction must not
      // be baked into the portable GLB.
      upAxisCorrection: SUPERSPLAT_UP_AXIS_CORRECTION,
      glbAssetMetadata,
      signal: ctx.signal,
    });

    if (typeof ctx.importGlbFileAsSceneObject !== 'function') {
      throw new Error('SceneSync GLB file importer is unavailable');
    }

    const objectId = ctx.generateObjectId('glb');
    const spawn = ctx.getSpawnTransform();
    const displayName = (resolution.title || `SuperSplat ${resolution.sceneId}`).slice(0, 80);
    const metadata = sourceMetadata(resolution, conversion);
    const model = await ctx.importGlbFileAsSceneObject(conversion.file, {
      objectId,
      name: displayName,
      position: spawn.position,
      rotation: spawn.rotation,
      scale: spawn.scale,
      metadata,
      selectAfterLoad: true,
      signal: ctx.signal,
    });

    model.userData.importedFrom = {
      provider: 'supersplat',
      pageUrl: resolution.pageUrl,
      sourceFileName: sourceFile.name,
      sourceFileSize: sourceFile.size,
      convertedTo: conversion.file.name,
      sourceFormat: conversion.sourceFormat,
    };

    ctx.showToast?.(
      `${conversion.splatCount.toLocaleString()} splats を追加しました (${resolution.license.label})`,
    );
    return { objectId, model, resolution, conversion };
  } catch (error) {
    console.warn('[supersplat-url] import failed:', error);
    const message = error?.name === 'UnsupportedSplatInputError'
      ? describeGaussianSplatImportError(error)
      : (error?.message || 'SuperSplatの読み込みに失敗しました');
    ctx.showToast?.({ type: 'error', message });
    return null;
  }
}
