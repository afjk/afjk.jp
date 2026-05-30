# Scene Sync Loomlet Runtime Vendoring

Issue: <https://github.com/afjk/loomlet/issues/263>

## Current Runtime Source

Loomlet is the source of truth for Scene Sync behavior graph playback. The pinned browser runtime is vendored from:

```text
../loomlet/dist/loomlet-scenesync-runtime.browser.js
```

into:

```text
html/assets/vendor/loomlet/0.3.0/loomlet-scenesync-runtime.browser.js
```

Update it with:

```sh
node scripts/update-loomlet-runtime.mjs ../loomlet
```

The update script rejects bundles with ESM imports, DSL compiler references, CDN references, afjk.jp references, or presence-server references.

## Runtime API

The current Loomlet bundle exports:

```js
createSceneSyncRuntime
evaluateSceneSyncGraph
createSceneSyncBehaviorHost
listSceneSyncRuntimeNodeTypes
LoomletSceneSyncRuntime
LoomletSceneSyncRuntimeError
LoomletSceneSyncRuntimeVersion
```

Scene Sync imports the pinned runtime through a small app integration wrapper. The exported viewer imports the pinned bundle copied into the ZIP at:

```text
viewer/loomlet/loomlet-scenesync-runtime.browser.js
```

## Export Metadata

Exported `scene.json` records the runtime used for behavior playback:

```json
{
  "loomletRuntime": {
    "version": "0.1.2",
    "graphVersion": "scene-sync-graph-json-v1",
    "adapter": "scenesync"
  }
}
```
