using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;

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
        public void EffectiveLocalUsesNativePlaybackUntilLocalTransportIsControlled()
        {
            Assert.That(
                SceneSyncPlaybackClockMath.UsesManagerDrivenPlayback(
                    SceneSyncPlaybackClockMode.Local,
                    false),
                Is.False,
                "a follow policy alone must not make an effective Local clock manager-driven");
            Assert.That(
                SceneSyncPlaybackClockMath.UsesSharedObjectEpoch(SceneSyncPlaybackClockMode.Local),
                Is.False,
                "effective Local must not subtract a Room/Unix-domain shared epoch");
            Assert.That(
                SceneSyncPlaybackClockMath.UsesManagerDrivenPlayback(
                    SceneSyncPlaybackClockMode.Local,
                    true),
                Is.True,
                "pause/seek/rate and continuous fallback still require manager sampling");
            Assert.That(
                SceneSyncPlaybackClockMath.UsesManagerDrivenPlayback(
                    SceneSyncPlaybackClockMode.SharedPlaybackFollow,
                    false),
                Is.True);
            Assert.That(
                SceneSyncPlaybackClockMath.UsesSharedObjectEpoch(
                    SceneSyncPlaybackClockMode.SharedPlaybackFollow),
                Is.True);
        }

        [Test]
        public void FollowerOnlyWithoutControllerKeepsLegacyAnimationNative()
        {
            GameObject managerObject = null;
            GameObject animatedObject = null;
            AnimationClip clip = null;
            try
            {
                managerObject = new GameObject("SceneSync Playback Clock Test Manager");
                var manager = managerObject.AddComponent<SceneSyncManager>();
                manager.SetPlaybackClockFollowPolicy(SceneSyncPlaybackClockFollowPolicy.FollowerOnly);

                var sample = manager.GetPlaybackClockSample();
                Assert.That(sample.Mode, Is.EqualTo(SceneSyncPlaybackClockMode.Local));
                Assert.That(sample.ManagerDriven, Is.False);

                animatedObject = new GameObject("SceneSync Legacy Animation Test Object");
                var animation = AddLegacyAnimation(animatedObject, out clip);
                animation[clip.name].speed = 0f;

                InvokePrivate(manager, "PlayImportedAnimations", animatedObject);

                Assert.That(animation.playAutomatically, Is.True);
                Assert.That(animation[clip.name].speed, Is.EqualTo(1f));
            }
            finally
            {
                if (animatedObject != null) Object.DestroyImmediate(animatedObject);
                if (managerObject != null) Object.DestroyImmediate(managerObject);
                if (clip != null) Object.DestroyImmediate(clip);
            }
        }

        [Test]
        public void ControlledLocalUsesLocalEpochInsteadOfSharedEpoch()
        {
            GameObject managerObject = null;
            try
            {
                managerObject = new GameObject("SceneSync Controlled Local Test Manager");
                var manager = managerObject.AddComponent<SceneSyncManager>();
                manager.SetPlaybackClockFollowPolicy(SceneSyncPlaybackClockFollowPolicy.FollowerOnly);
                Assert.That(manager.SeekPlaybackClock(5d), Is.True);

                GetPrivateDictionary(manager, "_sharedObjectEpochTimes")["object"] = 1700000000d;
                GetPrivateDictionary(manager, "_localObjectEpochTimes")["object"] = 3d;

                var sample = manager.GetPlaybackClockSample("object");
                Assert.That(sample.Mode, Is.EqualTo(SceneSyncPlaybackClockMode.Local));
                Assert.That(sample.ManagerDriven, Is.True);
                Assert.That(sample.ObjectAge, Is.EqualTo(2d).Within(0.1d));
            }
            finally
            {
                if (managerObject != null) Object.DestroyImmediate(managerObject);
            }
        }

        [Test]
        public void ControllerReleaseRebasesSharedObjectAgeIntoContinuousLocalFallback()
        {
            GameObject managerObject = null;
            try
            {
                managerObject = new GameObject("SceneSync Continuous Fallback Test Manager");
                var manager = managerObject.AddComponent<SceneSyncManager>();
                manager.SetPlaybackClockFollowPolicy(SceneSyncPlaybackClockFollowPolicy.FollowerOnly);

                IngestSharedController(manager);

                var followed = manager.GetPlaybackClockSample("object");
                Assert.That(followed.Mode, Is.EqualTo(SceneSyncPlaybackClockMode.SharedPlaybackFollow));
                Assert.That(followed.ManagerDriven, Is.True);
                Assert.That(followed.ObjectAge, Is.EqualTo(1d).Within(0.1d));

                InvokePrivate(
                    manager,
                    "HandleSceneClock",
                    "{\"kind\":\"scene-clock\",\"mode\":\"shared-playback\",\"active\":false," +
                    "\"controller\":null,\"action\":\"controller-release\",\"roomNow\":100," +
                    "\"sentAt\":100000,\"offset\":-95,\"rate\":1,\"revision\":2}",
                    "desktop");

                var fallback = manager.GetPlaybackClockSample("object");
                Assert.That(fallback.Mode, Is.EqualTo(SceneSyncPlaybackClockMode.Local));
                Assert.That(fallback.ManagerDriven, Is.True);
                Assert.That(fallback.ObjectAge, Is.EqualTo(followed.ObjectAge).Within(0.1d));

                var oneSecondLater = (double)InvokePrivate(
                    manager,
                    "GetObjectPlaybackRuntimeTime",
                    "object",
                    fallback.ActiveTime + 1d,
                    SceneSyncPlaybackClockMode.Local);
                Assert.That(oneSecondLater, Is.EqualTo(fallback.ObjectAge + 1d).Within(0.1d));
            }
            finally
            {
                if (managerObject != null) Object.DestroyImmediate(managerObject);
            }
        }

        [TestCase("disconnect")]
        [TestCase("controller-lease-expired")]
        [TestCase("controller-disconnected")]
        public void ControllerLossRebasesSharedObjectAgeIntoContinuousLocalFallback(string reason)
        {
            GameObject managerObject = null;
            try
            {
                managerObject = new GameObject("SceneSync Controller Loss Test Manager");
                var manager = managerObject.AddComponent<SceneSyncManager>();
                manager.SetPlaybackClockFollowPolicy(SceneSyncPlaybackClockFollowPolicy.FollowerOnly);

                IngestSharedController(manager);

                var followed = manager.GetPlaybackClockSample("object");
                InvokePrivate(
                    manager,
                    "FallbackFromSharedPlayback",
                    (double)Time.realtimeSinceStartup,
                    reason);

                var fallback = manager.GetPlaybackClockSample("object");
                Assert.That(fallback.Mode, Is.EqualTo(SceneSyncPlaybackClockMode.Local));
                Assert.That(fallback.ManagerDriven, Is.True);
                Assert.That(fallback.ObjectAge, Is.EqualTo(followed.ObjectAge).Within(0.1d));
            }
            finally
            {
                if (managerObject != null) Object.DestroyImmediate(managerObject);
            }
        }

        [Test]
        public void InvalidControllerAtColdStartKeepsNativeLocalPlayback()
        {
            GameObject managerObject = null;
            try
            {
                managerObject = new GameObject("SceneSync Invalid Controller Test Manager");
                var manager = managerObject.AddComponent<SceneSyncManager>();
                manager.SetPlaybackClockFollowPolicy(SceneSyncPlaybackClockFollowPolicy.FollowerOnly);
                SetPrivateField(manager, "_hasPeersSnapshot", true);

                IngestSharedController(manager, "missing-peer", 1700000000d);

                var sample = manager.GetPlaybackClockSample("object");
                Assert.That(sample.Mode, Is.EqualTo(SceneSyncPlaybackClockMode.Local));
                Assert.That(sample.ManagerDriven, Is.False);
                Assert.That(sample.ObjectAge, Is.EqualTo(sample.ActiveTime).Within(0.01d));
            }
            finally
            {
                if (managerObject != null) Object.DestroyImmediate(managerObject);
            }
        }

        [Test]
        public void LeavingManagerDrivenPlaybackRestoresLegacyAnimationSpeed()
        {
            GameObject managerObject = null;
            GameObject animatedObject = null;
            AnimationClip clip = null;
            try
            {
                managerObject = new GameObject("SceneSync Driver Transition Test Manager");
                var manager = managerObject.AddComponent<SceneSyncManager>();
                manager.SetPlaybackClockFollowPolicy(SceneSyncPlaybackClockFollowPolicy.FollowerOnly);

                animatedObject = new GameObject("SceneSync Driver Transition Animation");
                animatedObject.AddComponent<SceneSyncIdentity>()
                    .ConfigureRemoteTemporary("object", "test.glb");
                var animation = AddLegacyAnimation(animatedObject, out clip);
                GetPrivateManagedObjects(manager)["object"] = animatedObject;

                IngestSharedController(manager);
                InvokePrivate(
                    manager,
                    "UpdatePlaybackClock",
                    (double)Time.realtimeSinceStartup);
                Assert.That(animation[clip.name].speed, Is.EqualTo(0f));

                manager.SetPlaybackClockFollowPolicy(SceneSyncPlaybackClockFollowPolicy.Manual);
                InvokePrivate(
                    manager,
                    "UpdatePlaybackClock",
                    (double)Time.realtimeSinceStartup);
                Assert.That(animation[clip.name].speed, Is.EqualTo(1f));
            }
            finally
            {
                if (animatedObject != null) Object.DestroyImmediate(animatedObject);
                if (managerObject != null) Object.DestroyImmediate(managerObject);
                if (clip != null) Object.DestroyImmediate(clip);
            }
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

        private static Dictionary<string, double> GetPrivateDictionary(
            SceneSyncManager manager,
            string fieldName)
        {
            var field = typeof(SceneSyncManager).GetField(
                fieldName,
                BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.That(field, Is.Not.Null, "missing private field " + fieldName);
            return (Dictionary<string, double>)field.GetValue(manager);
        }

        private static Animation AddLegacyAnimation(GameObject target, out AnimationClip clip)
        {
            var animation = target.AddComponent<Animation>();
            clip = new AnimationClip { name = "LegacyMove", legacy = true };
            clip.SetCurve(
                "",
                typeof(Transform),
                "localPosition.x",
                AnimationCurve.Linear(0f, 0f, 1f, 1f));
            animation.AddClip(clip, clip.name);
            animation.clip = clip;
            return animation;
        }

        private static void IngestSharedController(
            SceneSyncManager manager,
            string controllerId = "desktop",
            double sharedEpochTime = 4d)
        {
            var epoch = sharedEpochTime.ToString("R", CultureInfo.InvariantCulture);
            InvokePrivate(
                manager,
                "HandleSceneClock",
                "{\"kind\":\"scene-clock\",\"mode\":\"shared-playback\",\"active\":true," +
                "\"controller\":{\"id\":\"" + controllerId + "\"},\"source\":\"room\",\"roomNow\":100," +
                "\"sentAt\":100000,\"offset\":-95,\"rate\":1,\"revision\":1," +
                "\"objectClocks\":{\"object\":{\"sharedEpochTime\":" + epoch + "}}}",
                controllerId);
        }

        private static Dictionary<string, GameObject> GetPrivateManagedObjects(SceneSyncManager manager)
        {
            var field = typeof(SceneSyncManager).GetField(
                "_managedObjects",
                BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.That(field, Is.Not.Null, "missing private field _managedObjects");
            return (Dictionary<string, GameObject>)field.GetValue(manager);
        }

        private static object InvokePrivate(SceneSyncManager manager, string methodName, params object[] args)
        {
            var method = typeof(SceneSyncManager).GetMethod(
                methodName,
                BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.That(method, Is.Not.Null, "missing private method " + methodName);
            return method.Invoke(manager, args);
        }

        private static void SetPrivateField(SceneSyncManager manager, string fieldName, object value)
        {
            var field = typeof(SceneSyncManager).GetField(
                fieldName,
                BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.That(field, Is.Not.Null, "missing private field " + fieldName);
            field.SetValue(manager, value);
        }
    }
}
