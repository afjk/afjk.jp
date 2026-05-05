# Scene Sync Image Import UX — Phase Plan & Wire Format Design

**Status**: Design Phase (PR #116 image shape detector foundation)  
**Owner**: @afjk  
**Related**: [PR #115](../../../issues/115) (image-to-plane carrier GLB), [scene-sync-spec.md](../scene-sync-spec.md), [002-ai-tool-contract.md](./002-ai-tool-contract.md)

## Background

PR #115 completed `buildPlaneGlbFromImage()` — converting 2D image files to 3D plane carriers (GLB format). This enabled Scene Sync to display standard photos as textured rectangles in 3D space. The foundation is solid, but the UX was missing **automatic shape detection**: users currently must manually choose whether to display as plane, spherical panorama, or HDRI environment.

PR #116 adds the pure function detector module (`image-shape-detector.js`) with machine-readable metadata extraction. This brief extends the vision into a phased rollout, addressing both client-side UX and the server-side scene state implications.

## Use Case Classification

**A. Shape**: What 3D geometry to apply
- **Plane** (standard): 2D photo on a rectangle (default, safe fallback)
- **Sphere-inside** (immersive): Equirectangular panorama mapped to sphere interior (e.g., 360-degree photos)
- **HDRI** (lighting): High-dynamic-range image as ambient environment light (e.g., studio/outdoor mood)

**B. Scene Relation**: How imported object relates to existing objects
- **Overlay** (replace): New import displaces or updates existing geometry
- **Additive** (merge): New object joins the scene (e.g., "add a box next to the existing table")
- **Replace-all** (reset): Clear scene, start fresh with new import

**C. Input Type**: Source and user intent
- **Drag-drop file** (this brief): User selects from filesystem; detector runs automatically
- **URL fetch** (future): User pastes a link; detector runs on download
- **Voice command** (future): "Add a pano of the room"

---

## UX Proposals

### (1) Auto-Detect + Confirmation Dialog
- Detector runs silently in background during drag-drop
- User sees result in 3D viewer immediately (provisional)
- **Confirm** button locks choice; **Cancel** reverts
- Expert users can click a **gear icon** to override shape (plane ↔ sphere ↔ hdri)
- **Pros**: Fast, no modal bloat, shape override visible
- **Cons**: Two-step UX; users may miss the confirm step

### (2) Drop Position as Intent
- Where you drop on 3D canvas encodes shape intent:
  - **Left area**: Add as plane
  - **Center area**: Auto-detect
  - **Right area**: Force sphere
- Detector runs only for center drops
- **Pros**: Single click, intuitive spatial metaphor
- **Cons**: Discovery problem (users won't know); collision detection complexity

### (3) Mini Chip UI (Recommended for Phase 1)
- After drop, a small floating **pill/chip** appears for 3 seconds
  - Example: 🖼️ **Plane** | 🌐 **Sphere** | 💡 **HDRI** (detector recommendation highlighted)
  - Tapping any option applies instantly
- Chip auto-dismisses if user doesn't interact
- **Pros**: Visible, non-modal, fast, discoverable
- **Cons**: Brief window (might miss)

### (4) Expandable Inspector Pane
- Drop → scene state updates (plane as default)
- Right-side **Inspector** panel expands showing:
  - Image metadata (width, height, aspect ratio, projection type)
  - Shape selector (radio buttons)
  - Camera position presets (e.g., "inside sphere" vs. "outside plane")
- **Pros**: All info visible, inspectable, no timeout
- **Cons**: Screen space, visual weight

---

## Recommended Approach: Hybrid (1) + (3)

**Phase 1** uses **option (3)** — auto-detect + mini chip. Fast feedback loop for users & testers.

**Reason**: Mini chip provides:
- Immediate visual confirmation of detected shape
- Non-blocking (doesn't interrupt workflow)
- Discoverable (users see options exist)
- Room to escalate to inspector (phase 2+)

---

## Wire Format Comparison

Scene Sync currently stores objects as `scene-add` messages. The shape choice affects the asset type and GLB carrier:

| Aspect | **A: Plane** | **B: Sphere-inside** | **C: HDRI** |
|--------|--------------|---------------------|----------|
| asset.type | `primitive` (legacy) | TBD: `gltf` or new | `environment` |
| asset.url / asset.primitive | n/a (texture in GLB) | glb URL or embedded | `.hdr` / `.exr` URL |
| position, rotation, scale | Standard (y-up, meters) | Ignored (fixed center) | Ignored (global) |
| scene-state impact | Per-object | Per-object (overrides camera) | **Global** (shared env) |
| Multi-user sync | Each user sees at own pose | All users see same projection | All users see same lighting |
| Conflict resolution | Newest wins (normal) | Newest wins (normal) | Last-write (env is singular) |

**Wire format decision**: We defer specifics to Phase 2 (PR-B). PR-A provides detection; wire format refinement happens in context of actual sphere GLB generation.

---

## Recommended Phase Plan

### **Phase 1: Auto-Detect + Mini Chip** (PR #116 + PR-B)
- **Deliverable**: Detector module + mini chip UI in drag-drop flow
- **Scope**: Planes only; mini chip shows sphere/HDRI options but routes both to plane for now (preview)
- **Test**: Manual - drag images, confirm chip appears, shape detection logged
- **Success**: Users see detection working; testers can observe edge cases

### **Phase 2: Sphere-Inside GLB Pipeline** (PR-C, separate team effort)
- **Deliverable**: `buildSphereGlbFromImage()` function; equirectangular → 3D sphere mesh
- **Scope**: Sphere rendering, camera control inside sphere, multi-user pose handling
- **Test**: Drag 360-degree photo, see it wrap as sphere, rotate camera
- **Success**: Immersive pano viewing works end-to-end

### **Phase 3: HDRI Environment Lighting** (PR-D, design + rendering)
- **Deliverable**: HDRI parser; environment map in THREE shader; `scene-env` broadcast
- **Scope**: `.hdr` parsing, ambient light update, user pose preservation (camera not moved)
- **Test**: Drag HDRI, see scene lighting change, other users receive env update
- **Success**: Mood/lighting can be controlled per-scene

### **Phase 4: Inspector Pane + Overrides** (PR-E, polish)
- **Deliverable**: Right-side panel; shape override radio buttons; metadata display
- **Scope**: UX enhancement; no new detection logic
- **Test**: Drop image, open inspector, click shape option, confirm change broadcasts
- **Success**: Power users can fine-tune shape choice; metadata visible for debugging

---

## Auto-Estimation Priority Rules

Detector applies these checks **in order**, stopping at first match:

1. **Extension check** (highest priority)
   - File ends in `.hdr` or `.exr` → **HDRI** / **HIGH**
   - Reason: Extension is authoritative for HDRI (non-negotiable)

2. **GPano XMP metadata**
   - EXIF/XMP field `ProjectionType === 'equirectangular'` → **SPHERE_INSIDE** / **HIGH**
   - Reason: Embedded camera metadata is reliable (e.g., from Google Streetview, Ricoh Theta)

3. **Aspect ratio heuristic**
   - Width / height ≈ 2:1 (tolerance: ±5%, i.e., ±0.05 in ratio)
   - **AND** width ≥ 2048 px (resolution threshold for meaningful panorama)
   - → **SPHERE_INSIDE** / **MEDIUM**
   - Reason: Equirectangular images are typically 2:1; 2048px is minimum for LBE quality

4. **Filename hint** (lowest priority)
   - Filename contains `pano|360|equirect|sphere` (word boundary regex, case-insensitive)
   - → **SPHERE_INSIDE** / **LOW**
   - Reason: User intent signal; may be false positive (e.g., "airplane.jpg")

5. **Default fallback**
   - No match → **PLANE** / **HIGH**
   - Reason: Safe, always-available display format

**Confidence levels**:
- **HIGH**: Detection is authoritative (proceed directly to 3D display)
- **MEDIUM**: Strong signal but not certain (show to user, allow override)
- **LOW**: Weak hint (show, but suggest alternative)

---

## Adopted Libraries

**exifr v7 mini ESM** (`html/assets/js/vendor/exifr.mini.mjs`)
- MIT license (Mike Kovařík, Mutiny.cz)
- ~30KB minified
- Purpose: Extract XMP metadata (GPano:ProjectionType) from JPEG/PNG files
- Why mini?: Smaller bundle than full exifr; we only need XMP, not EXIF/IFD
- Usage: `import parse from './vendor/exifr.mini.mjs'; await parse(file, { xmp: true })`

---

## Open Issues

1. **HEIC/HEIF support**: Safari & iPhone export as `.heic`. Cannot decode in browser without native API. Deferred to Phase 3.

2. **3D file import** (`.glb`, `.usdz`, `.obj`): Out of scope for this brief. PR #115 handles image→plane only.

3. **Conflict resolution at scale**: If 10+ users drop images simultaneously, scene state merging needs verification. Deferred to Phase 2.

4. **Camera jump on sphere entry**: When user selects sphere-inside, should camera auto-position (inside center) or warn? Deferred to Phase 2 UX design.

5. **HDRI + local objects**: Can lighting and geometry coexist? Design needed. Deferred to Phase 3.

---

## PR-A Implementation Notes

The image shape detector module (`image-shape-detector.js`) provides pure functions for shape classification. Exported API:
- **Constants**: `IMAGE_SHAPE` (PLANE, SPHERE_INSIDE, HDRI, UNKNOWN), `CONFIDENCE` (HIGH, MEDIUM, LOW)
- **Main function**: `detectImageShape(file, deps) → Promise<{ shape, confidence, reason, metadata }>`
- **Helper functions**: `classifyByExtension()`, `classifyByGPano()`, `classifyByAspect()`, `classifyByFilename()` — all pure, independently testable

**Dependency injection** (deps parameter):
- `exifr.parse(file, opts)`: Extract XMP; expects promise or undefined
- `getImageSize(file)`: Decode image dimensions; expects `{ width, height }`
- `hasAlpha(file)`: Check transparency; expects boolean

**Test coverage**: 34 test cases (node:test + node:assert) validating all detection paths, error handling, metadata extraction, aspect ratio boundaries.

**Vendor**: exifr v7 mini ESM bundled at `html/assets/js/vendor/exifr.mini.mjs` (1.6K stub, to be replaced with real bundle in CI).

**No changes to existing modules** — detector is standalone; wiring to DragDropManager deferred to PR-B.
