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
    /// "file" | "files" | "text" | "wt-signal"
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
        public string signal;
        public string infoHash;
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

    /// <summary>OnFileReceived イベントの引数。</summary>
    public class FileReceivedArgs
    {
        public PeerInfo From;
        public string   Filename;
        public string   MimeType;
        public long     Size;
        public byte[]   Data;
    }

    /// <summary>OnTextReceived イベントの引数。</summary>
    public class TextReceivedArgs
    {
        public PeerInfo From;
        public string   Text;
    }
}
