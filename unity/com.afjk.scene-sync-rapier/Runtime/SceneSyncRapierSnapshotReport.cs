namespace Afjk.SceneSync.Rapier
{
    public readonly struct SceneSyncRapierSnapshotReport
    {
        public SceneSyncRapierSnapshotReport(
            string snapshotVersion,
            string hash,
            string localHash,
            string hashVersion,
            string profile,
            string rapierCoreVersion,
            int tick,
            int localTickBeforeApply,
            float timestep,
            float activeTime,
            float worldAge,
            float worldEpochTime,
            int sceneClockRevision,
            string fromPeerId,
            int bodyCount,
            int dynamicBodyCount,
            int appliedBodyCount,
            int missingBodyCount,
            bool applied,
            bool hashMatched)
        {
            SnapshotVersion = snapshotVersion;
            Hash = hash;
            LocalHash = localHash;
            HashVersion = hashVersion;
            Profile = profile;
            RapierCoreVersion = rapierCoreVersion;
            Tick = tick;
            LocalTickBeforeApply = localTickBeforeApply;
            Timestep = timestep;
            ActiveTime = activeTime;
            WorldAge = worldAge;
            WorldEpochTime = worldEpochTime;
            SceneClockRevision = sceneClockRevision;
            FromPeerId = fromPeerId;
            BodyCount = bodyCount;
            DynamicBodyCount = dynamicBodyCount;
            AppliedBodyCount = appliedBodyCount;
            MissingBodyCount = missingBodyCount;
            Applied = applied;
            HashMatched = hashMatched;
        }

        public string Kind => "scene-physics-snapshot";
        public string Source => "physics";
        public string Phase => "postPhysics";
        public string SnapshotVersion { get; }
        public string Hash { get; }
        public string LocalHash { get; }
        public string HashVersion { get; }
        public string Profile { get; }
        public string RapierCoreVersion { get; }
        public int Tick { get; }
        public int LocalTickBeforeApply { get; }
        public float Timestep { get; }
        public float ActiveTime { get; }
        public float WorldAge { get; }
        public float WorldEpochTime { get; }
        public int SceneClockRevision { get; }
        public string FromPeerId { get; }
        public int BodyCount { get; }
        public int DynamicBodyCount { get; }
        public int AppliedBodyCount { get; }
        public int MissingBodyCount { get; }
        public bool Applied { get; }
        public bool HashMatched { get; }
    }
}
