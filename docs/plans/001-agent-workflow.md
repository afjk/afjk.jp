# Agent-Driven Development Workflow

## Development flow
1. **Plan**: Add/update a concise plan in `docs/plans/...`.
2. **Issue**: Create one GitHub issue for one implementation task.
3. **Branch**: Create a focused branch for that single issue.
4. **PR**: Open one PR scoped to the issue and plan.
5. **CI**: Run required checks and resolve failures.
6. **Staging**: Deploy to staging when applicable.
7. **Human verification**: Human reviewer validates behavior on staging as needed.
8. **Follow-up**: Record discovered non-scope tasks as follow-up issues.

## Handling additional tasks found during implementation
- Log newly discovered work immediately in a follow-up issue.
- Keep the current PR focused on its acceptance criteria.
- Pull in extra work only when it is required to complete current acceptance criteria.

## Task classification
- **bug**: Incorrect behavior vs expected behavior.
- **blocker**: Prevents progress on the current task.
- **follow-up**: Needed improvement not required for current acceptance criteria.
- **new idea**: Potential enhancement not yet prioritized.
- **refactor**: Structural/code-quality improvement without intended behavior change.

## Interruption rules
- Include additional work in current PR **only if required** by current acceptance criteria.
- Create a **follow-up issue** for non-blocking improvements.
- Create a **blocker issue** for work that prevents current progress.
- Mark **release blocker** when unresolved work should stop release.

## Suggested labels
- `area:scenesync`
- `area:loom`
- `area:file-transfer`
- `area:platform`
- `area:docs`
- `type:bug`
- `type:blocker`
- `type:follow-up`
- `type:new-idea`
- `type:refactor`
- `priority:now`
- `priority:next`
- `priority:later`
- `agent:ready`
- `agent:needs-plan`
- `agent:blocked`
- `needs-human`
- `release-blocker`
