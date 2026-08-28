using System;

namespace Afjk.SceneSync
{
    public enum SceneSyncPlaybackClockMode
    {
        Local,
        SharedPlaybackFollow,
        SharedPlaybackControl,
        RoomTime
    }

    public enum SceneSyncPlaybackClockFollowPolicy
    {
        Manual,
        AutoFollowOrLocal,
        FollowerOnly
    }

    public interface ISceneSyncPlaybackClockProvider
    {
        SceneSyncPlaybackClockSample GetPlaybackClockSample(string objectId = null);
    }

    /// <summary>
    /// One effective clock sample shared by Animation, Loomlet, and optional
    /// physics integrations. ActiveTime and ObjectAge are seconds.
    /// </summary>
    public readonly struct SceneSyncPlaybackClockSample
    {
        public SceneSyncPlaybackClockSample(
            SceneSyncPlaybackClockMode mode,
            double activeTime,
            double objectAge,
            double roomNow,
            bool paused,
            double rate,
            bool synchronized,
            bool managerDriven,
            string controllerId,
            int revision)
        {
            Mode = mode;
            ActiveTime = SceneSyncPlaybackClockMath.ClampTime(activeTime);
            ObjectAge = SceneSyncPlaybackClockMath.ClampTime(objectAge);
            RoomNow = SceneSyncPlaybackClockMath.ClampTime(roomNow);
            Paused = paused;
            Rate = SceneSyncPlaybackClockMath.NormalizeRate(rate);
            Synchronized = synchronized;
            ManagerDriven = managerDriven;
            ControllerId = controllerId;
            Revision = revision;
        }

        public SceneSyncPlaybackClockMode Mode { get; }
        public double ActiveTime { get; }
        public double ObjectAge { get; }
        public double RoomNow { get; }
        public bool Paused { get; }
        public double Rate { get; }
        public bool Synchronized { get; }
        public bool ManagerDriven { get; }
        public string ControllerId { get; }
        public int Revision { get; }
    }

    /// <summary>
    /// Pure clock contract helpers. Public so package tests and downstream
    /// adapters can verify the same arithmetic without depending on a scene.
    /// </summary>
    public static class SceneSyncPlaybackClockMath
    {
        public static double ClampTime(double value)
        {
            return IsFinite(value) ? Math.Max(0d, value) : 0d;
        }

        public static double NormalizeRate(double value)
        {
            return IsFinite(value) && value >= 0d ? value : 1d;
        }

        public static double GetAnchoredTime(double valueAtReceipt, double receiptMonotonicTime, double monotonicNow)
        {
            if (!IsFinite(valueAtReceipt)) return 0d;
            if (!IsFinite(receiptMonotonicTime) || !IsFinite(monotonicNow))
                return ClampTime(valueAtReceipt);

            return ClampTime(valueAtReceipt + Math.Max(0d, monotonicNow - receiptMonotonicTime));
        }

        public static double GetActiveTime(
            double sourceNow,
            double rate,
            double offset,
            bool paused,
            double pausedTime)
        {
            if (paused && IsFinite(pausedTime)) return ClampTime(pausedTime);
            var time = sourceNow * NormalizeRate(rate) + (IsFinite(offset) ? offset : 0d);
            return ClampTime(time);
        }

        public static double RebaseOffset(double activeTime, double sourceNow, double rate)
        {
            return ClampTime(activeTime) - sourceNow * NormalizeRate(rate);
        }

        public static double GetObjectAge(double activeTime, double objectEpochTime)
        {
            if (!IsFinite(activeTime) || !IsFinite(objectEpochTime)) return 0d;
            return Math.Max(0d, activeTime - objectEpochTime);
        }

        public static double RebaseObjectEpoch(double previousActiveTime, double previousEpochTime, double nextActiveTime)
        {
            var age = GetObjectAge(previousActiveTime, previousEpochTime);
            return nextActiveTime - age;
        }

        public static double RebasePhysicsWorldEpoch(double activeTime, int tick, double timestep)
        {
            var normalizedStep = IsFinite(timestep) && timestep > 0d ? timestep : 1d / 60d;
            return activeTime - Math.Max(0, tick) * normalizedStep;
        }

        public static int GetPhysicsTargetTick(double activeTime, double worldEpochTime, double timestep)
        {
            var normalizedStep = IsFinite(timestep) && timestep > 0d ? timestep : 1d / 60d;
            var age = Math.Max(0d, activeTime - worldEpochTime);
            var tick = Math.Floor(age / normalizedStep + 0.0000001d);
            return tick >= int.MaxValue ? int.MaxValue : Math.Max(0, (int)tick);
        }

        public static bool ShouldPreservePhysicsAgeAcrossModeChange(
            SceneSyncPlaybackClockMode previousMode,
            SceneSyncPlaybackClockMode nextMode)
        {
            if (nextMode == SceneSyncPlaybackClockMode.SharedPlaybackControl
                && previousMode != SceneSyncPlaybackClockMode.SharedPlaybackFollow
                && previousMode != SceneSyncPlaybackClockMode.SharedPlaybackControl)
                return false;
            return previousMode == SceneSyncPlaybackClockMode.RoomTime
                || nextMode == SceneSyncPlaybackClockMode.RoomTime
                || ((previousMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow
                     || previousMode == SceneSyncPlaybackClockMode.SharedPlaybackControl)
                    && nextMode == SceneSyncPlaybackClockMode.Local);
        }

        public static bool IsLeaseValid(double leaseExpiresAtMilliseconds, double roomNowSeconds)
        {
            if (!IsFinite(leaseExpiresAtMilliseconds) || leaseExpiresAtMilliseconds <= 0d)
                return true; // Backward compatibility with pre-lease servers.
            if (!IsFinite(roomNowSeconds)) return false;
            return roomNowSeconds * 1000d <= leaseExpiresAtMilliseconds;
        }

        public static bool IsReceiptLeaseValid(
            double leaseDurationMilliseconds,
            double receiptMonotonicTime,
            double monotonicNow)
        {
            if (!IsFinite(leaseDurationMilliseconds) || leaseDurationMilliseconds <= 0d)
                return true;
            if (!IsFinite(receiptMonotonicTime) || !IsFinite(monotonicNow)) return false;
            return monotonicNow <= receiptMonotonicTime + leaseDurationMilliseconds / 1000d;
        }

        public static double GetRoomTimeAtReceipt(
            double payloadRoomNow,
            double serverRoomNowAtReceipt,
            bool serverCanonicalPayload)
        {
            if (!IsFinite(payloadRoomNow)) return ClampTime(serverRoomNowAtReceipt);
            if (serverCanonicalPayload
                && IsFinite(serverRoomNowAtReceipt)
                && serverRoomNowAtReceipt > payloadRoomNow)
                return serverRoomNowAtReceipt;
            return ClampTime(payloadRoomNow);
        }

        public static bool ResolveActive(
            bool hasActiveField,
            bool activeFieldValue,
            bool hasControllerField,
            bool hasController)
        {
            if (hasActiveField) return activeFieldValue;
            return hasControllerField ? hasController : true;
        }

        public static bool IsControllerReleaseAction(string action)
        {
            return string.Equals(action, "controller-release", StringComparison.OrdinalIgnoreCase)
                || string.Equals(action, "controller-expired", StringComparison.OrdinalIgnoreCase)
                || string.Equals(action, "controller-disconnected", StringComparison.OrdinalIgnoreCase);
        }

        public static bool ShouldResetObjectEpochs(string action)
        {
            return string.Equals(action, "reset", StringComparison.OrdinalIgnoreCase);
        }

        public static bool CanApplyControllerRelease(string currentControllerId, string fromId)
        {
            if (string.IsNullOrWhiteSpace(currentControllerId)) return true;
            if (string.IsNullOrWhiteSpace(fromId)) return true;
            return string.Equals(fromId, "server", StringComparison.OrdinalIgnoreCase)
                || string.Equals(fromId, currentControllerId, StringComparison.Ordinal);
        }

        public static bool CanSendControllerPayload(
            bool allowControl,
            SceneSyncPlaybackClockFollowPolicy followPolicy)
        {
            return allowControl && followPolicy != SceneSyncPlaybackClockFollowPolicy.FollowerOnly;
        }

        public static SceneSyncPlaybackClockMode ResolveEffectiveMode(
            SceneSyncPlaybackClockMode requestedMode,
            SceneSyncPlaybackClockFollowPolicy followPolicy,
            bool allowControl,
            bool hasValidRemoteController)
        {
            if (requestedMode == SceneSyncPlaybackClockMode.RoomTime)
                return SceneSyncPlaybackClockMode.RoomTime;
            if (requestedMode == SceneSyncPlaybackClockMode.SharedPlaybackControl
                && CanSendControllerPayload(allowControl, followPolicy))
                return SceneSyncPlaybackClockMode.SharedPlaybackControl;
            if (requestedMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow)
                return hasValidRemoteController
                    ? SceneSyncPlaybackClockMode.SharedPlaybackFollow
                    : SceneSyncPlaybackClockMode.Local;
            if (followPolicy == SceneSyncPlaybackClockFollowPolicy.AutoFollowOrLocal
                || followPolicy == SceneSyncPlaybackClockFollowPolicy.FollowerOnly)
                return hasValidRemoteController
                    ? SceneSyncPlaybackClockMode.SharedPlaybackFollow
                    : SceneSyncPlaybackClockMode.Local;
            return SceneSyncPlaybackClockMode.Local;
        }

        public static bool UsesManagerDrivenPlayback(
            SceneSyncPlaybackClockMode effectiveMode,
            bool localTransportControlled)
        {
            return effectiveMode != SceneSyncPlaybackClockMode.Local
                || localTransportControlled;
        }

        public static bool UsesSharedObjectEpoch(SceneSyncPlaybackClockMode effectiveMode)
        {
            return effectiveMode != SceneSyncPlaybackClockMode.Local;
        }

        public static bool ShouldAcceptRevision(int currentRevision, int incomingRevision, bool canonicalSelfEcho)
        {
            return incomingRevision > currentRevision
                || (incomingRevision == currentRevision && canonicalSelfEcho);
        }

        public static bool ShouldRelinquishControl(SceneSyncPlaybackClockMode requestedMode, bool canonicalClockActive)
        {
            return requestedMode == SceneSyncPlaybackClockMode.SharedPlaybackControl && !canonicalClockActive;
        }

        public static double GetSharedControlStartTime(
            SceneSyncPlaybackClockMode previousEffectiveMode,
            double previousDisplayedTime)
        {
            return previousEffectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow
                ? ClampTime(previousDisplayedTime)
                : 0d;
        }

        public static double SelectFallbackRebaseTime(
            bool canonicalClockActive,
            double canonicalClockTime,
            double previousDisplayedTime)
        {
            return ClampTime(canonicalClockActive ? previousDisplayedTime : canonicalClockTime);
        }

        public static bool ShouldFallbackOnDisconnect(
            bool wasConnectedOrClockActive,
            SceneSyncPlaybackClockMode requestedMode,
            SceneSyncPlaybackClockMode effectiveMode)
        {
            return wasConnectedOrClockActive
                && (requestedMode == SceneSyncPlaybackClockMode.SharedPlaybackControl
                || effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackControl
                || effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow);
        }

        public static bool IsFinite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }
    }
}
