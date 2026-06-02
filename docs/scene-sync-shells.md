# Scene Sync Shell Architecture

Scene Sync UI should be replaceable without changing the scene/runtime implementation.

This document defines the first in-repository architecture for swappable UI. It is intentionally lightweight: shells are normal JavaScript modules in this repository, not an external plugin system yet.

## Terms

```text
Shell = purpose / operation model
Layout = surface-specific presentation
Input Adapter = input method
```

A shell decides what kind of experience Scene Sync is providing. A layout decides how that shell is presented on a specific surface. An input adapter decides how user input is translated into shared shell actions.

## Architecture

```text
Scene Sync Core
├─ scene runtime
├─ network sync
├─ object registry
├─ command API
├─ selection
├─ history
└─ Loomlet binding

Shells
├─ Editor Shell
│  ├─ Desktop Layout
│  ├─ Mobile Layout
│  └─ XR Layout
├─ Viewer Shell
│  ├─ Desktop Layout
│  ├─ Mobile Layout
│  └─ XR Layout
├─ Controller Shell
└─ Game / VJ / Character Shells
```

The current Scene Sync UI is the default `editor` shell. Exported static viewers already follow a similar split: viewer entry/UI is separate from viewer core. The live Scene Sync app should move in the same direction.

## Desktop, mobile, and WebXR

Desktop and mobile editing should not be separate shells by default. They are layouts inside the same `Editor Shell` because they share the same purpose: editing the scene.

WebXR is not just responsive CSS. It should be treated as an immersive layout with an XR input adapter. The purpose still determines the shell:

- `Editor Shell + XR Layout`: edit inside the scene.
- `Viewer Shell + XR Layout`: view or experience the exported/live scene.
- `Game Shell + XR Layout`: use game-like controls and HUD.
- `Controller Shell`: use a phone or another surface as an operation panel.

## Initial implementation rules

- Keep the existing UI behavior unchanged when no shell is specified.
- Use `?shell=editor` as the explicit default.
- Add experimental shells in `html/assets/js/scenesync/shells/`.
- Keep shell loading in a small registry.
- Use simple DOM modules first; do not introduce React or external UI plugin loading yet.
- Shell UI should call shared commands instead of mutating scene internals directly.

## Current v0 status

The first implementation adds:

- `shell-registry.js` for selecting an in-repository shell.
- `editor` shell that preserves the current built-in UI.
- `minimal` shell that hides the built-in editor chrome and mounts a small overlay for quick swap testing.

This is a scaffold, not the final split. Future work should move current editor UI event wiring out of `scene.js` and into `shells/editor/`, while gradually exposing stable scene commands from core.

## Editor Shell v1 structure

The Editor Shell is expanded with Layout and Input Adapter scaffolding:

### Directory structure

```text
html/assets/js/scenesync/shells/editor/
├─ editor-shell.js              (main shell entry, mounts layouts)
├─ editor-actions.js            (wrapper for core.commands)
├─ layouts/
│  ├─ desktop-editor-layout.js  (desktop UI layout)
│  ├─ mobile-editor-layout.js   (mobile UI layout)
│  └─ xr-editor-layout.js       (XR/immersive layout - placeholder)
└─ inputs/
   ├─ mouse-input-adapter.js    (mouse/pointer input - placeholder)
   ├─ touch-input-adapter.js    (touch input - placeholder)
   └─ xr-input-adapter.js       (WebXR input - placeholder)
```

### Editor Actions

`editor-actions.js` provides a command wrapper interface for the Editor Shell. The core scene.js passes `core.commands` which are then accessed via `createEditorActions(core)`. This isolates the shell from direct DOM manipulation.

Current commands:
- `openAddMenu()` - trigger object add dialog
- `undo()` / `redo()` - history navigation
- `deleteSelected()` - remove selected objects
- `exportScene()` - export to GLB/JSON
- `openHelp()` - show help dialog
- `startAiLink()` - initiate AI pairing (with isLinked state check)
- `openSceneInspector()` / `closeSceneInspector()` - scene inspector visibility
- `toggleSceneInspector()` - toggle scene inspector open/closed
- `closeMobileActionSheet()` - close mobile action sheet

### Layouts

Layouts are surface-specific presenters. The Editor Shell mounts the appropriate layout based on device mode detection (`scene-sync-device-mobile` class).

#### Desktop Layout
Wires the following buttons to editor actions:
- `#export-btn` → `exportScene()`
- `#help-btn` → `openHelp()`
- `#link-btn` → `startAiLink()`
- `#scene-inspector-toggle` → `toggleSceneInspector()`
- `#scene-inspector-close` → `closeSceneInspector()`

Note: `#add-btn` click is wired through scene.js to `openAddMenu()`. The Layout does not re-wire it to avoid double-firing with DragDropManager.

Adds `scene-sync-layout-desktop-editor` class.

#### Mobile Layout
Wires the following buttons to editor actions with mobile-specific handling (closes action sheet before executing action):
- `#mobile-export-btn` → closes sheet + `exportScene()`
- `#mobile-help-btn` → closes sheet + `openHelp()`
- `#mobile-link-open-btn` → closes sheet + `startAiLink()`
- `#mobile-dev-open-btn` → closes sheet + `toggleSceneInspector()`

Adds `scene-sync-layout-mobile-editor` class.

#### XR Layout
Placeholder for WebXR/MR editing UI. Not yet wired. Adds `scene-sync-layout-xr-editor` class.

### Input Adapters

Input adapters are currently placeholders and not wired to runtime input yet:

- **Mouse Input Adapter** (`mouse-input-adapter.js`): pointer-based controls
- **Touch Input Adapter** (`touch-input-adapter.js`): touch gesture handling
- **XR Input Adapter** (`xr-input-adapter.js`): WebXR controller/hand tracking

Future work will select and mount the appropriate adapter per device/mode and route interaction handling through adapters instead of direct DOM event listeners.

### Minimal Shell

The `minimal` shell remains experimental/testing-focused and shows how a Shell can provide a completely different UI while sharing the same core. It demonstrates the command API in action with a minimal button panel.

## Editor Shell v2: Lightweight UI Wiring

The Editor Shell has been expanded to handle lightweight UI event wiring in layouts instead of in scene.js:

**Layout responsibilities**:
- Wire desktop and mobile button click handlers to editor actions
- Close mobile action sheets before executing actions (mobile layout)
- Toggle scene inspector on click

**Remaining in scene.js**:
- Transform controls and manipulation
- Selection and multi-selection
- XR controller grab and input
- Drag & drop file import
- Scene Inspector internal editing (JSON/form modes)
- AI Link pairing dialog and state management
- Presence sync and history manager implementation

**Input Adapters**: Remain as placeholders. Not yet wired to runtime input.

This approach keeps heavy business logic in scene.js while moving lightweight UI event dispatch to the appropriate layout, improving maintainability as the shell architecture grows.

## Editor Shell v3: Add Trigger Commandization

The Add button trigger is now exposed as `core.commands.openAddMenu()`:

- `openAddMenu` is a real function in scene.js, not a `dom.addBtn.click()` wrapper
- Desktop: calls `dom.fileInput?.click()` directly (no self-click on `#add-btn`)
- Mobile: calls `openMobileActionSheet()` directly
- Editor Shell / Minimal Shell can call `core.commands.openAddMenu()` safely without recursion
- `#add-btn` click listener in scene.js delegates to `openAddMenu()` (mobile path only; DragDropManager handles the desktop click path)
- Actual file import and mobile add sheet internals remain in scene.js
