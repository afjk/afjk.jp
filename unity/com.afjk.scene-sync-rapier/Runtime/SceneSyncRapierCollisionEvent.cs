namespace Afjk.SceneSync.Rapier
{
    public readonly struct SceneSyncRapierCollisionEvent
    {
        public SceneSyncRapierCollisionEvent(
            string type,
            string objectIdA,
            string objectIdB,
            string pairKey,
            int tick,
            float time)
        {
            Type = type;
            Source = "physics";
            Phase = "postPhysics";
            ObjectIdA = objectIdA;
            ObjectIdB = objectIdB;
            PairKey = pairKey;
            Tick = tick;
            Time = time;
        }

        public string Type { get; }
        public string Source { get; }
        public string Phase { get; }
        public string ObjectIdA { get; }
        public string ObjectIdB { get; }
        public string PairKey { get; }
        public int Tick { get; }
        public float Time { get; }
    }
}
