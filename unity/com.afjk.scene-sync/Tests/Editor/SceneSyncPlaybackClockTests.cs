using NUnit.Framework;

namespace Afjk.SceneSync.Tests
{
    public sealed class SceneSyncPlaybackClockTests
    {
        [Test]
        public void ReceiptAnchorIgnoresWallClockSkew()
        {
            var roomNow = SceneSyncPlaybackClockMath.GetAnchoredTime(1000d, 10d, 12.5d);
            Assert.That(roomNow, Is.EqualTo(1002.5d).Within(1e-9));
        }

        [Test]
        public void ActiveTimeSupportsPauseSeekAndRateArithmetic()
        {
            Assert.That(
                SceneSyncPlaybackClockMath.GetActiveTime(20d, 2d, -30d, false, double.NaN),
                Is.EqualTo(10d).Within(1e-9));
            Assert.That(
                SceneSyncPlaybackClockMath.GetActiveTime(999d, 2d, -30d, true, 7d),
                Is.EqualTo(7d).Within(1e-9));
            Assert.That(
                SceneSyncPlaybackClockMath.RebaseOffset(7d, 20d, 2d),
                Is.EqualTo(-33d).Within(1e-9));
            var sharedObjectAge = SceneSyncPlaybackClockMath.GetObjectAge(12d, 4.5d);
            Assert.That(sharedObjectAge, Is.EqualTo(7.5d).Within(1e-9));
            // Animation, Loomlet, and Rapier consume this same ActiveTime/epoch pair.
            Assert.That(SceneSyncPlaybackClockMath.GetObjectAge(12d, 4.5d), Is.EqualTo(sharedObjectAge));
            var roomEpoch = SceneSyncPlaybackClockMath.RebaseObjectEpoch(12d, 4.5d, 1700000000d);
            Assert.That(
                SceneSyncPlaybackClockMath.GetObjectAge(1700000000d, roomEpoch),
                Is.EqualTo(7.5d).Within(1e-9));
            var localEpoch = SceneSyncPlaybackClockMath.RebaseObjectEpoch(1700000000.5d, roomEpoch, 20d);
            Assert.That(
                SceneSyncPlaybackClockMath.GetObjectAge(20d, localEpoch),
                Is.EqualTo(8d).Within(1e-9));
            var physicsEpoch = SceneSyncPlaybackClockMath.RebasePhysicsWorldEpoch(
                1700000000d,
                60,
                1d / 60d);
            Assert.That(
                SceneSyncPlaybackClockMath.GetPhysicsTargetTick(
                    1700000000.5d,
                    physicsEpoch,
                    1d / 60d),
                Is.EqualTo(90),
                "RoomTime must advance 0.5 seconds without float-sized tick jumps");
            Assert.That(
                SceneSyncPlaybackClockMath.ShouldPreservePhysicsAgeAcrossModeChange(
                    SceneSyncPlaybackClockMode.Local,
                    SceneSyncPlaybackClockMode.RoomTime),
                Is.True);
            Assert.That(
                SceneSyncPlaybackClockMath.ShouldPreservePhysicsAgeAcrossModeChange(
                    SceneSyncPlaybackClockMode.Local,
                    SceneSyncPlaybackClockMode.SharedPlaybackControl),
                Is.False,
                "fresh Shared Control keeps its reset/baseline semantics");
            Assert.That(
                SceneSyncPlaybackClockMath.ShouldPreservePhysicsAgeAcrossModeChange(
                    SceneSyncPlaybackClockMode.RoomTime,
                    SceneSyncPlaybackClockMode.SharedPlaybackControl),
                Is.False);
            Assert.That(
                SceneSyncPlaybackClockMath.GetSharedControlStartTime(
                    SceneSyncPlaybackClockMode.SharedPlaybackFollow,
                    42.5d),
                Is.EqualTo(42.5d).Within(1e-9),
                "AutoFollow requested as Local transfers its effective Follow time");
            Assert.That(
                SceneSyncPlaybackClockMath.GetSharedControlStartTime(
                    SceneSyncPlaybackClockMode.Local,
                    42.5d),
                Is.EqualTo(0d));
        }

        [Test]
        public void LegacyClockWithoutLeaseRemainsValid()
        {
            Assert.That(SceneSyncPlaybackClockMath.IsLeaseValid(0d, 123d), Is.True);
            Assert.That(SceneSyncPlaybackClockMath.IsLeaseValid(double.NaN, 123d), Is.True);
        }

        [Test]
        public void CanonicalLeaseExpiresAgainstRoomTime()
        {
            Assert.That(SceneSyncPlaybackClockMath.IsLeaseValid(120000d, 119.999d), Is.True);
            Assert.That(SceneSyncPlaybackClockMath.IsLeaseValid(120000d, 120.001d), Is.False);
            Assert.That(SceneSyncPlaybackClockMath.IsReceiptLeaseValid(5000d, 10d, 14.999d), Is.True);
            Assert.That(SceneSyncPlaybackClockMath.IsReceiptLeaseValid(5000d, 10d, 15.001d), Is.False);
        }

        [Test]
        public void CanonicalPayloadAccountsForReceiptLatencyButLegacySkewDoesNot()
        {
            Assert.That(
                SceneSyncPlaybackClockMath.GetRoomTimeAtReceipt(100d, 100.25d, true),
                Is.EqualTo(100.25d).Within(1e-9));
            Assert.That(
                SceneSyncPlaybackClockMath.GetRoomTimeAtReceipt(160d, 100.25d, false),
                Is.EqualTo(160d).Within(1e-9));
        }

        [Test]
        public void ContinuousFallbackRebasesPausedSharedTimeAndResumesLocally()
        {
            var sharedPausedTime = SceneSyncPlaybackClockMath.GetActiveTime(100d, 1d, -90d, true, 7d);
            var localAfterOneSecond = SceneSyncPlaybackClockMath.GetAnchoredTime(sharedPausedTime, 20d, 21d);
            Assert.That(localAfterOneSecond, Is.EqualTo(8d).Within(1e-9));
            Assert.That(
                SceneSyncPlaybackClockMath.SelectFallbackRebaseTime(
                    false,
                    12.5d,
                    9d),
                Is.EqualTo(12.5d).Within(1e-9),
                "authoritative release time wins over the pre-release display");
            Assert.That(
                SceneSyncPlaybackClockMath.ShouldFallbackOnDisconnect(
                    true,
                    SceneSyncPlaybackClockMode.Local,
                    SceneSyncPlaybackClockMode.Local),
                Is.False,
                "plain Manual+Local disconnect must preserve local pause/rate");
            Assert.That(
                SceneSyncPlaybackClockMath.ShouldFallbackOnDisconnect(
                    true,
                    SceneSyncPlaybackClockMode.SharedPlaybackFollow,
                    SceneSyncPlaybackClockMode.SharedPlaybackFollow),
                Is.True);
            Assert.That(
                SceneSyncPlaybackClockMath.ShouldFallbackOnDisconnect(
                    false,
                    SceneSyncPlaybackClockMode.SharedPlaybackControl,
                    SceneSyncPlaybackClockMode.SharedPlaybackControl),
                Is.False,
                "ConnectAsync's initial cleanup must preserve configured Control");
        }

        [Test]
        public void FollowerOnlyCannotSendControllerPayload()
        {
            Assert.That(
                SceneSyncPlaybackClockMath.CanSendControllerPayload(
                    true,
                    SceneSyncPlaybackClockFollowPolicy.FollowerOnly),
                Is.False);
            Assert.That(
                SceneSyncPlaybackClockMath.CanSendControllerPayload(
                    true,
                    SceneSyncPlaybackClockFollowPolicy.AutoFollowOrLocal),
                Is.True);
            Assert.That(
                SceneSyncPlaybackClockMath.ResolveEffectiveMode(
                    SceneSyncPlaybackClockMode.Local,
                    SceneSyncPlaybackClockFollowPolicy.FollowerOnly,
                    true,
                    false),
                Is.EqualTo(SceneSyncPlaybackClockMode.Local));
            Assert.That(
                SceneSyncPlaybackClockMath.ResolveEffectiveMode(
                    SceneSyncPlaybackClockMode.Local,
                    SceneSyncPlaybackClockFollowPolicy.FollowerOnly,
                    true,
                    true),
                Is.EqualTo(SceneSyncPlaybackClockMode.SharedPlaybackFollow));
            Assert.That(
                SceneSyncPlaybackClockMath.ResolveEffectiveMode(
                    SceneSyncPlaybackClockMode.SharedPlaybackControl,
                    SceneSyncPlaybackClockFollowPolicy.FollowerOnly,
                    true,
                    false),
                Is.EqualTo(SceneSyncPlaybackClockMode.Local));
        }

        [Test]
        public void LegacyMissingActiveUsesControllerPresence()
        {
            Assert.That(SceneSyncPlaybackClockMath.ResolveActive(false, false, false, false), Is.True);
            Assert.That(SceneSyncPlaybackClockMath.ResolveActive(false, false, true, true), Is.True);
            Assert.That(SceneSyncPlaybackClockMath.ResolveActive(false, true, true, false), Is.False);
            Assert.That(SceneSyncPlaybackClockMath.ResolveActive(true, false, false, true), Is.False);
            Assert.That(SceneSyncPlaybackClockMath.IsControllerReleaseAction("controller-release"), Is.True);
            Assert.That(SceneSyncPlaybackClockMath.IsControllerReleaseAction("controller-expired"), Is.True);
            Assert.That(SceneSyncPlaybackClockMath.IsControllerReleaseAction("controller-disconnected"), Is.True);
            Assert.That(SceneSyncPlaybackClockMath.ShouldResetObjectEpochs("reset"), Is.True);
            Assert.That(SceneSyncPlaybackClockMath.ShouldResetObjectEpochs("seek"), Is.False);
            Assert.That(SceneSyncPlaybackClockMath.CanApplyControllerRelease("controller", "controller"), Is.True);
            Assert.That(SceneSyncPlaybackClockMath.CanApplyControllerRelease("controller", "server"), Is.True);
            Assert.That(SceneSyncPlaybackClockMath.CanApplyControllerRelease("controller", "other"), Is.False);
            // The same authority check is used for a controller:null payload,
            // even when action/active are omitted by a legacy producer.
            Assert.That(SceneSyncPlaybackClockMath.CanApplyControllerRelease("controller", "stranger"), Is.False);
            Assert.That(SceneSyncPlaybackClockMath.ShouldAcceptRevision(5, 5, false), Is.False);
            Assert.That(SceneSyncPlaybackClockMath.ShouldAcceptRevision(5, 5, true), Is.True);
            Assert.That(SceneSyncPlaybackClockMath.ShouldAcceptRevision(5, 6, false), Is.True);
            Assert.That(
                SceneSyncPlaybackClockMath.ShouldRelinquishControl(
                    SceneSyncPlaybackClockMode.SharedPlaybackControl,
                    false),
                Is.True);
        }
    }
}
