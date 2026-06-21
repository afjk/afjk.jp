namespace Afjk.SceneSync.Rapier
{
    public readonly struct SceneSyncRapierHashReport
    {
        public SceneSyncRapierHashReport(
            string hash,
            string localHash,
            string hashVersion,
            string profile,
            string rapierCoreVersion,
            int tick,
            int localTick,
            float timestep,
            float activeTime,
            float worldAge,
            float worldEpochTime,
            int sceneClockRevision,
            string fromPeerId,
            bool tickMatched,
            bool hashVersionMatched,
            bool matched)
        {
            Hash = hash;
            LocalHash = localHash;
            HashVersion = hashVersion;
            Profile = profile;
            RapierCoreVersion = rapierCoreVersion;
            Tick = tick;
            LocalTick = localTick;
            Timestep = timestep;
            ActiveTime = activeTime;
            WorldAge = worldAge;
            WorldEpochTime = worldEpochTime;
            SceneClockRevision = sceneClockRevision;
            FromPeerId = fromPeerId;
            TickMatched = tickMatched;
            HashVersionMatched = hashVersionMatched;
            Matched = matched;
        }

        public string Kind => "scene-physics-hash";
        public string Source => "physics";
        public string Phase => "postPhysics";
        public string Hash { get; }
        public string LocalHash { get; }
        public string HashVersion { get; }
        public string Profile { get; }
        public string RapierCoreVersion { get; }
        public int Tick { get; }
        public int LocalTick { get; }
        public float Timestep { get; }
        public float ActiveTime { get; }
        public float WorldAge { get; }
        public float WorldEpochTime { get; }
        public int SceneClockRevision { get; }
        public string FromPeerId { get; }
        public bool TickMatched { get; }
        public bool HashVersionMatched { get; }
        public bool Matched { get; }
    }
}
