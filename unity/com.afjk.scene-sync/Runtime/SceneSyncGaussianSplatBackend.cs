using UnityEngine;

namespace Afjk.SceneSync
{
    /// <summary>
    /// Gaussian Splat renderer のバックエンド。
    ///
    /// Scene Sync Unity は 3DGS の parser も renderer も自前では持たない。
    /// KHR_gaussian_splatting GLB を検出したら、登録されたバックエンド
    /// （UnitySplats 等）へ GLB バイト列をそのまま渡す。
    ///
    /// 実装上の約束:
    /// - 返す GameObject は親を持たない状態で返す。配置は Scene Sync 側が行う。
    /// - 座標は glTFast と同じ規則（X 反転）で Unity 空間へ変換しておく。
    ///   通常 GLB と同じ ImportedGlbRoot の下に置かれるため、ここがずれると
    ///   Mesh GLB と Gaussian Splat GLB で位置が食い違う。
    /// </summary>
    public interface ISceneSyncGaussianSplatBackend
    {
        string Name { get; }

        /// <summary>この GLB を描画できるか。SH の次数や splat 数で判断してよい。</summary>
        bool CanRender(SceneSyncGaussianSplatGlbInfo info);

        /// <summary>描画用 GameObject を作る。描画できない場合は null。</summary>
        GameObject CreateSplatObject(byte[] glb, SceneSyncGaussianSplatGlbInfo info);
    }

    /// <summary>Gaussian Splat として生成された視覚オブジェクトの目印。</summary>
    [DisallowMultipleComponent]
    public sealed class SceneSyncGaussianSplatMarker : MonoBehaviour
    {
        [SerializeField] private string source;
        [SerializeField] private string backendName;
        [SerializeField] private int pointCount;

        public string Source
        {
            get { return source; }
            set { source = value; }
        }

        public string BackendName
        {
            get { return backendName; }
            set { backendName = value; }
        }

        public int PointCount
        {
            get { return pointCount; }
            set { pointCount = value; }
        }
    }

    public sealed class SceneSyncGaussianSplatVisualResult
    {
        public bool Ok;
        public GameObject Visual;

        /// <summary>"backend" なら専用 renderer、"preview" なら依存ゼロの点群プレビュー。</summary>
        public string Source = string.Empty;

        public string BackendName = string.Empty;
        public int PointCount;
        public string Reason = string.Empty;
    }

    /// <summary>バックエンドの登録と、GLB からの視覚オブジェクト生成。</summary>
    public static class SceneSyncGaussianSplatBackend
    {
        public const string SourceBackend = "backend";
        public const string SourcePreview = "preview";

        private static ISceneSyncGaussianSplatBackend _backend;

        public static ISceneSyncGaussianSplatBackend Current
        {
            get { return _backend; }
        }

        public static bool IsAvailable
        {
            get { return _backend != null; }
        }

        public static string BackendName
        {
            get { return _backend == null ? string.Empty : _backend.Name; }
        }

        public static void Register(ISceneSyncGaussianSplatBackend backend)
        {
            if (backend == null)
            {
                Debug.LogWarning("[SceneSync] Gaussian Splat backend must not be null");
                return;
            }

            _backend = backend;
            Debug.Log("[SceneSync] Gaussian Splat backend registered: " + backend.Name);
        }

        public static void Unregister()
        {
            _backend = null;
        }

        /// <summary>GLB が KHR_gaussian_splatting を含むかだけを見る軽量判定。</summary>
        public static bool IsGaussianSplatGlb(byte[] glb, out SceneSyncGaussianSplatGlbInfo info)
        {
            info = SceneSyncGaussianSplatGlb.Inspect(glb);
            return info.HasGaussianSplatting;
        }

        /// <summary>
        /// Gaussian Splat の視覚オブジェクトを作る。
        /// バックエンドが未登録、または CanRender が false の場合は点群プレビューへ落とす。
        /// </summary>
        public static SceneSyncGaussianSplatVisualResult CreateVisual(byte[] glb)
        {
            return CreateVisual(glb, null);
        }

        public static SceneSyncGaussianSplatVisualResult CreateVisual(
            byte[] glb, SceneSyncGaussianSplatGlbInfo info)
        {
            if (info == null || !info.Parsed)
                info = SceneSyncGaussianSplatGlb.Inspect(glb);

            if (!info.HasGaussianSplatting)
                return Failure("not-a-gaussian-splat-glb");

            foreach (var message in info.Errors)
                Debug.LogWarning("[SceneSync] Gaussian Splat GLB error: " + message);
            foreach (var message in info.Warnings)
                Debug.LogWarning("[SceneSync] Gaussian Splat GLB warning: " + message);

            if (!info.Valid)
                return Failure("invalid-gaussian-splat-glb");

            var backend = _backend;
            if (backend != null && backend.CanRender(info))
            {
                var splat = backend.CreateSplatObject(glb, info);
                if (splat != null)
                {
                    Tag(splat, SourceBackend, backend.Name, info.SplatCount);
                    return new SceneSyncGaussianSplatVisualResult
                    {
                        Ok = true,
                        Visual = splat,
                        Source = SourceBackend,
                        BackendName = backend.Name,
                        PointCount = info.SplatCount,
                        Reason = string.Empty,
                    };
                }

                Debug.LogWarning(
                    "[SceneSync] Gaussian Splat backend '" + backend.Name
                    + "' returned no GameObject; falling back to the point-cloud preview");
            }

            var preview = SceneSyncGaussianSplatPreview.Build(glb, info);
            if (!preview.Ok)
                return Failure(preview.Reason);

            Tag(preview.Visual, SourcePreview, string.Empty, preview.PointCount);
            if (backend == null)
            {
                Debug.Log(
                    "[SceneSync] No Gaussian Splat backend registered; showing a point-cloud preview ("
                    + preview.PointCount + " points)");
            }

            return new SceneSyncGaussianSplatVisualResult
            {
                Ok = true,
                Visual = preview.Visual,
                Source = SourcePreview,
                BackendName = string.Empty,
                PointCount = preview.PointCount,
                Reason = string.Empty,
            };
        }

        private static void Tag(GameObject visual, string source, string backendName, int pointCount)
        {
            if (visual == null) return;

            var marker = visual.GetComponent<SceneSyncGaussianSplatMarker>();
            if (marker == null) marker = visual.AddComponent<SceneSyncGaussianSplatMarker>();
            marker.Source = source;
            marker.BackendName = backendName;
            marker.PointCount = pointCount;
        }

        private static SceneSyncGaussianSplatVisualResult Failure(string reason)
        {
            return new SceneSyncGaussianSplatVisualResult
            {
                Ok = false,
                Visual = null,
                Source = string.Empty,
                BackendName = string.Empty,
                PointCount = 0,
                Reason = string.IsNullOrEmpty(reason) ? "unknown" : reason,
            };
        }
    }
}
