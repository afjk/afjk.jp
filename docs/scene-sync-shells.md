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
├─ editor-shell.css
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
- `startAiLink()` - initiate AI pairing
- `openSceneInspector()` / `closeSceneInspector()` - scene inspector visibility

### Layouts

Layouts are surface-specific presenters. The Editor Shell mounts the appropriate layout based on device mode detection (`scene-sync-device-mobile` class).

- **Desktop Layout**: adds `scene-sync-layout-desktop-editor` class. Currently wraps existing desktop UI.
- **Mobile Layout**: adds `scene-sync-layout-mobile-editor` class. Currently wraps existing mobile UI.
- **XR Layout**: adds `scene-sync-layout-xr-editor` class. Placeholder for WebXR/MR editing UI.

### Input Adapters

Input adapters are placeholders for future input event routing:

- **Mouse Input Adapter** (`mouse-input-adapter.js`): pointer-based controls
- **Touch Input Adapter** (`touch-input-adapter.js`): touch gesture handling
- **XR Input Adapter** (`xr-input-adapter.js`): WebXR controller/hand tracking

These are currently mounted but inactive. Future work will route interaction handling through adapters instead of direct DOM event listeners.

### Minimal Shell

The `minimal` shell remains experimental/testing-focused and shows how a Shell can provide a completely different UI while sharing the same core. It demonstrates the command API in action with a minimal button panel.
