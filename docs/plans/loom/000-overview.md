# Loom Area Overview

## Purpose
Own Loom logic graph/runtime behavior and integration with Scene Sync at clear boundaries.

## What belongs in this area
- Loom runtime execution model and node behavior.
- Logic graph evaluation flow.
- Contracted integration points with Scene Sync.
- Runtime-authoring boundary rules.

## What does not belong in this area
- Scene Sync internals outside integration contracts.
- FileTransfer feature work.
- Platform pipeline/process changes unless Loom delivery requires them.

## Example implementation plans to add later
- Loom runtime lifecycle and scheduling improvements.
- Scene Sync integration contract hardening.
- Runtime-authoring boundary validation.

## Notes for agents
- Treat Loom and Scene Sync as related but separate.
- Capture contract changes explicitly and avoid silent cross-area scope growth.
