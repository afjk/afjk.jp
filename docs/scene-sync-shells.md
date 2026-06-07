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

## Player Shell

Player Shell is an experimental shell for Scene Clock transport controls.

- URL: `/scenesync/?shell=player`
- Purpose: operate Scene Clock with Play / Pause / Stop / Seek / Rate
- It does not directly edit scene objects
- It does not directly control AudioSource yet
- GLB animations and Loomlet behaviors can follow Scene Clock
- AudioSource full transport sync is future work

### Directory structure

```text
html/assets/js/scenesync/shells/player/
├─ player-shell.js    (main shell entry, mounts transport UI)
├─ player-actions.js  (thin wrapper over core.commands)
└─ player-shell.css   (transport panel styles, hides editor chrome)
```

### Scene Clock commands

Player Shell calls these commands via `core.commands`:

| Command | Behaviour |
|---|---|
| `playSceneClock()` | Resume if paused; switch to local mode if host-follow |
| `pauseSceneClock()` | Freeze time |
| `stopSceneClock()` | Seek to 0 then pause |
| `seekSceneClock(t)` | Jump to `t` seconds in local mode |
| `setSceneClockRate(r)` | Set playback rate (0.25 / 0.5 / 1 / 2) |
| `resetSceneClock()` | Seek to 0 and continue playing |

State is read via `core.getSceneClockState()`:

```js
{
  time: number,    // current time in seconds
  isPaused: boolean,
  playing: boolean,
  mode: 'local' | 'host-follow',
  rate: number,
  duration: number,
}
```

### UI update loop

Player Shell runs a `requestAnimationFrame` loop for smooth time display. The loop is started on `mount()` and cancelled on `unmount()`.

## Editor Shell v4: Edit command + state API and chrome wiring migration

The Editor Shell shell-ization is completed by exposing the remaining edit operations as commands and by moving editor chrome wiring out of `scene.js` into the layouts. The standard Editor Shell no longer exposes Edit/Interact switching; it mounts in `edit` input routing mode.

### New edit commands (`core.commands`)

| Command | Behaviour |
|---|---|
| `setTransformMode(mode)` | Switch gizmo mode: `'translate' \| 'rotate' \| 'scale'` |
| `duplicateSelected()` | Duplicate the selected object |
| `deselect()` | Clear the current selection |

These join the existing commands (`openAddMenu`, `undo`, `redo`, `deleteSelected`, `exportScene`, `openHelp`, `startAiLink`, `open/close/toggleSceneInspector`, `closeMobileActionSheet`, scene-clock transport).

Input routing remains a core capability for shell-specific controls: `setInputRoutingMode(mode)` is still exposed by core for Viewer / Studio / future shells that intentionally switch between `'edit'` and `'interact'`. It is not wrapped as a standard Editor action, and the standard Editor does not expose an input-routing mode switch.

### Edit state snapshot (`core.getEditorState()`)

Any shell can read a unified edit-state snapshot and re-render on `core.onStateChange`:

```js
{
  transformMode: 'translate' | 'rotate' | 'scale',
  inputRoutingMode: 'edit' | 'interact',
  selectedCount: number,
  selectedObjectIds: string[],
  selectionLabel: string,
  objectCount: number,   // user-visible objects (excludes sample-cube etc.)
  canUndo: boolean,
  canRedo: boolean,
}
```

`scene.js` fires `notifySceneSyncShellStateChanged(reason)` on transform-mode, input-routing-mode, history, selection and connection changes so subscribers stay in sync.

### Chrome wiring migration

- The standard Editor has no mode button and does not wire Edit/Interact switching.
- `editor-shell.js` resets input routing to `'edit'` when the standard Editor mounts so state from Viewer / Studio does not leak back into editing.
- `mobile-editor-layout.js` now wires the transform toolbar (`#btn-move/rotate/scale/copy/delete/deselect`) → editor actions.
- The corresponding `addEventListener` calls were removed from `scene.js` to avoid double-firing.

**Remaining in core (`scene.js`)**: transform gizmo, raycast selection, toolbar state notifications (`showToolbar`/`hideToolbar`/`updateToolbarActive`, enable/disable on selection), input routing state for shell-specific controls, drag & drop, Inspector internal editing, AI Link pairing, presence/history implementation. The W/E/R keyboard shortcuts also remain in `scene.js` (input-adapter migration is future work).

> Dev note: editor shell modules are loaded via dynamic `import()`. After editing them, a normal reload may serve a cached module; use a hard reload (Cmd/Ctrl+Shift+R) during development.

## Studio Shell

Studio Shell is a light-user-oriented Edit shell: intuitive enough to use without a manual, and inviting to touch. It is a self-contained shell (like minimal/player) that builds its own DOM/CSS, hides the built-in editor chrome, and drives everything through the command + state API — it does not touch scene internals.

- URL: `/scenesync/?shell=studio`
- Target: casual / light users
- Built entirely on Editor Shell v4's `core.commands` + `core.getEditorState()`

### Directory structure

```text
html/assets/js/scenesync/shells/studio/
├─ studio-shell.js    (DOM construction + state subscription)
├─ studio-actions.js  (thin wrapper over core.commands)
└─ studio-shell.css   (panel styles, hides editor chrome)
```

### Design direction

Soft-modern (Apple/Notion-like): dark neutral glass surfaces, a single calm-blue accent, thin line (SVG) icons, restrained motion, single-layer shadows. English labels (kept short) — chosen over hiragana to avoid a childish tone.

### UI

- **Mode pill (top center)**: `✎ Edit | ▷ Play` — always shows the current Edit/Interact mode (`setInputRoutingMode`). Active segment uses a soft accent fill + thin border (not a solid block).
- **Selection card (appears when something is selected)**: object name, a 3-way tool toggle `Move / Rotate / Scale` with line icons (highlights `transformMode`), `Duplicate` (single-selection only), `Delete` (soft red), `✕` deselect, and `Details ›` → Scene Inspector.
- **Bottom dock (always visible)**: rounded-square `undo / redo` (disabled per `canUndo/canRedo`), a central calm-blue circular `+` (Add, primary CTA), and a `⋯` menu popover (Properties / Export / AI Link / Help).
- **Empty-state hint**: when `objectCount === 0`, a subtle neutral chip above the `+` ("Tap + to add") fades in to invite the first action (no bounce/pulse).

Icons are inline line SVGs defined in an `ICON` map in `studio-shell.js`. State is read via `core.getEditorState()` and the panel re-renders on `core.onStateChange`. All actions go through `core.commands` (no direct scene mutation).

> Status: experimental design prototype. Visual direction and labels may change based on feedback.

## Core API contract (v1)

Scene Sync Core (`scene.js`) exposes a stable surface to shells via `mountSceneSyncShellFromDom({...})`. Shells must use only this surface and must not touch scene internals.

### `core.commands`

| Command | Behaviour |
|---|---|
| `openAddMenu()` | Open the add-object flow (desktop file picker / mobile sheet) |
| `undo()` / `redo()` | History navigation |
| `deleteSelected()` | Delete the current selection |
| `duplicateSelected()` | Duplicate the selected object |
| `deselect()` | Clear the selection |
| `setTransformMode(mode)` | `'translate' \| 'rotate' \| 'scale'` |
| `setInputRoutingMode(mode)` | `'edit' \| 'interact'`; for Viewer / Studio / shell-specific controls, not exposed by the standard Editor |
| `setEnvironment(envId)` | Change & broadcast HDRI environment |
| `resetView()` | Reset orbit camera to default |
| `exportScene()` / `openHelp()` / `startAiLink()` | Misc editor actions |
| `openSceneInspector()` / `closeSceneInspector()` / `toggleSceneInspector()` | Inspector visibility |
| `closeMobileActionSheet()` | Close mobile add sheet |
| `playSceneClock()` / `pauseSceneClock()` / `stopSceneClock()` / `seekSceneClock(t)` / `setSceneClockRate(r)` / `resetSceneClock()` | Scene Clock transport |

### State (read + subscribe)

- `core.getEditorState()` → `{ transformMode, inputRoutingMode, selectedCount, selectedObjectIds, selectionLabel, objectCount, environmentId, toolbarVisible, canUndo, canRedo }`
- `core.getSelection()` → selection payload (`objectIds`, serialized objects)
- `core.getConnectionState()` → `{ connected, room, peerCount, label }`
- `core.getSceneClockState()` → Scene Clock snapshot (see Player Shell)
- `core.onStateChange(listener)` → subscribe; returns unsubscribe. Core fires on selection / transform-mode / input-routing / history / connection / toolbar-visibility / environment changes.

### `core.input` (consumed by Input Adapters)

| Member | Purpose |
|---|---|
| `getCanvas()` | The WebGL canvas element to attach listeners to |
| `isDragging()` / `isPasteMode()` | Gating flags |
| `selectAt(x, y, event)` | Raycast-select at client coords (respects edit/interact) |
| `pointerMove(x, y)` / `clearHover()` | Hover (Loomlet host) updates |
| `pasteMoveFromPointer(e)` / `commitPasteClick()` | Paste-preview placement |
| `handleEmptyTapDeselect(x, y)` | Touch single-tap empty → deselect |
| `shouldIgnoreShortcut(e)` | True when focus is in an input/editable |
| `copySelection()` / `pasteToggle()` / `handleEscape()` | Keyboard intents (return whether to `preventDefault`) |

## Input Adapter architecture

Raw DOM input wiring lives in adapters, not in `scene.js`. Adapters translate events into `core.input` / `core.commands` calls and never touch scene internals.

```text
html/assets/js/scenesync/shells/editor/inputs/
├─ pointer-input-adapter.js    (canvas pointer: select / hover / paste placement)
├─ touch-input-adapter.js      (tap / double-tap gestures)
├─ editor-keyboard-adapter.js  (edit shortcuts: C/V, Undo/Redo, W/E/R, Escape, Delete)
└─ xr-input-adapter.js         (placeholder; XR grab handled in core for now)
```

- Contract: `createXInputAdapter()` → `{ id, name, mount({core}), unmount() }`. `mount` attaches listeners (to `core.input.getCanvas()` / `window`) and records disposers; `unmount` removes them.
- **Pointer vs. keyboard are separate adapters by design.** Pointer/touch only do selection, hover and camera-precursor input — safe for any shell. The editor keyboard adapter carries the *edit* shortcuts and must only be mounted by edit-capable shells.
- **Mounting**: `shell-bootstrap.js` mounts `pointer` + `touch` for every shell that shows the scene. It mounts `editor-keyboard` **only when `shell.inputs` includes `'keyboard'`** (editor / studio). Viewer / player / minimal therefore get selection + camera but **no** edit shortcuts — keyboard delete / undo / paste / transform cannot fire there even if a selection lingers.
- **Camera & XR stay in core**: OrbitControls and the WebXR controller grab remain owned by `scene.js` (shared by all shells); they are not part of the adapter layer yet.

## Editor chrome fully shell-owned (v4 follow-up)

`scene.js` no longer writes editor DOM. `shells/editor/editor-chrome.js` renders `#mobile-toolbar` and `#history-toolbar` (visibility / active / disabled) from `getEditorState()` and wires undo/redo clicks. Both desktop and mobile editor layouts mount it. Core keeps only the *state* (`editorToolbarVisible` + notifications), not the DOM.

## Viewer Shell

Viewer Shell is a viewing-focused, self-contained shell.

- URL: `/scenesync/?shell=viewer`
- Hides all editor chrome; defaults to Play (`interact`) input routing on mount.
- UI: a connection badge (top-left), and a bottom dock with **Reset View** (`resetView`) and an **environment cycle** button (`setEnvironment`, label from `environmentId`).
- Built entirely on the Core API; canvas selection / camera work via the shared input adapters.

```text
html/assets/js/scenesync/shells/viewer/
├─ viewer-shell.js
└─ viewer-shell.css
```

## Shell completion status

The shell architecture is now feature-complete for swappable UI + input:

- Core exposes a documented command / state / input contract.
- Editor chrome (visual state) is fully owned by the editor shell.
- Canvas + keyboard input is provided by swappable adapters mounted per session.
- Shipping shells: `editor` (default), `studio` (light-user edit), `viewer` (viewing), plus experimental `minimal` and `player`.

Remaining future work (not blocking): per-shell adapter selection (instead of always mounting both), moving OrbitControls/XR into the adapter layer, and additional purpose shells (Game / VJ / Controller).
