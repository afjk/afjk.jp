export async function handleClaudeToolCall(name, input, client) {
  switch (name) {
    case 'scene_sync_redeem':
      return client.redeem(input.code);
    case 'scene_sync_get_scene':
      return client.getScene(input.roomId, input.sessionId);
    case 'scene_sync_broadcast':
      return client.broadcast(input.roomId, input.sessionId, input.payload);
    case 'scene_sync_ai_command':
      return client.aiCommand(
        input.roomId,
        input.sessionId,
        input.action,
        input.params || {}
      );
    case 'scene_sync_revoke':
      return client.revoke(input.sessionId);
    default:
      throw new Error(`Unknown Claude tool: ${name}`);
  }
}
