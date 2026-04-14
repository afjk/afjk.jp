using System;
using System.Collections.Generic;

namespace Afjk.Pipe.Internal
{
    // ── Outgoing messages (Client → Server) ────────────────────────────────────

    [Serializable]
    internal class HelloMessage
    {
        public string type = "hello";
        public string nickname;
        public string device;
    }

    [Serializable]
    internal class PongMessage
    {
        public string type = "pong";
    }

    [Serializable]
    internal class HandoffMessage
    {
        public string type = "handoff";
        public string targetId;
        public HandoffPayload payload;
    }

    // ── Incoming messages (Server → Client) ────────────────────────────────────

    [Serializable]
    internal class WelcomeMessage
    {
        public string type;
        public string id;
        public string room;
    }

    [Serializable]
    internal class PeersMessage
    {
        public string type;
        public List<PeerInfo> peers;
    }

    [Serializable]
    internal class IncomingHandoffMessage
    {
        public string type;
        public PeerInfo from;
        public HandoffPayload payload;
    }

    // ── Shared types ────────────────────────────────────────────────────────────

    /// <summary>デバイス情報（presence ピアリスト内の各エントリ）</summary>
    [Serializable]
    public class PeerInfo
    {
        public string id;
        public string nickname;
        public string device;
        public long lastSeen;
    }

    /// <summary>handoff ペイロード。kind によって使用フィールドが異なる。</summary>
    [Serializable]
    public class HandoffPayload
    {
        /// <summary>"file" | "files" | "text" | "wt-signal"</summary>
        public string kind;

        // kind: "file"
        public string path;
        public string filename;
        public long size;
        public string mime;
        public string url;

        // kind: "files"
        public List<FileEntry> files;

        // kind: "text"  — path フィールドを共用

        // kind: "wt-signal"
        public string signal;       // JSON string of SDP/candidate
        public string infoHash;
    }

    [Serializable]
    public class FileEntry
    {
        public string path;
        public string filename;
        public long size;
        public string mime;
        public string url;
    }
}
