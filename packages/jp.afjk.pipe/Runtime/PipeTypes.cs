using System;
using System.Collections.Generic;

namespace Afjk.Pipe
{
    /// <summary>Presence で検出されたピアの情報。</summary>
    [Serializable]
    public class PeerInfo
    {
        public string id;
        public string nickname;
        public string device;
        public long   lastSeen;
    }

    /// <summary>
    /// handoff ペイロード。kind によって使用フィールドが異なる。
    /// "file" | "files" | "text" | "wt-signal" |
    /// "torrent" | "swarm-publish" | "swarm-request" | "swarm-sync" |
    /// "swarm-join" | "swarm-seeder" | "swarm-catalog"
    /// </summary>
    [Serializable]
    public class HandoffPayload
    {
        public string kind;

        // kind: "file"
        public string path;
        public string filename;
        public long   size;
        public string mime;
        public string url;

        // kind: "files"
        public List<FileEntry> files;

        // kind: "wt-signal"
        // signal はブラウザが JSON オブジェクトとして送る → WtSignalData で受ける
        public WtSignalData signal;
        public string infoHash;

        // kind: "torrent" / "swarm-publish" / "swarm-sync" / "swarm-catalog"
        public string       magnetURI;
        public string       fileNames;   // カンマ区切り
        public int          fileCount;
        public long         totalBytes;
        public bool         active;      // swarm-seeder: true=シード中 false=停止

        // kind: "swarm-sync" (エントリ一覧)
        public List<SwarmEntryData> entries;

        // kind: "swarm-join" (接続要求)
        public string peerId;            // 要求者の presence ID
    }

    [Serializable]
    public class FileEntry
    {
        public string path;
        public string filename;
        public long   size;
        public string mime;
        public string url;
    }

    /// <summary>wt-signal の signal フィールド。ブラウザ側は JSON オブジェクトとして送受信する。</summary>
    [Serializable]
    public class WtSignalData
    {
        public string type;   // "offer" | "answer"
        public string sdp;
    }

    /// <summary>swarm-sync / swarm-catalog エントリの直列化型。</summary>
    [Serializable]
    public class SwarmEntryData
    {
        public string infoHash;
        public string magnetURI;
        public string fileNames;
        public int    fileCount;
        public long   totalBytes;
        public string fromNickname;
        public string senderId;
    }

    /// <summary>転送に使用された経路。</summary>
    public enum TransferMode
    {
        /// <summary>piping-server 経由 HTTP 中継</summary>
        Relay,
        /// <summary>WebRTC DataChannel P2P</summary>
        P2P
    }

    /// <summary>OnFileReceived イベントの引数。</summary>
    public class FileReceivedArgs
    {
        public PeerInfo      From;
        public string        Filename;
        public string        MimeType;
        public long          Size;
        public byte[]        Data;
        /// <summary>実際に使用された転送経路。</summary>
        public TransferMode  Mode;
    }

    /// <summary>OnTextReceived イベントの引数。</summary>
    public class TextReceivedArgs
    {
        public PeerInfo From;
        public string   Text;
    }

    /// <summary>OnSwarmUpdated イベントで渡されるスウォームエントリ（表示用）。</summary>
    public class SwarmEntry
    {
        public string   InfoHash;
        public string   MagnetURI;
        public string[] FileNames;
        public int      FileCount;
        public long     TotalBytes;
        public string   FromNickname;
        public string   SenderId;
        public bool     IsSeeding;   // シーダーが active を通知中
    }
}
