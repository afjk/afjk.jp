using System;
using System.Linq;
using System.Reflection;
using UnityEngine;

namespace Afjk.SceneSync
{
    /// <summary>
    /// UnitySplats v1.2.0 adapter。
    ///
    /// UnitySplats は Git package のため Scene Sync package.json からは推移依存として
    /// 解決できない。Scene Sync 自体を UnitySplats 未導入 project でもコンパイル可能に
    /// するため、公開 API だけを reflection で結ぶ。型と API が揃ったときだけ自動登録し、
    /// 未導入時は従来の点群 preview を使う。
    /// </summary>
    public sealed class SceneSyncUnitySplatsBackend : ISceneSyncGaussianSplatBackend
    {
        public const string PackageVersion = "1.2.0";
        public const string PackageCommit = "6c0258189a2b124af1282fa9236fd9b6637f1a1a";
        public const string DisplayName = "UnitySplats 1.2.0";

        private const string AssemblyName = "Gsplat";
        private const string LoaderTypeName = "Gsplat.GsplatRuntimeLoader";
        private const string RendererTypeName = "Gsplat.GsplatRenderer";
        private const string AssetTypeName = "Gsplat.GsplatAsset";
        private const string FormatTypeName = "Gsplat.GsplatFileFormat";
        private const string CompressionTypeName = "Gsplat.CompressionMode";
        private const string CoordinatesTypeName = "Gsplat.SourceCoordinates";

        private readonly Type _rendererType;
        private readonly MethodInfo _loadMethod;
        private readonly FieldInfo _assetField;
        private readonly object _glbFormat;
        private readonly object _sparkCompression;
        private readonly object _autoCoordinates;

        private SceneSyncUnitySplatsBackend(
            Type rendererType,
            MethodInfo loadMethod,
            FieldInfo assetField,
            object glbFormat,
            object sparkCompression,
            object autoCoordinates)
        {
            _rendererType = rendererType;
            _loadMethod = loadMethod;
            _assetField = assetField;
            _glbFormat = glbFormat;
            _sparkCompression = sparkCompression;
            _autoCoordinates = autoCoordinates;
        }

        public string Name
        {
            get { return DisplayName; }
        }

        public bool CanRender(SceneSyncGaussianSplatGlbInfo info)
        {
            return info != null && info.Valid && info.HasGaussianSplatting;
        }

        public GameObject CreateSplatObject(byte[] glb, SceneSyncGaussianSplatGlbInfo info)
        {
            if (glb == null || glb.Length == 0 || !CanRender(info)) return null;

            GameObject visual = null;
            UnityEngine.Object runtimeAsset = null;
            try
            {
                // GsplatRuntimeLoader.Load(byte[], Glb, Spark, Unspecified, null)
                // converts glTF LUF coordinates to Unity RUF and keeps SH0-SH3.
                runtimeAsset = _loadMethod.Invoke(null, new[]
                {
                    (object)glb,
                    _glbFormat,
                    _sparkCompression,
                    _autoCoordinates,
                    null,
                }) as UnityEngine.Object;
                if (runtimeAsset == null)
                    throw new InvalidOperationException("UnitySplats returned no GsplatAsset");

                runtimeAsset.name = "SceneSync Runtime Gaussian Splat";
                runtimeAsset.hideFlags = HideFlags.DontSave;

                visual = new GameObject("UnitySplatsGaussianSplat");
                var renderer = visual.AddComponent(_rendererType);
                _assetField.SetValue(renderer, runtimeAsset);

                var owner = visual.AddComponent<SceneSyncUnitySplatsOwnedAsset>();
                owner.Configure(renderer, runtimeAsset, _assetField.Name);
                return visual;
            }
            catch (Exception exception)
            {
                var cause = exception is TargetInvocationException && exception.InnerException != null
                    ? exception.InnerException
                    : exception;
                Debug.LogWarning("[SceneSync] UnitySplats failed to load KHR_gaussian_splatting GLB: "
                    + cause.Message);

                if (visual != null) DestroySafely(visual);
                else if (runtimeAsset != null) DestroySafely(runtimeAsset);
                return null;
            }
        }

        /// <summary>現在の AppDomain に固定 API が揃っている場合だけ adapter を作る。</summary>
        public static bool TryCreate(out ISceneSyncGaussianSplatBackend backend)
        {
            backend = null;

            var loaderType = ResolveType(LoaderTypeName);
            var rendererType = ResolveType(RendererTypeName);
            var assetType = ResolveType(AssetTypeName);
            var formatType = ResolveType(FormatTypeName);
            var compressionType = ResolveType(CompressionTypeName);
            var coordinatesType = ResolveType(CoordinatesTypeName);
            if (loaderType == null || rendererType == null || assetType == null
                || formatType == null || compressionType == null || coordinatesType == null)
                return false;
            if (!typeof(Component).IsAssignableFrom(rendererType)
                || !typeof(UnityEngine.Object).IsAssignableFrom(assetType))
                return false;

            var assetField = rendererType.GetField("GsplatAsset", BindingFlags.Public | BindingFlags.Instance);
            if (assetField == null || !assetField.FieldType.IsAssignableFrom(assetType)) return false;

            var loadMethod = loaderType.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .FirstOrDefault(method =>
                {
                    if (method.Name != "Load") return false;
                    var parameters = method.GetParameters();
                    return parameters.Length == 5
                        && parameters[0].ParameterType == typeof(byte[])
                        && parameters[1].ParameterType == formatType
                        && parameters[2].ParameterType == compressionType
                        && parameters[3].ParameterType == coordinatesType;
                });
            if (loadMethod == null || !assetType.IsAssignableFrom(loadMethod.ReturnType)) return false;

            try
            {
                backend = new SceneSyncUnitySplatsBackend(
                    rendererType,
                    loadMethod,
                    assetField,
                    Enum.Parse(formatType, "Glb"),
                    Enum.Parse(compressionType, "Spark"),
                    Enum.Parse(coordinatesType, "Unspecified"));
                return true;
            }
            catch (ArgumentException)
            {
                backend = null;
                return false;
            }
        }

        private static Type ResolveType(string fullName)
        {
            var qualified = Type.GetType(fullName + ", " + AssemblyName, false);
            if (qualified != null) return qualified;

            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type type;
                try { type = assembly.GetType(fullName, false); }
                catch (ReflectionTypeLoadException) { continue; }
                if (type != null) return type;
            }

            return null;
        }

        private static void DestroySafely(UnityEngine.Object target)
        {
            if (target == null) return;
            if (Application.isPlaying) UnityEngine.Object.Destroy(target);
            else UnityEngine.Object.DestroyImmediate(target);
        }
    }

    /// <summary>
    /// runtime 生成した GsplatAsset の所有者。GameObject の delete / reload と同時に
    /// renderer の GPU buffer を切り離し、ScriptableObject を確実に破棄する。
    /// </summary>
    [ExecuteAlways]
    [DisallowMultipleComponent]
    public sealed class SceneSyncUnitySplatsOwnedAsset : MonoBehaviour
    {
        [SerializeField] private Component runtimeRenderer;
        [SerializeField] private UnityEngine.Object runtimeAsset;
        [SerializeField] private string assetFieldName;
        private bool _released;

        public UnityEngine.Object RuntimeAsset
        {
            get { return runtimeAsset; }
        }

        internal void Configure(
            Component renderer,
            UnityEngine.Object asset,
            string rendererAssetFieldName)
        {
            runtimeRenderer = renderer;
            runtimeAsset = asset;
            assetFieldName = rendererAssetFieldName;
        }

        private void OnDestroy()
        {
            Release();
        }

        public void Release()
        {
            if (_released) return;
            _released = true;

            if (runtimeRenderer != null && !string.IsNullOrEmpty(assetFieldName))
            {
                var field = runtimeRenderer.GetType().GetField(
                    assetFieldName, BindingFlags.Public | BindingFlags.Instance);
                if (field != null && ReferenceEquals(field.GetValue(runtimeRenderer), runtimeAsset))
                    field.SetValue(runtimeRenderer, null);
            }

            var asset = runtimeAsset;
            runtimeRenderer = null;
            runtimeAsset = null;
            if (asset == null) return;

            if (Application.isPlaying) Destroy(asset);
            else DestroyImmediate(asset);
        }
    }
}
