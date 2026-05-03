# afjk.jp Roadmap

## 1) Primary Track: Scene Sync + Loom
- **Purpose**: Deliver stable scene synchronization and runtime logic integration for core experiences.
- **Example tasks**: Scene object sync reliability, Scene Sync APIs for agents, Loom runtime integration points, authoring/runtime boundary fixes.
- **Current priority**: **Now (highest)**.
- **Do not mix into this track**: FileTransfer feature work, broad CI/deployment changes unless directly required.

## 2) Adjacent Track: FileTransfer
- **Purpose**: Support reliable room-based file sharing with fallback transport paths and practical UX.
- **Example tasks**: transfer session lifecycle, WebRTC/piping fallback handling, upload/share progress and error states.
- **Current priority**: **Next (parallel but separate)**.
- **Do not mix into this track**: Scene Sync + Loom runtime behavior changes, unrelated platform refactors.

## 3) Platform Track: Release, CI, Staging, Agent Workflow
- **Purpose**: Keep delivery pipelines, staging validation, and repo workflow predictable for human + agent collaboration.
- **Example tasks**: CI workflow hardening, staging deploy checks, release checklists, issue/PR templates, agent operation docs.
- **Current priority**: **Now (enabler)**.
- **Do not mix into this track**: Product feature implementation unrelated to workflow/platform support.

## 4) Future Track: Advanced Authoring + AI Tooling
- **Purpose**: Expand editor capabilities and advanced tooling after core tracks stabilize.
- **Example tasks**: richer editor UI, node graph editor UX, advanced AI-assisted scene tooling.
- **Current priority**: **Later**.
- **Do not mix into this track**: Immediate delivery blockers from primary/adjacent/platform tracks.
