using System;
using System.Collections.Generic;

namespace Afjk.SceneSync
{
    /// <summary>
    /// Tracks the one-at-a-time peer fallback used to obtain an initial scene-state.
    /// The transport stays outside this class so timeout and peer-change behavior can
    /// be tested without opening a WebSocket.
    /// </summary>
    internal sealed class SceneSyncInitialSceneRequestState
    {
        internal const double DefaultTimeoutSeconds = 5d;

        private readonly HashSet<string> _attemptedPeerIds = new HashSet<string>();
        private string _pendingPeerId;
        private double _pendingDeadline = double.NegativeInfinity;

        internal bool SceneReceived { get; private set; }
        internal string PendingPeerId => _pendingPeerId;
        internal double PendingDeadline => _pendingDeadline;

        internal void Reset()
        {
            SceneReceived = false;
            _attemptedPeerIds.Clear();
            _pendingPeerId = null;
            _pendingDeadline = double.NegativeInfinity;
        }

        internal bool TryMarkSceneReceived()
        {
            if (SceneReceived) return false;

            SceneReceived = true;
            _pendingPeerId = null;
            _pendingDeadline = double.NegativeInfinity;
            return true;
        }

        internal bool TrySelectPeer(
            IEnumerable<string> peerIds,
            string selfId,
            double now,
            double timeoutSeconds,
            out string selectedPeerId)
        {
            selectedPeerId = null;
            if (SceneReceived) return false;

            var activePeerIds = new List<string>();
            if (peerIds != null)
            {
                foreach (var peerId in peerIds)
                {
                    if (string.IsNullOrWhiteSpace(peerId) || peerId == selfId) continue;
                    if (!activePeerIds.Contains(peerId)) activePeerIds.Add(peerId);
                }
            }

            if (!string.IsNullOrEmpty(_pendingPeerId))
            {
                var pendingPeerIsActive = activePeerIds.Contains(_pendingPeerId);
                if (pendingPeerIsActive && now < _pendingDeadline)
                    return false;

                // The request timed out or its target disconnected. The peer remains
                // attempted so the next selection advances instead of looping.
                _pendingPeerId = null;
                _pendingDeadline = double.NegativeInfinity;
            }

            foreach (var peerId in activePeerIds)
            {
                if (!_attemptedPeerIds.Add(peerId)) continue;

                var timeout = double.IsNaN(timeoutSeconds) || double.IsInfinity(timeoutSeconds)
                    ? DefaultTimeoutSeconds
                    : Math.Max(0d, timeoutSeconds);
                _pendingPeerId = peerId;
                _pendingDeadline = now + timeout;
                selectedPeerId = peerId;
                return true;
            }

            // Do not mark an empty or exhausted peer list as received. A newly joined
            // peer can still be selected by a later peers update.
            return false;
        }
    }
}
