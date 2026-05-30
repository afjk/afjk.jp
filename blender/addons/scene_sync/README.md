# Scene Sync Blender Addon

Blender authoring addon for Scene Sync.

This is intentionally an authoring integration, not a runtime integration. It does not include a Blender runtime/player equivalent to Unity Runtime.

## Install

Copy `blender/addons/scene_sync` into Blender's addons directory, then enable **Scene Sync** from Blender Preferences.

The panel appears in:

```text
View3D > Sidebar > Scene Sync
```

## Workflow

1. Connect to `wss://afjk.jp/presence`.
2. Set a room if needed.
3. Select Blender mesh roots and run **選択を Publish**.
4. Move, rotate, scale, rename, or hide published objects to send `scene-delta`.
5. Use **選択を Unpublish** to remove published objects from Scene Sync without deleting the Blender source object.

Connecting never publishes Blender objects by itself. Objects become visible to other Scene Sync clients only after an explicit publish action.

The publish unit is one selected hierarchy root. If a parent and its children are selected at the same time, only the highest selected parent is published, and its children are included in the same GLB carrier instead of becoming separate Scene Sync objects.

Blender source objects are protected. If another client sends `scene-remove` for a Blender-authored object, the addon unpublishes it locally but does not delete it from the `.blend` scene.

## Wire Model

The addon follows the current Scene Sync carrier asset model:

- `origin: "blender"` for Blender-authored objects
- `asset.type: "mesh"`
- `asset.source: "carrier"`
- `asset.meshPath`
- `asset.assetId`
- `asset.mime: "model/gltf-binary"`
- explicit `visible`

GLB carrier files are exported as shape-only assets. Placement stays in the Scene Sync wire transform.

## Animation

Animation export is enabled by default.

When a published object has Action, NLA, Armature, material, or shape-key animation, the addon exports those animations into the GLB carrier and sends the initial Scene Sync animation state:

```json
{
  "animation": {
    "enabled": true,
    "clip": 0,
    "mode": "loop",
    "speed": 1
  }
}
```

The addon does not run a Blender runtime. Animation playback happens in clients that support GLB animation, such as the Scene Sync web viewer. Root placement is still controlled by Scene Sync wire transforms.
