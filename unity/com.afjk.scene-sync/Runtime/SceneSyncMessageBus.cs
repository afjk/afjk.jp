using System;

namespace Afjk.SceneSync
{
    public readonly struct SceneSyncRawMessage
    {
        public SceneSyncRawMessage(string rawJson, string fromPeerId, object source)
        {
            RawJson = rawJson;
            FromPeerId = fromPeerId;
            Source = source;
        }

        public string RawJson { get; }
        public string FromPeerId { get; }
        public object Source { get; }
    }

    public readonly struct SceneSyncOutgoingMessage
    {
        public SceneSyncOutgoingMessage(string payloadJson, string targetPeerId, object source)
        {
            PayloadJson = payloadJson;
            TargetPeerId = targetPeerId;
            Source = source;
        }

        public string PayloadJson { get; }
        public string TargetPeerId { get; }
        public object Source { get; }
        public bool IsHandoff => !string.IsNullOrWhiteSpace(TargetPeerId);
    }

    public static class SceneSyncMessageBus
    {
        public static event Action<SceneSyncRawMessage> MessageReceived;
        public static event Action<SceneSyncOutgoingMessage> MessageRequested;

        public static void PublishReceived(string rawJson, string fromPeerId = null, object source = null)
        {
            if (string.IsNullOrWhiteSpace(rawJson)) return;
            MessageReceived?.Invoke(new SceneSyncRawMessage(rawJson, fromPeerId, source));
        }

        public static void PublishOutgoing(string payloadJson, string targetPeerId = null, object source = null)
        {
            if (string.IsNullOrWhiteSpace(payloadJson)) return;
            MessageRequested?.Invoke(new SceneSyncOutgoingMessage(payloadJson, targetPeerId, source));
        }
    }
}
