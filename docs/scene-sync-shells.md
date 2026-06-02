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
