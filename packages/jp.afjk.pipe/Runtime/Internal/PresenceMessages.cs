using System;
using System.Collections.Generic;
using Afjk.Pipe;

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
}
