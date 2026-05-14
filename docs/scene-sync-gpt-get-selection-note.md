# Scene Sync GPT getSelection note

GPT Actions should use `runAiCommandViaGptSession` with `action: getSelection` and empty `params` to retrieve the objects currently selected by the linked browser user.

Selection is browser-local/session-local. It is not included in the normal scene snapshot.

Expected request body:

```json
{
  "sessionId": "SESSION_ID",
  "action": "getSelection",
  "params": {}
}
```

The result includes `selectedObjectIds`, `selectedObjects`, `selectedCount`, `missingObjectIds`, and `skippedObjectIds`.
