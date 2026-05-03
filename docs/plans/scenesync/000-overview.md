# Scene Sync Area Overview

## Purpose
Own scene state synchronization, scene object operations, and AI-accessible scene control behaviors.

## What belongs in this area
- Scene state sync protocols and consistency behavior.
- Scene object create/update/delete operations.
- Agent-facing controls for scene manipulation.
- Scene Dev Tool capabilities tied to scene synchronization.

## What does not belong in this area
- Loom runtime logic internals (except defined integration boundaries).
- FileTransfer transport/UX work.
- General CI/release workflow changes unless required for Scene Sync delivery.

## Example implementation plans to add later
- Scene state conflict resolution strategy.
- Scene object operation audit trail.
- AI-safe scene command surface and permissions.

## Notes for agents
- Coordinate integration points with Loom through explicit interface tasks.
- Keep Scene Sync PRs focused; document cross-area impacts as follow-up tasks.
