# AGENTS Guide

## Repository purpose
This repository hosts afjk.jp platform and related tooling for real-time scene synchronization, Loom runtime integration, FileTransfer capabilities, and supporting platform workflows (CI, staging, release, deployment, and agent operations).

## Important project areas
- **Scene Sync**: scene state synchronization, scene object operations, AI-accessible scene control, and Scene Dev Tool work.
- **Loom integration**: logic graph/runtime behavior and integration boundaries with Scene Sync.
- **FileTransfer**: room-based file transfer, fallback transport paths, and file sharing UX.
- **Platform / deployment / tooling**: CI, release, staging, deployment, repo workflow, and agent workflow support.

## Scope discipline
- Follow **one task = one issue = one PR**.
- Do not mix unrelated changes in the same PR.
- Do not add speculative refactors.
- Do not silently expand scope beyond the issue and plan.
- Keep PRs small, reviewable, and easy to revert.

## New task handling
- If you discover new work while implementing, record it as a **follow-up task**.
- Include new work in the current PR only when required to meet current acceptance criteria.
- Do not add unrelated improvements to the current PR.

## PR requirements
Each PR should include:
- Related issue
- Related plan document
- Summary
- What changed
- What was intentionally not changed
- Tests/checks run (or why not run)
- Risks
- Follow-up tasks

## Testing expectations
- Run relevant tests/checks for the changed area when available.
- If tests/checks cannot run, explain why in the PR.

## Documentation expectations
- Update documentation when behavior, public usage, or workflow changes.

## Safety rules
- Avoid touching unrelated areas.
- Avoid broad formatting-only changes.
- Avoid adding dependencies unless necessary.
- Avoid modifying application logic in repository bootstrap tasks.
- Keep changes easy to review.
