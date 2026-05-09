using UnityEngine;

namespace Afjk.SceneSync
{
    public enum SceneSyncOrigin
    {
        Unknown,
        Unity,
        Remote
    }

    public enum SceneSyncState
    {
        Synced,
        Dirty,
        Pending,
        Locked,
        Error,
        Disconnected
    }

    [DisallowMultipleComponent]
    public sealed class SceneSyncIdentity : MonoBehaviour
    {
        [SerializeField] private string objectId;
        [SerializeField] private string meshPath;
        [SerializeField] private SceneSyncOrigin origin = SceneSyncOrigin.Unknown;
        [SerializeField] private bool temporary;
        [SerializeField] private SceneSyncState state = SceneSyncState.Synced;
        [SerializeField] private string lockOwner;

        public string ObjectId
        {
            get => objectId;
            set => objectId = value;
        }

        public string MeshPath
        {
            get => meshPath;
            set => meshPath = value;
        }

        public SceneSyncOrigin Origin
        {
            get => origin;
            set => origin = value;
        }

        public bool Temporary
        {
            get => temporary;
            set => temporary = value;
        }

        public SceneSyncState State
        {
            get => state;
            set => state = value;
        }

        public string LockOwner
        {
            get => lockOwner;
            set => lockOwner = value;
        }

        public void ConfigureRemoteTemporary(string newObjectId, string newMeshPath)
        {
            objectId = newObjectId;
            meshPath = newMeshPath;
            origin = SceneSyncOrigin.Remote;
            temporary = true;
            state = SceneSyncState.Synced;
            lockOwner = null;
        }

        public void ConfigureUnityManaged(string newObjectId)
        {
            objectId = newObjectId;
            origin = SceneSyncOrigin.Unity;
            temporary = false;
            state = SceneSyncState.Synced;
            lockOwner = null;
        }
    }
}
