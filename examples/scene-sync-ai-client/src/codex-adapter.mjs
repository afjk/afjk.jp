export async function handleCodexFunctionCall(toolCall, client) {
  const name = toolCall?.name;
  const args = toolCall?.arguments || {};

  switch (name) {
    case 'scene_sync_redeem':
      return client.redeem(args.code);
    case 'scene_sync_get_scene':
      return client.getScene(args.roomId, args.sessionId);
    case 'scene_sync_broadcast':
      return client.broadcast(args.roomId, args.sessionId, args.payload);
    case 'scene_sync_ai_command':
      return client.aiCommand(
        args.roomId,
        args.sessionId,
        args.action,
        args.params || {}
      );
    case 'scene_sync_revoke':
      return client.revoke(args.sessionId);
    default:
      throw new Error(`Unknown Codex/OpenAI function: ${name}`);
  }
}
