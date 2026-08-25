using System.IO;
using UnityEngine;

namespace Afjk.SceneSync
{
    /// <summary>
    /// KHR_gaussian_splatting GLB を配置するためのコンポーネント。
    ///
    /// <c>[ExecuteAlways]</c> なので、シーンを開いた時点で Scene View に表示される。
    /// 確認のために Play モードへ入る必要はない。
    ///
    /// 生成した視覚オブジェクトは <see cref="HideFlags.DontSave"/> 付きで、シーンには
    /// 保存されず参照（TextAsset か パス）から毎回組み立て直す。
    /// Transform / active 状態は通常の GameObject と同じように編集・保存できる。
    ///
    /// GLB の渡し方:
    /// - <c>glbAsset</c>: Unity プロジェクト内に置く場合。Unity の glTF importer は
    ///   KHR_gaussian_splatting を解釈できないため、拡張子を <c>.glb.bytes</c> にして
    ///   TextAsset として参照する。ビルドにもそのまま含まれる。
    /// - <c>glbPath</c>: プロジェクト外のファイルを直接指す場合。
    ///   絶対パス、または <c>Application.streamingAssetsPath</c> からの相対パス。
    /// </summary>
    [ExecuteAlways]
    [DisallowMultipleComponent]
    [AddComponentMenu("Scene Sync/Scene Sync Gaussian Splat Source")]
    public sealed class SceneSyncGaussianSplatSource : MonoBehaviour
    {
        public const string VisualRootName = "ImportedGlbRoot";

        [Tooltip("プロジェクト内の GLB。拡張子を .glb.bytes にして TextAsset として参照する。")]
        [SerializeField] private TextAsset glbAsset;

        [Tooltip("GLB のパス。絶対パス、または StreamingAssets からの相対パス。")]
        [SerializeField] private string glbPath;

        [Tooltip("有効化された時点で自動的に読み込む。")]
        [SerializeField] private bool loadOnEnable = true;

        [Tooltip("Web で作られた GLB 向けの Yaw 補正。通常 GLB の ImportedGlbRoot と同じ扱い。")]
        [SerializeField] private bool applyGltfYawCorrection = true;

        private SceneSyncGaussianSplatGlbInfo _info;
        private string _visualSource = string.Empty;
        private bool _reloadRequested;

        public TextAsset GlbAsset
        {
            get { return glbAsset; }
            set { glbAsset = value; _reloadRequested = true; }
        }

        public string GlbPath
        {
            get { return glbPath; }
            set { glbPath = value; _reloadRequested = true; }
        }

        /// <summary>直近に読み込んだ GLB の検査結果。未読込なら null。</summary>
        public SceneSyncGaussianSplatGlbInfo Info
        {
            get { return _info; }
        }

        /// <summary>"backend" なら専用 renderer、"preview" なら依存ゼロの点群プレビュー。</summary>
        public string VisualSource
        {
            get { return _visualSource; }
        }

        public bool HasVisual
        {
            get { return FindVisualRoot() != null; }
        }

        private void OnEnable()
        {
            if (loadOnEnable && !HasVisual) Reload();
        }

        private void OnDestroy()
        {
            ClearVisual();
        }

        private void OnValidate()
        {
            _reloadRequested = true;
        }

        private void Update()
        {
            if (!_reloadRequested) return;
            _reloadRequested = false;
            Reload();
        }

        /// <summary>glbAsset / glbPath から読み直す。</summary>
        public bool Reload()
        {
            _reloadRequested = false;

            var bytes = ResolveBytes();
            if (bytes == null || bytes.Length == 0)
            {
                ClearVisual();
                return false;
            }

            return LoadFromBytes(bytes);
        }

        /// <summary>GLB バイト列から読み込む。Scene Sync 経由のランタイムロードもここを通る。</summary>
        public bool LoadFromBytes(byte[] glb)
        {
            var info = SceneSyncGaussianSplatGlb.Inspect(glb);
            if (!info.HasGaussianSplatting)
            {
                Debug.LogWarning("[SceneSync] Gaussian Splat load failed: not-a-gaussian-splat-glb", this);
                ClearVisual();
                return false;
            }

            var visual = SceneSyncGaussianSplatBackend.CreateVisual(glb, info);
            if (!visual.Ok)
            {
                Debug.LogWarning("[SceneSync] Gaussian Splat load failed: " + visual.Reason, this);
                ClearVisual();
                return false;
            }

            ClearVisual();

            var root = new GameObject(VisualRootName);
            root.hideFlags = HideFlags.DontSave;
            root.transform.SetParent(transform, false);
            root.transform.localPosition = Vector3.zero;
            root.transform.localRotation = applyGltfYawCorrection
                ? Quaternion.Euler(0f, 180f, 0f)
                : Quaternion.identity;
            root.transform.localScale = Vector3.one;

            visual.Visual.hideFlags = HideFlags.DontSave;
            visual.Visual.transform.SetParent(root.transform, false);

            _info = info;
            _visualSource = visual.Source;
            return true;
        }

        public void ClearVisual()
        {
            _info = null;
            _visualSource = string.Empty;

            var existing = FindVisualRoot();
            while (existing != null)
            {
                DestroySafely(existing.gameObject);
                existing = FindVisualRoot();
            }
        }

        private byte[] ResolveBytes()
        {
            if (glbAsset != null) return glbAsset.bytes;
            if (string.IsNullOrEmpty(glbPath)) return null;

            var path = Path.IsPathRooted(glbPath)
                ? glbPath
                : Path.Combine(Application.streamingAssetsPath, glbPath);

            if (!File.Exists(path))
            {
                Debug.LogWarning("[SceneSync] Gaussian Splat GLB not found: " + path, this);
                return null;
            }

            try
            {
                return File.ReadAllBytes(path);
            }
            catch (IOException err)
            {
                Debug.LogWarning("[SceneSync] Gaussian Splat GLB is unreadable: " + path + " (" + err.Message + ")", this);
                return null;
            }
        }

        private Transform FindVisualRoot()
        {
            for (var i = 0; i < transform.childCount; i++)
            {
                var child = transform.GetChild(i);
                if (child != null && child.name == VisualRootName) return child;
            }

            return null;
        }

        private static void DestroySafely(GameObject target)
        {
            if (target == null) return;

            if (Application.isPlaying) Destroy(target);
            else DestroyImmediate(target);
        }
    }
}
