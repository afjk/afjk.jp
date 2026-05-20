export function createStaticAssetResolver() {
  return {
    resolveAsset(asset) {
      if (!asset || !asset.path) return null;
      return asset.path;
    },
  };
}
