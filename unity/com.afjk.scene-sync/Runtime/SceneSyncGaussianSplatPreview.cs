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
            renderer.sharedMaterial = CreateMaterial();
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            renderer.receiveShadows = false;

            return new SceneSyncGaussianSplatPreviewResult
            {
                Ok = true,
                Visual = visual,
                PointCount = positions.Count,
                Reason = string.Empty,
            };
        }

        private static Material CreateMaterial()
        {
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

            var stride = Mathf.Max(1, Mathf.CeilToInt(position.Count / (float)MaxPreviewPoints));

            for (var index = 0; index < position.Count; index += stride)
            {
                var offset = index * position.Components;
                // glTF は右手系。glTFast と同じ規則で X を反転して Unity 空間へ移す。
                positions.Add(new Vector3(
                    -position.Values[offset],
                    position.Values[offset + 1],
                    position.Values[offset + 2]));
                colors.Add(ColorAt(index, color, sh0, opacity));
            }

            return null;
        }

        private static Color ColorAt(
            int index,
            AccessorData color,
            AccessorData sh0,
            AccessorData opacity)
        {
            if (color.Ok && color.Components >= 3)
            {
                var offset = index * color.Components;
                if (offset + color.Components <= color.Values.Length)
                {
                    return new Color(
                        color.Values[offset],
                        color.Values[offset + 1],
                        color.Values[offset + 2],
                        color.Components >= 4 ? color.Values[offset + 3] : 1f);
                }
            }

            var result = new Color(0.8f, 0.8f, 0.8f, 1f);
            if (sh0.Ok && sh0.Components >= 3)
            {
                var offset = index * sh0.Components;
                if (offset + 3 <= sh0.Values.Length)
                {
                    result = new Color(
                        Mathf.Clamp01(0.5f + ShC0 * sh0.Values[offset]),
                        Mathf.Clamp01(0.5f + ShC0 * sh0.Values[offset + 1]),
                        Mathf.Clamp01(0.5f + ShC0 * sh0.Values[offset + 2]),
                        1f);
                }
            }

            if (opacity.Ok && opacity.Components >= 1)
            {
                var offset = index * opacity.Components;
                if (offset < opacity.Values.Length)
                    result.a = Mathf.Clamp01(opacity.Values[offset]);
            }

            return result;
        }

        private struct AccessorData
        {
            public bool Ok;
            public float[] Values;
            public int Count;
            public int Components;
            public string Reason;
        }

        /// <summary>
        /// accessor を float 配列として読み出す。
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

            var normalized = SceneSyncGlbJson.GetBool(accessor, "normalized", false);
            var values = new float[count * components];

            for (var element = 0; element < count; element++)
            {
                var elementOffset = start + (long)element * byteStride;
                for (var component = 0; component < components; component++)
                {
                    var offset = (int)(elementOffset + component * componentSize);
                    values[element * components + component] =
                        DecodeComponent(glb, offset, componentType, normalized);
                }
            }

            return new AccessorData
            {
                Ok = true,
                Values = values,
                Count = count,
                Components = components,
                Reason = string.Empty,
            };
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
                Values = new float[0],
                Count = 0,
                Components = 0,
                Reason = reason,
            };
        }
    }
}
