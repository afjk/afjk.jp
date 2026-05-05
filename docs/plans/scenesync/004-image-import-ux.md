# Scene Sync Image Import UX

## Overview
Design for importing images into Scene Sync with automatic shape detection and optimal display.

## Auto-estimation
Images are analyzed to determine the best display format (plane, sphere-inside, or HDRI).

### Detection Logic
The system applies a priority-based detection:
1. **Extension check**: `.hdr` / `.exr` → HDRI (HIGH confidence)
2. **GPano XMP**: Equirectangular projection metadata → sphere-inside (HIGH confidence)
3. **Aspect ratio**: 2:1 ± 5% with width ≥ 2048px → sphere-inside (MEDIUM confidence)
4. **Filename hints**: `pano|360|equirect|sphere` patterns → sphere-inside (LOW confidence)
5. **Default**: Standard plane display (HIGH confidence)

Error handling: Failed image reads default to PLANE; no exceptions thrown.

## Implementation Notes (PR-A)

The image shape detector module (`image-shape-detector.js`) provides pure functions for shape classification. Exported functions include `detectImageShape` (async main entry), individual classifiers (`classifyByExtension`, `classifyByGPano`, `classifyByAspect`, `classifyByFilename`), and constants (`IMAGE_SHAPE`, `CONFIDENCE`). Tests verify all detection paths including error cases. XMP extraction is handled by the vendored exifr v7 mini bundle (`html/assets/js/vendor/exifr.mini.mjs`), which can be replaced with the actual CDN version for production. DI pattern allows easy mocking for testing; no changes to existing modules.
