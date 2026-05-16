# Scene Sync Unity Authoring Model

This document records the design distinction between Unity Editor authoring mode and Unity Runtime / Player mode for Scene Sync.

Scene Sync Unity has two different usage modes:

1. Unity Editor authoring mode
2. Unity Runtime / Player viewer mode

These modes intentionally have different ownership and lifetime rules.

---

## Summary

| Mode | Role | Object lifetime | Remote delete behavior |
|---|---|---|---|
| Unity Editor | Authoring tool | Unity Hierarchy objects are originals | Unpublish / disconnect only. Do not destroy the GameObject. |
| Unity Runtime / Player | Temporary Scene Sync participant | Synced objects are temporary | Destroy locally when removed from Scene Sync. |

---

## Unity Editor authoring mode

Unity Editor is treated as an authoring environment.

A GameObject that already exists in the Unity Hierarchy is considered a source object owned by the Unity project. Publishing it to Scene Sync exposes that object to Web, VR, AI tools, and other participants, but Scene Sync does not become the owner of the Unity object.

Therefore:

- Unity-authored GameObjects are originals.
- Scene Sync publish makes them visible to other clients.
- Web / remote deletion should remove the object from Scene Sync, but must not destroy the Unity GameObject.
- After remote deletion, the Unity object should return to an unpublished / disconnected state.
- The same Unity object can be published again later.

This behavior is important for using Scene Sync as a production tool inside existing Unity projects, especially for LBE / MR authoring where objects are adjusted while checking alignment with a real space.

### Identity rules in Editor

`SceneSyncIdentity.ObjectId` is the shared Scene Sync object identifier.

It is the ID used in wire payloads such as:

```json
{
  "kind": "scene-delta",
  "objectId": "unity-...",
  "position": [0, 0, 0]
}
```

Editor-only duplicate detection uses Unity's built-in `GlobalObjectId` to determine whether two `SceneSyncIdentity` components belong to different Unity objects.

`GlobalObjectId` is not used as the Scene Sync `ObjectId`. It is only an Editor-side ownership / duplicate detection aid.

### Unity Duplicate / Copy-Paste behavior

Unity duplicates serialized component fields when a GameObject is duplicated. This means duplicating a GameObject with `SceneSyncIdentity` also copies the existing `ObjectId`.

Scene Sync must repair this before publish.

Expected behavior:

1. Original GameObject keeps its existing `SceneSyncIdentity.ObjectId`.
2. Duplicated GameObject initially has the copied `ObjectId`.
3. Before publishing the duplicate, EditorWindow detects that the same `ObjectId` is already used by a different Unity object.
4. The duplicate receives a new `unity-<guid>` ObjectId.
5. Both objects can then be published and synced independently.

This avoids adding a custom LocalId. The Unity Editor already has a suitable local identity mechanism through `GlobalObjectId`.

---

## Unity Runtime / Player mode

Unity Runtime / Player is treated as a temporary Scene Sync participant, similar to the Web client.

Runtime is not considered the authoring source of the Unity project scene. It usually does not save edited GameObjects back into the Unity scene, and it does not need to protect existing project objects in the same way as the Editor.

Therefore:

- Runtime-synced objects are temporary.
- Objects received from Scene Sync may be created locally.
- Remote / Web deletion may destroy the corresponding local GameObject.
- Runtime does not need Editor-only `GlobalObjectId` duplicate repair.
- Runtime should not depend on `UnityEditor` APIs.

If a future Runtime workflow needs persistent authoring semantics, it should be designed separately instead of reusing the Editor authoring rules implicitly.

---

## Origin and temporary semantics

The current intended semantics are:

```text
SceneSyncOrigin.Unity:
  Unity Editor-authored original object.
  Temporary = false.
  Remote deletion unpublishes/disconnects it but does not destroy it.

SceneSyncOrigin.Remote:
  Temporary object created from Scene Sync/Web/remote source.
  Temporary = true.
  Remote deletion may destroy it locally.
```

The important point is that `Unity` origin means "Unity Editor authored original", not merely "running inside Unity".

---

## Practical implications

### Do

- Use `SceneSyncIdentity.ObjectId` as the shared Scene Sync object ID.
- Use `GlobalObjectId` only in Editor code to detect duplicated Unity objects.
- Repair duplicated ObjectIds before publishing from the EditorWindow.
- Keep Unity-authored objects in the Hierarchy when they are deleted remotely.
- Treat Runtime/Player objects as temporary unless a future feature explicitly defines persistent Runtime authoring.

### Do not

- Do not add a custom LocalId unless there is a clear need beyond what `GlobalObjectId` already provides in Editor.
- Do not use `GlobalObjectId` as the Scene Sync wire `objectId`.
- Do not reference `UnityEditor` APIs from Runtime assemblies.
- Do not destroy Unity Editor-authored GameObjects just because a remote participant sent `scene-remove`.
- Do not assume every object running in Unity is Unity-authored.

---

## Why this distinction exists

Scene Sync is used both as:

- a lightweight shared 3D scene / WebXR tool, and
- a Unity authoring support tool for existing Unity projects.

In the Web-style temporary scene, deletion means deletion.

In Unity Editor authoring, deletion from Scene Sync means "stop publishing this Unity project object". The source object must remain because the Unity project is the production source of truth.

Keeping this distinction explicit prevents future regressions where Web operations accidentally destroy Unity project assets or where Runtime-only behavior complicates the Editor authoring model.
