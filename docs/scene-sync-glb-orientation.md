# Scene Sync GLB orientation

Scene Sync treats imported GLB assets as authored assets.

Clients must not apply a fixed, client-specific yaw correction such as `rotateY(Math.PI)` or `rotate_y(PI)` when displaying a `meshPath` GLB.

Object orientation is represented by the Scene Sync wire `rotation` field. The GLB bytes and the authored local orientation inside the GLB should remain unchanged.

## Why

A fixed display-only yaw correction makes different clients disagree about the same object orientation. This is especially risky when Web, Godot, Unity, Blender, and AI-controlled scene updates share one room.

The correct model is:

- GLB local orientation: authored in the asset file
- Scene object orientation: represented by `rotation`
- Engine coordinate conversion: handled only at protocol import/export boundaries when required

## Compatibility note

This is a breaking display behavior change for active rooms created by older clients.

Scene Sync rooms are ephemeral and blob assets are temporary, so no persistent migration is provided.

If a GLB appears reversed after mixed-client use, refresh the room after all clients are updated or re-upload the affected GLB. Mixed-client rooms may show different orientations until all clients use the authored-orientation behavior.
