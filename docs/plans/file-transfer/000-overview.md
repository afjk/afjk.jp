# FileTransfer Area Overview

## Purpose
Own room-based file exchange capabilities including transport fallback and sharing UX.

## What belongs in this area
- File transfer session/control flow.
- Transport strategy (WebRTC/piping fallback).
- Sharing UX states (progress, retry, error handling).
- Reliability and observability for transfer flows.

## What does not belong in this area
- Scene Sync + Loom primary runtime features.
- Broad platform/release workflow changes not needed for FileTransfer.

## Example implementation plans to add later
- Room-based transfer protocol hardening.
- Fallback transport retry strategy.
- File sharing UX validation and staging test checklist.

## Notes for agents
- FileTransfer is an adjacent track, not part of the primary Scene Sync + Loom track.
- Keep cross-track dependencies explicit in issues and PR descriptions.
