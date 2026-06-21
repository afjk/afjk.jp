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

    public static class SceneSyncMessageBus
    {
        public static event Action<SceneSyncRawMessage> MessageReceived;

        public static void PublishReceived(string rawJson, string fromPeerId = null, object source = null)
        {
            if (string.IsNullOrWhiteSpace(rawJson)) return;
            MessageReceived?.Invoke(new SceneSyncRawMessage(rawJson, fromPeerId, source));
        }
    }
}
