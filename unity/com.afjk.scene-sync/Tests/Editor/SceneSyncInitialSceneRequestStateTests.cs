using System;
using NUnit.Framework;

namespace Afjk.SceneSync.Tests
{
    public sealed class SceneSyncInitialSceneRequestStateTests
    {
        [Test]
        public void FallsBackToNextPeerAfterTimeoutAndStopsAfterResponse()
        {
            var state = new SceneSyncInitialSceneRequestState();
            var peers = new[] { "receive-only", "scene-sync-web" };

            Assert.That(
                state.TrySelectPeer(peers, "unity", 10d, 5d, out var firstPeer),
                Is.True);
            Assert.That(firstPeer, Is.EqualTo("receive-only"));
            Assert.That(
                state.TrySelectPeer(peers, "unity", 14.999d, 5d, out _),
                Is.False);

            Assert.That(
                state.TrySelectPeer(peers, "unity", 15d, 5d, out var secondPeer),
                Is.True);
            Assert.That(secondPeer, Is.EqualTo("scene-sync-web"));

            Assert.That(state.TryMarkSceneReceived(), Is.True);
            Assert.That(
                state.TrySelectPeer(peers, "unity", 20d, 5d, out _),
                Is.False);
        }

        [Test]
        public void FallsBackImmediatelyWhenPendingPeerDisconnects()
        {
            var state = new SceneSyncInitialSceneRequestState();

            Assert.That(
                state.TrySelectPeer(
                    new[] { "receive-only", "scene-sync-web" },
                    "unity",
                    0d,
                    5d,
                    out var firstPeer),
                Is.True);
            Assert.That(firstPeer, Is.EqualTo("receive-only"));

            Assert.That(
                state.TrySelectPeer(
                    new[] { "scene-sync-web" },
                    "unity",
                    1d,
                    5d,
                    out var fallbackPeer),
                Is.True);
            Assert.That(fallbackPeer, Is.EqualTo("scene-sync-web"));
        }

        [Test]
        public void RequestsFromPeerThatJoinsAfterInitialEmptyPeerList()
        {
            var state = new SceneSyncInitialSceneRequestState();

            Assert.That(
                state.TrySelectPeer(Array.Empty<string>(), "unity", 0d, 5d, out _),
                Is.False);
            Assert.That(state.SceneReceived, Is.False);

            Assert.That(
                state.TrySelectPeer(
                    new[] { "scene-sync-web" },
                    "unity",
                    2d,
                    5d,
                    out var joinedPeer),
                Is.True);
            Assert.That(joinedPeer, Is.EqualTo("scene-sync-web"));
        }

        [Test]
        public void EmptySceneStateCompletesAndAdditionalResponsesAreRejected()
        {
            var state = new SceneSyncInitialSceneRequestState();

            Assert.That(
                state.TrySelectPeer(new[] { "peer-a", "peer-b" }, "unity", 0d, 5d, out _),
                Is.True);
            Assert.That(state.TryMarkSceneReceived(), Is.True);
            Assert.That(state.SceneReceived, Is.True);
            Assert.That(state.PendingPeerId, Is.Null);
            Assert.That(state.TryMarkSceneReceived(), Is.False);
            Assert.That(
                state.TrySelectPeer(new[] { "peer-a", "peer-b" }, "unity", 6d, 5d, out _),
                Is.False);
        }

        [Test]
        public void ExhaustedPeersRemainPendingUntilANewPeerJoins()
        {
            var state = new SceneSyncInitialSceneRequestState();

            Assert.That(
                state.TrySelectPeer(new[] { "peer-a" }, "unity", 0d, 1d, out _),
                Is.True);
            Assert.That(
                state.TrySelectPeer(new[] { "peer-a" }, "unity", 1d, 1d, out _),
                Is.False);
            Assert.That(state.SceneReceived, Is.False);

            Assert.That(
                state.TrySelectPeer(
                    new[] { "peer-a", "peer-b" },
                    "unity",
                    2d,
                    1d,
                    out var newPeer),
                Is.True);
            Assert.That(newPeer, Is.EqualTo("peer-b"));
        }
    }
}
