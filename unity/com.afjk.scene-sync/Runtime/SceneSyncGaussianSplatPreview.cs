using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace Afjk.SceneSync
{
    public sealed class SceneSyncGaussianSplatPreviewResult
    {
        public bool Ok;
        public GameObject Visual;
        public int PointCount;
        public string Reason = string.Empty;
    }

    /// <summary>
    /// KHR_gaussian_splatting GLB の依存ゼロプレビュー。
    ///
    /// splat を楕円として描くには専用 renderer（UnitySplats 等）が必要だが、
    /// そのバックエンドが未登録の環境でも「読み込んだものが見える」状態を保つため、
    /// POSITION / COLOR_0（または SH0 + OPACITY）だけを読み出して点群として描画する。
    ///
    /// 座標変換は glTFast と同じ規則（X 反転）にそろえてある。これにより
    /// 通常 GLB と同じ ImportedGlbRoot の下にそのまま置ける。
    ///
    /// あくまでプレビューであり、正式な描画は
    /// <see cref="SceneSyncGaussianSplatBackend"/> に登録されたバックエンドが担当する。
    /// </summary>
    public static class SceneSyncGaussianSplatPreview
    {
        /// <summary>プレビューに使う最大点数。これを超える splat は間引く。</summary>
        public const int MaxPreviewPoints = 300000;

        private const float ShC0 = 0.2820947917738781f;

        private const int ComponentByte = 5120;
        private const int ComponentUnsignedByte = 5121;
        private const int ComponentShort = 5122;
        private const int ComponentUnsignedShort = 5123;
        private const int ComponentUnsignedInt = 5125;
        private const int ComponentFloat = 5126;

        /// <summary>
        /// プレビュー用 Material の差し替え口。
        /// 既定では頂点カラーを扱える組み込みシェーダーを探す。
        /// Points topology の見た目はレンダーパイプラインに依存するため、
        /// プロジェクト側でより良い point shader を差せるようにしてある。
        /// </summary>
        public static Func<Material> MaterialFactory;

        private static readonly string[] FallbackShaderNames =
        {
            "Sprites/Default",
            "Unlit/Color",
        };

        public static SceneSyncGaussianSplatPreviewResult Build(byte[] glb)
        {
            return Build(glb, null);
        }

        public static SceneSyncGaussianSplatPreviewResult Build(byte[] glb, SceneSyncGaussianSplatGlbInfo info)
        {
            SceneSyncGaussianSplatGlb.GlbChunks chunks;
            string parseError;
            if (!SceneSyncGaussianSplatGlb.TryParseGlb(glb, out chunks, out parseError))
                return Failure(parseError);

            if (chunks.BinOffset < 0)
                return Failure("glb-bin-chunk-missing");

            if (info == null || !info.Parsed)
                info = SceneSyncGaussianSplatGlb.InspectGltf(chunks.Json);

            if (info.Primitives.Count == 0)
                return Failure("no-gaussian-splat-primitive");

            var accessors = SceneSyncGlbJson.AsArray(SceneSyncGlbJson.Get(chunks.Json, "accessors"));
            var bufferViews = SceneSyncGlbJson.AsArray(SceneSyncGlbJson.Get(chunks.Json, "bufferViews"));
            var buffers = SceneSyncGlbJson.AsArray(SceneSyncGlbJson.Get(chunks.Json, "buffers"));

            var positions = new List<Vector3>();
            var colors = new List<Color>();

            foreach (var primitive in info.Primitives)
            {
                var reason = AppendPrimitive(
                    glb, chunks.BinOffset, accessors, bufferViews, buffers, primitive, positions, colors);
                if (reason != null) return Failure(reason);
            }

            if (positions.Count == 0)
                return Failure("no-decodable-splat-attribute");

            var mesh = new Mesh();
            mesh.name = "SceneSyncGaussianSplatPreview";
            mesh.indexFormat = IndexFormat.UInt32;
            mesh.SetVertices(positions);
            mesh.SetColors(colors);

            var indices = new int[positions.Count];
            for (var i = 0; i < indices.Length; i++) indices[i] = i;
            mesh.SetIndices(indices, MeshTopology.Points, 0);
            mesh.RecalculateBounds();

            var visual = new GameObject("GaussianSplatPreview");
            var filter = visual.AddComponent<MeshFilter>();
            filter.sharedMesh = mesh;
            var renderer = visual.AddComponent<MeshRenderer>();
            bool ownsMaterial;
            renderer.sharedMaterial = CreateMaterial(out ownsMaterial);
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            renderer.receiveShadows = false;

            var resources = visual.AddComponent<SceneSyncGaussianSplatPreviewResources>();
            resources.Configure(mesh, ownsMaterial ? renderer.sharedMaterial : null);

            return new SceneSyncGaussianSplatPreviewResult
            {
                Ok = true,
                Visual = visual,
                PointCount = positions.Count,
                Reason = string.Empty,
            };
        }

        private static Material CreateMaterial(out bool owned)
        {
            owned = false;
            if (MaterialFactory != null)
            {
                var custom = MaterialFactory();
                if (custom != null) return custom;
            }

            foreach (var name in FallbackShaderNames)
            {
                var shader = Shader.Find(name);
                if (shader != null)
                {
                    var material = new Material(shader);
                    material.name = "SceneSyncGaussianSplatPreview";
                    owned = true;
                    return material;
                }
            }

            Debug.LogWarning(
                "[SceneSync] No shader found for the Gaussian Splat preview. "
                + "Set SceneSyncGaussianSplatPreview.MaterialFactory to supply one.");
            return null;
        }

        private static string AppendPrimitive(
            byte[] glb,
            int binOffset,
            List<object> accessors,
            List<object> bufferViews,
            List<object> buffers,
            SceneSyncGaussianSplatPrimitiveInfo primitive,
            List<Vector3> positions,
            List<Color> colors)
        {
            var position = ReadAccessor(
                glb, binOffset, accessors, bufferViews, buffers,
                primitive, SceneSyncGaussianSplatGlb.PositionAttribute);
            if (!position.Ok) return position.Reason;
            if (position.Components < 3) return "position-component-count";
            if (position.Count <= 0) return "empty-splat-primitive";

            var color = ReadAccessor(
                glb, binOffset, accessors, bufferViews, buffers,
                primitive, SceneSyncGaussianSplatGlb.ColorAttribute);
            var sh0 = ReadAccessor(
                glb, binOffset, accessors, bufferViews, buffers,
                primitive, SceneSyncGaussianSplatGlb.Sh0Attribute);
            var opacity = ReadAccessor(
                glb, binOffset, accessors, bufferViews, buffers,
                primitive, SceneSyncGaussianSplatGlb.OpacityAttribute);

            var remainingPointBudget = MaxPreviewPoints - positions.Count;
            if (remainingPointBudget <= 0) return null;
            var sampledCount = Mathf.Min(position.Count, remainingPointBudget);

            for (var sampledIndex = 0; sampledIndex < sampledCount; sampledIndex++)
            {
                var index = sampledCount == position.Count
                    ? sampledIndex
                    : sampledCount == 1
                        ? 0
                        : (int)((long)sampledIndex * (position.Count - 1) / (sampledCount - 1));
                // glTF は右手系。glTFast と同じ規則で X を反転して Unity 空間へ移す。
                positions.Add(new Vector3(
                    -ReadComponent(glb, position, index, 0),
                    ReadComponent(glb, position, index, 1),
                    ReadComponent(glb, position, index, 2)));
                colors.Add(ColorAt(glb, index, color, sh0, opacity));
            }

            return null;
        }

        private static Color ColorAt(
            byte[] glb,
            int index,
            AccessorData color,
            AccessorData sh0,
            AccessorData opacity)
        {
            if (color.Ok && color.Components >= 3 && index < color.Count)
            {
                return new Color(
                    ReadComponent(glb, color, index, 0),
                    ReadComponent(glb, color, index, 1),
                    ReadComponent(glb, color, index, 2),
                    color.Components >= 4 ? ReadComponent(glb, color, index, 3) : 1f);
            }

            var result = new Color(0.8f, 0.8f, 0.8f, 1f);
            if (sh0.Ok && sh0.Components >= 3 && index < sh0.Count)
            {
                result = new Color(
                    Mathf.Clamp01(0.5f + ShC0 * ReadComponent(glb, sh0, index, 0)),
                    Mathf.Clamp01(0.5f + ShC0 * ReadComponent(glb, sh0, index, 1)),
                    Mathf.Clamp01(0.5f + ShC0 * ReadComponent(glb, sh0, index, 2)),
                    1f);
            }

            if (opacity.Ok && opacity.Components >= 1 && index < opacity.Count)
                result.a = Mathf.Clamp01(ReadComponent(glb, opacity, index, 0));

            return result;
        }

        private struct AccessorData
        {
            public bool Ok;
            public int Count;
            public int Components;
            public int ComponentType;
            public int ComponentSize;
            public int ByteStride;
            public int Start;
            public bool Normalized;
            public string Reason;
        }

        /// <summary>
        /// accessor のレイアウトだけを検証する。要素はプレビューで採用するindexだけを
        /// ReadComponentから直接decodeし、大規模captureの全要素配列は確保しない。
        /// sparse / 非 GLB buffer / 圧縮 bufferView は未対応（プレビューを諦める）。
        /// </summary>
        private static AccessorData ReadAccessor(
            byte[] glb,
            int binOffset,
            List<object> accessors,
            List<object> bufferViews,
            List<object> buffers,
            SceneSyncGaussianSplatPrimitiveInfo primitive,
            string semantic)
        {
            int accessorIndex;
            if (!primitive.Attributes.TryGetValue(semantic, out accessorIndex))
                return ReadFailure("accessor-missing");
            if (accessors == null || accessorIndex < 0 || accessorIndex >= accessors.Count)
                return ReadFailure("accessor-out-of-range");

            var accessor = SceneSyncGlbJson.AsObject(accessors[accessorIndex]);
            if (accessor == null) return ReadFailure("accessor-invalid");
            if (accessor.ContainsKey("sparse")) return ReadFailure("sparse-accessor-unsupported");

            var components = ComponentCount(SceneSyncGlbJson.AsString(SceneSyncGlbJson.Get(accessor, "type")));
            if (components <= 0) return ReadFailure("accessor-type-unsupported");

            var componentType = SceneSyncGlbJson.GetInt(accessor, "componentType", 0);
            var componentSize = ComponentSize(componentType);
            if (componentSize <= 0) return ReadFailure("component-type-unsupported");

            var count = SceneSyncGlbJson.GetInt(accessor, "count", 0);
            if (count <= 0) return ReadFailure("accessor-empty");

            if (!accessor.ContainsKey("bufferView"))
            {
                // bufferView 省略時は全ゼロ。プレビューでは扱わない。
                return ReadFailure("accessor-without-buffer-view");
            }

            var bufferViewIndex = SceneSyncGlbJson.GetInt(accessor, "bufferView", -1);
            if (bufferViews == null || bufferViewIndex < 0 || bufferViewIndex >= bufferViews.Count)
                return ReadFailure("buffer-view-out-of-range");

            var bufferView = SceneSyncGlbJson.AsObject(bufferViews[bufferViewIndex]);
            if (bufferView == null) return ReadFailure("buffer-view-invalid");
            if (bufferView.ContainsKey("extensions")) return ReadFailure("compressed-buffer-view-unsupported");
            if (SceneSyncGlbJson.GetInt(bufferView, "buffer", 0) != 0)
                return ReadFailure("external-buffer-unsupported");
            if (buffers == null || buffers.Count == 0) return ReadFailure("external-buffer-unsupported");
            if (SceneSyncGlbJson.AsString(SceneSyncGlbJson.Get(buffers[0], "uri")) != null)
                return ReadFailure("external-buffer-unsupported");

            var elementSize = componentSize * components;
            var byteStride = SceneSyncGlbJson.GetInt(bufferView, "byteStride", 0);
            if (byteStride <= 0) byteStride = elementSize;
            if (byteStride < elementSize) return ReadFailure("invalid-byte-stride");

            var start = (long)binOffset
                + SceneSyncGlbJson.GetInt(bufferView, "byteOffset", 0)
                + SceneSyncGlbJson.GetInt(accessor, "byteOffset", 0);
            var required = start + (long)byteStride * (count - 1) + elementSize;
            if (start < 0 || required > glb.Length) return ReadFailure("accessor-out-of-bounds");

            return new AccessorData
            {
                Ok = true,
                Count = count,
                Components = components,
                ComponentType = componentType,
                ComponentSize = componentSize,
                ByteStride = byteStride,
                Start = (int)start,
                Normalized = SceneSyncGlbJson.GetBool(accessor, "normalized", false),
                Reason = string.Empty,
            };
        }

        private static float ReadComponent(byte[] glb, AccessorData accessor, int index, int component)
        {
            var offset = accessor.Start
                + index * accessor.ByteStride
                + component * accessor.ComponentSize;
            return DecodeComponent(glb, offset, accessor.ComponentType, accessor.Normalized);
        }

        private static float DecodeComponent(byte[] glb, int offset, int componentType, bool normalized)
        {
            switch (componentType)
            {
                case ComponentFloat:
                    return BitConverter.ToSingle(glb, offset);
                case ComponentUnsignedByte:
                    return normalized ? glb[offset] / 255f : glb[offset];
                case ComponentByte:
                    var signedByte = (sbyte)glb[offset];
                    return normalized ? Mathf.Max(signedByte / 127f, -1f) : signedByte;
                case ComponentUnsignedShort:
                    var unsignedShort = (ushort)(glb[offset] | (glb[offset + 1] << 8));
                    return normalized ? unsignedShort / 65535f : unsignedShort;
                case ComponentShort:
                    var signedShort = (short)(glb[offset] | (glb[offset + 1] << 8));
                    return normalized ? Mathf.Max(signedShort / 32767f, -1f) : signedShort;
                case ComponentUnsignedInt:
                    return (uint)(glb[offset]
                        | (glb[offset + 1] << 8)
                        | (glb[offset + 2] << 16)
                        | (glb[offset + 3] << 24));
            }

            return 0f;
        }

        private static int ComponentSize(int componentType)
        {
            switch (componentType)
            {
                case ComponentByte:
                case ComponentUnsignedByte:
                    return 1;
                case ComponentShort:
                case ComponentUnsignedShort:
                    return 2;
                case ComponentUnsignedInt:
                case ComponentFloat:
                    return 4;
            }

            return 0;
        }

        private static int ComponentCount(string type)
        {
            switch (type)
            {
                case "SCALAR": return 1;
                case "VEC2": return 2;
                case "VEC3": return 3;
                case "VEC4": return 4;
            }

            return 0;
        }

        private static SceneSyncGaussianSplatPreviewResult Failure(string reason)
        {
            return new SceneSyncGaussianSplatPreviewResult
            {
                Ok = false,
                Visual = null,
                PointCount = 0,
                Reason = reason ?? "unknown",
            };
        }

        private static AccessorData ReadFailure(string reason)
        {
            return new AccessorData
            {
                Ok = false,
                Count = 0,
                Components = 0,
                Reason = reason,
            };
        }
    }

    /// <summary>点群 preview が生成した Mesh / Material をノード破棄時に解放する。</summary>
    [ExecuteAlways]
    [DisallowMultipleComponent]
    public sealed class SceneSyncGaussianSplatPreviewResources : MonoBehaviour
    {
        [SerializeField] private Mesh ownedMesh;
        [SerializeField] private Material ownedMaterial;
        private bool _released;

        internal void Configure(Mesh mesh, Material material)
        {
            ownedMesh = mesh;
            ownedMaterial = material;
        }

        private void OnDestroy()
        {
            Release();
        }

        public void Release()
        {
            if (_released) return;
            _released = true;

            DestroySafely(ownedMesh);
            DestroySafely(ownedMaterial);
            ownedMesh = null;
            ownedMaterial = null;
        }

        private static void DestroySafely(UnityEngine.Object target)
        {
            if (target == null) return;
            if (Application.isPlaying) Destroy(target);
            else DestroyImmediate(target);
        }
    }
}
