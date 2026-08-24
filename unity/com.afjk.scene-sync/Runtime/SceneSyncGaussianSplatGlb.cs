using System;
using System.Collections.Generic;
using System.Text;

namespace Afjk.SceneSync
{
    /// <summary>KHR_gaussian_splatting primitive ひとつ分の検査結果。</summary>
    public sealed class SceneSyncGaussianSplatPrimitiveInfo
    {
        public int MeshIndex;
        public int PrimitiveIndex;
        public int SplatCount;
        public string Kernel = string.Empty;
        public string ColorSpace = string.Empty;
        public string Projection = string.Empty;
        public string SortingMethod = string.Empty;
        public List<string> MissingAttributes = new List<string>();
        public bool ValidMode;
        public bool SupportedKernel;
        public bool SupportedColorSpace;
        public bool SupportedProjection;
        public bool SupportedSortingMethod;

        /// <summary>attribute 名 → accessor index。</summary>
        public Dictionary<string, int> Attributes = new Dictionary<string, int>(StringComparer.Ordinal);
    }

    /// <summary>GLB 全体の検査結果。</summary>
    public sealed class SceneSyncGaussianSplatGlbInfo
    {
        /// <summary>GLB の JSON chunk を読めたか。</summary>
        public bool Parsed;

        /// <summary>KHR_gaussian_splatting primitive を1つ以上含むか。</summary>
        public bool HasGaussianSplatting;

        /// <summary>extensionsUsed に宣言されているか。</summary>
        public bool ExtensionDeclared;

        /// <summary>extensionsRequired に含まれるか。</summary>
        public bool ExtensionRequired;

        /// <summary>通常 mesh primitive を併せ持つか（混在 GLB）。</summary>
        public bool HasRegularMeshPrimitive;

        /// <summary>splat 総数（POSITION accessor の count 合計）。</summary>
        public int SplatCount;

        public int ByteLength;

        public List<SceneSyncGaussianSplatPrimitiveInfo> Primitives =
            new List<SceneSyncGaussianSplatPrimitiveInfo>();

        public List<string> Warnings = new List<string>();
        public List<string> Errors = new List<string>();

        /// <summary>Gaussian Splat として読み込んでよいか。</summary>
        public bool Valid;

        public override string ToString()
        {
            if (!HasGaussianSplatting) return "no KHR_gaussian_splatting primitive";

            var builder = new StringBuilder();
            builder.Append("splats=").Append(SplatCount);
            builder.Append(", primitives=").Append(Primitives.Count);
            builder.Append(", mixedWithMesh=").Append(HasRegularMeshPrimitive);
            builder.Append(", valid=").Append(Valid);
            builder.Append(", errors=[").Append(string.Join(", ", Errors.ToArray())).Append(']');
            builder.Append(", warnings=[").Append(string.Join(", ", Warnings.ToArray())).Append(']');
            return builder.ToString();
        }
    }

    /// <summary>
    /// KHR_gaussian_splatting GLB の検査（glTFast に依存しない）。
    ///
    /// Scene Sync の 3DGS 交換形式は GLB + KHR_gaussian_splatting に統一されている。
    /// glTFast はこの拡張を知らないため、GLB を渡す前にここで判定し、
    /// <see cref="SceneSyncGaussianSplatBackend"/> へ振り分ける。
    ///
    /// 判定規則は Web 実装
    /// html/assets/js/scenesync/loaders/khr-gaussian-splatting.js と
    /// Godot 実装 godot/addons/scene_sync/gaussian_splat_glb.gd にそろえている。
    /// </summary>
    public static class SceneSyncGaussianSplatGlb
    {
        public const string ExtensionName = "KHR_gaussian_splatting";

        public static readonly string[] RequiredAttributes =
        {
            "POSITION",
            "KHR_gaussian_splatting:ROTATION",
            "KHR_gaussian_splatting:SCALE",
            "KHR_gaussian_splatting:OPACITY",
            "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0",
        };

        public const string PositionAttribute = "POSITION";
        public const string ColorAttribute = "COLOR_0";
        public const string OpacityAttribute = "KHR_gaussian_splatting:OPACITY";
        public const string Sh0Attribute = "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0";

        private const uint GlbMagic = 0x46546C67;
        private const uint GlbJsonChunkType = 0x4E4F534A;
        private const uint GlbBinChunkType = 0x004E4942;
        private const uint GlbVersion = 2;
        private const int GltfPointsMode = 0;
        private const int GltfTrianglesMode = 4;
        private const int GlbHeaderSize = 12;
        private const int GlbChunkHeaderSize = 8;

        /// <summary>GLB を JSON chunk と BIN chunk へ分解した結果。</summary>
        public sealed class GlbChunks
        {
            public Dictionary<string, object> Json;
            public int BinOffset = -1;
            public int BinLength;
        }

        /// <summary>GLB のチャンク構造を読む。</summary>
        public static bool TryParseGlb(byte[] glb, out GlbChunks chunks, out string error)
        {
            chunks = null;
            error = null;

            if (glb == null || glb.Length < GlbHeaderSize + GlbChunkHeaderSize)
            {
                error = "GLB is too short";
                return false;
            }

            if (ReadUInt32(glb, 0) != GlbMagic)
            {
                error = "Invalid GLB magic";
                return false;
            }

            if (ReadUInt32(glb, 4) != GlbVersion)
            {
                error = "Only GLB 2.0 is supported";
                return false;
            }

            var declaredLength = (long)ReadUInt32(glb, 8);
            if (declaredLength > glb.Length || declaredLength < GlbHeaderSize + GlbChunkHeaderSize)
            {
                error = "Invalid GLB length";
                return false;
            }

            var result = new GlbChunks();
            var offset = (long)GlbHeaderSize;

            while (offset + GlbChunkHeaderSize <= declaredLength)
            {
                var chunkLength = (long)ReadUInt32(glb, (int)offset);
                var chunkType = ReadUInt32(glb, (int)offset + 4);
                var chunkStart = offset + GlbChunkHeaderSize;
                var chunkEnd = chunkStart + chunkLength;
                if (chunkEnd > declaredLength)
                {
                    error = "Invalid GLB chunk length";
                    return false;
                }

                if (chunkType == GlbJsonChunkType && result.Json == null)
                {
                    var text = Encoding.UTF8.GetString(glb, (int)chunkStart, (int)chunkLength).Trim();
                    object parsed;
                    string parseError;
                    if (!SceneSyncGlbJson.TryParse(text, out parsed, out parseError))
                    {
                        error = "GLB JSON chunk is invalid: " + parseError;
                        return false;
                    }

                    var json = SceneSyncGlbJson.AsObject(parsed);
                    if (json == null)
                    {
                        error = "GLB JSON chunk is not an object";
                        return false;
                    }

                    result.Json = json;
                }
                else if (chunkType == GlbBinChunkType && result.BinOffset < 0)
                {
                    result.BinOffset = (int)chunkStart;
                    result.BinLength = (int)chunkLength;
                }

                offset = chunkEnd;
            }

            if (result.Json == null)
            {
                error = "GLB JSON chunk not found";
                return false;
            }

            chunks = result;
            return true;
        }

        /// <summary>GLB バイト列を検査する。</summary>
        public static SceneSyncGaussianSplatGlbInfo Inspect(byte[] glb)
        {
            GlbChunks chunks;
            string error;
            if (!TryParseGlb(glb, out chunks, out error))
            {
                var failure = new SceneSyncGaussianSplatGlbInfo();
                failure.Errors.Add(error);
                return failure;
            }

            var info = InspectGltf(chunks.Json);
            info.ByteLength = glb.Length;
            return info;
        }

        /// <summary>glTF JSON を検査する。</summary>
        public static SceneSyncGaussianSplatGlbInfo InspectGltf(Dictionary<string, object> gltf)
        {
            var info = new SceneSyncGaussianSplatGlbInfo();
            if (gltf == null) return info;

            info.Parsed = true;
            info.ExtensionDeclared = SceneSyncGlbJson.GetStringList(gltf, "extensionsUsed").Contains(ExtensionName);
            info.ExtensionRequired = SceneSyncGlbJson.GetStringList(gltf, "extensionsRequired").Contains(ExtensionName);

            var accessors = SceneSyncGlbJson.AsArray(SceneSyncGlbJson.Get(gltf, "accessors"));
            var meshes = SceneSyncGlbJson.AsArray(SceneSyncGlbJson.Get(gltf, "meshes"));
            if (meshes == null) meshes = new List<object>();

            for (var meshIndex = 0; meshIndex < meshes.Count; meshIndex++)
            {
                var primitives = SceneSyncGlbJson.AsArray(SceneSyncGlbJson.Get(meshes[meshIndex], "primitives"));
                if (primitives == null) continue;

                for (var primitiveIndex = 0; primitiveIndex < primitives.Count; primitiveIndex++)
                {
                    var primitive = SceneSyncGlbJson.AsObject(primitives[primitiveIndex]);
                    if (primitive == null) continue;

                    var extension = SceneSyncGlbJson.AsObject(
                        SceneSyncGlbJson.Get(SceneSyncGlbJson.Get(primitive, "extensions"), ExtensionName));
                    if (extension == null)
                    {
                        info.HasRegularMeshPrimitive = true;
                        continue;
                    }

                    var entry = InspectPrimitive(primitive, extension, accessors, meshIndex, primitiveIndex);
                    info.Primitives.Add(entry);
                    info.SplatCount += entry.SplatCount;

                    var label = "meshes[" + meshIndex + "].primitives[" + primitiveIndex + "]";
                    if (!entry.ValidMode)
                        info.Errors.Add(label + ": mode must be POINTS (0)");
                    if (entry.MissingAttributes.Count > 0)
                    {
                        info.Errors.Add(label + ": missing required attributes: "
                            + string.Join(", ", entry.MissingAttributes.ToArray()));
                    }

                    if (!entry.SupportedKernel)
                        info.Warnings.Add(label + ": unknown kernel " + entry.Kernel);
                    if (!entry.SupportedColorSpace)
                        info.Warnings.Add(label + ": unknown colorSpace " + entry.ColorSpace);
                    if (!entry.SupportedProjection)
                        info.Warnings.Add(label + ": unsupported projection " + entry.Projection);
                    if (!entry.SupportedSortingMethod)
                        info.Warnings.Add(label + ": unsupported sortingMethod " + entry.SortingMethod);
                }
            }

            if (info.Primitives.Count > 0 && !info.ExtensionDeclared)
                info.Errors.Add(ExtensionName + " primitive exists but extensionsUsed does not declare it");

            info.HasGaussianSplatting = info.Primitives.Count > 0;
            info.Valid = info.HasGaussianSplatting && info.Errors.Count == 0;
            return info;
        }

        private static SceneSyncGaussianSplatPrimitiveInfo InspectPrimitive(
            Dictionary<string, object> primitive,
            Dictionary<string, object> extension,
            List<object> accessors,
            int meshIndex,
            int primitiveIndex)
        {
            var entry = new SceneSyncGaussianSplatPrimitiveInfo();
            entry.MeshIndex = meshIndex;
            entry.PrimitiveIndex = primitiveIndex;

            var attributes = SceneSyncGlbJson.AsObject(SceneSyncGlbJson.Get(primitive, "attributes"));
            if (attributes != null)
            {
                foreach (var pair in attributes)
                {
                    int accessorIndex;
                    if (SceneSyncGlbJson.TryGetInt(pair.Value, out accessorIndex))
                        entry.Attributes[pair.Key] = accessorIndex;
                }
            }

            foreach (var semantic in RequiredAttributes)
            {
                if (!entry.Attributes.ContainsKey(semantic))
                    entry.MissingAttributes.Add(semantic);
            }

            entry.Kernel = OptionalString(extension, "kernel");
            entry.ColorSpace = OptionalString(extension, "colorSpace");
            entry.Projection = OptionalString(extension, "projection");
            entry.SortingMethod = OptionalString(extension, "sortingMethod");

            entry.SplatCount = AccessorCount(accessors, entry, PositionAttribute);
            entry.ValidMode = SceneSyncGlbJson.GetInt(primitive, "mode", GltfTrianglesMode) == GltfPointsMode;
            entry.SupportedKernel = entry.Kernel == "ellipse";
            entry.SupportedColorSpace = entry.ColorSpace == "srgb_rec709_display"
                || entry.ColorSpace == "lin_rec709_display";
            // projection / sortingMethod は省略可能。省略時は既定値とみなす。
            entry.SupportedProjection = entry.Projection.Length == 0 || entry.Projection == "perspective";
            entry.SupportedSortingMethod = entry.SortingMethod.Length == 0
                || entry.SortingMethod == "cameraDistance";
            return entry;
        }

        /// <summary>attribute が指す accessor の要素数。読めない場合は 0。</summary>
        public static int AccessorCount(
            List<object> accessors,
            SceneSyncGaussianSplatPrimitiveInfo primitive,
            string semantic)
        {
            if (accessors == null || primitive == null) return 0;

            int accessorIndex;
            if (!primitive.Attributes.TryGetValue(semantic, out accessorIndex)) return 0;
            if (accessorIndex < 0 || accessorIndex >= accessors.Count) return 0;

            return SceneSyncGlbJson.GetInt(accessors[accessorIndex], "count", 0);
        }

        private static string OptionalString(Dictionary<string, object> owner, string key)
        {
            var value = SceneSyncGlbJson.AsString(SceneSyncGlbJson.Get(owner, key));
            return value ?? string.Empty;
        }

        private static uint ReadUInt32(byte[] bytes, int offset)
        {
            return (uint)(bytes[offset]
                | (bytes[offset + 1] << 8)
                | (bytes[offset + 2] << 16)
                | (bytes[offset + 3] << 24));
        }
    }
}
