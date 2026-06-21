# Scene Sync Rapier

Optional Unity bridge that runs Scene Sync browser physics with
`com.afjk.rapier`.

This package intentionally sits downstream of both packages:

- `com.afjk.scene-sync` owns network, objects, and wire metadata.
- `com.afjk.rapier` owns Rapier world APIs and native plugins.
- `com.afjk.scene-sync-rapier` maps Scene Sync `physics` JSON into Rapier bodies.

## Install For Local Testing

Add all three packages to the Unity project manifest while Rapier is not yet in
`upm.afjk.jp`:

```json
{
  "dependencies": {
    "com.afjk.scene-sync": "file:/Users/afjk/github/SceneSyncWork/afjk.jp/unity/com.afjk.scene-sync",
    "com.afjk.scene-sync-rapier": "file:/Users/afjk/github/SceneSyncWork/afjk.jp/unity/com.afjk.scene-sync-rapier",
    "com.afjk.rapier": "https://github.com/afjk/rapier-unity.git?path=Packages/com.afjk.rapier#v0.3.0"
  }
}
```

For monorepo development you can replace the Rapier Git URL with a local
`file:` path.

## Usage

1. Add `SceneSyncRapierBridge` to the same GameObject as `SceneSyncManager`.
2. Connect to a room that has Scene Sync `physics` enabled in the Web client.
3. When scene objects contain object-level `physics`, Unity creates a Rapier
   world and applies dynamic body poses back to the corresponding GameObjects.

The bridge uses Scene Sync wire coordinates as the physics basis, then converts
body poses back to Unity coordinates when applying transforms.
