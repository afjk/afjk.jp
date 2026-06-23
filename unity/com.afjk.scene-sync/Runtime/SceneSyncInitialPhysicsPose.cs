using System.Collections.Generic;
using UnityEngine;

namespace Afjk.SceneSync
{
    public readonly struct SceneSyncInitialPhysicsPose
    {
        public SceneSyncInitialPhysicsPose(Vector3 position, Quaternion rotation)
        {
            Position = position;
            Rotation = rotation;
        }

        public Vector3 Position { get; }
        public Quaternion Rotation { get; }
    }

    public interface ISceneSyncInitialPhysicsPoseProvider
    {
        bool TryGetInitialPhysicsPoses(IDictionary<string, SceneSyncInitialPhysicsPose> poses);
    }
}
