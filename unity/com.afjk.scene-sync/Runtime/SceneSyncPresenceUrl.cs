using System;

namespace Afjk.SceneSync
{
    public static class SceneSyncPresenceUrl
    {
        public static string BuildRoomUrl(string presenceUrl, string room)
        {
            if (string.IsNullOrEmpty(presenceUrl)) return presenceUrl ?? string.Empty;
            if (string.IsNullOrEmpty(room)) return presenceUrl;

            var encodedRoom = Uri.EscapeDataString(room);
            if (presenceUrl.IndexOf('?') >= 0)
            {
                var separator = presenceUrl.EndsWith("?", StringComparison.Ordinal)
                    || presenceUrl.EndsWith("&", StringComparison.Ordinal)
                        ? string.Empty
                        : "&";
                return presenceUrl + separator + "room=" + encodedRoom;
            }

            if (presenceUrl.EndsWith("/ws/", StringComparison.Ordinal))
            {
                return presenceUrl.Substring(0, presenceUrl.Length - 1) + "?room=" + encodedRoom;
            }

            if (presenceUrl.EndsWith("/", StringComparison.Ordinal)
                || presenceUrl.EndsWith("/ws", StringComparison.Ordinal))
            {
                return presenceUrl + "?room=" + encodedRoom;
            }

            return presenceUrl + "/?room=" + encodedRoom;
        }
    }
}
