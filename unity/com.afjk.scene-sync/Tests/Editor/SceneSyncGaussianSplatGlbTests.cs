using System;
using System.Collections.Generic;
using System.Text;
using NUnit.Framework;
using UnityEngine;

namespace Afjk.SceneSync.Tests
{
    /// <summary>
    /// KHR_gaussian_splatting GLB の検出 / プレビュー / バックエンド振り分けのテスト。
    ///
    /// 期待値は Web 実装（html/assets/js/scenesync/loaders/khr-gaussian-splatting.test.js）と
    /// Godot 実装（godot/tests/test_gaussian_splat_glb.gd）にそろえてある。
    /// fixture の内容は scripts/generate-minimal-khr-gaussian-splatting.mjs と同じ構成。
    /// </summary>
    public sealed class SceneSyncGaussianSplatGlbTests
    {
        private const float ShC0 = 0.2820947917738781f;

        private readonly List<GameObject> _spawned = new List<GameObject>();

        [TearDown]
        public void TearDown()
        {
            SceneSyncGaussianSplatBackend.Unregister();
            foreach (var go in _spawned)
            {
                if (go != null) UnityEngine.Object.DestroyImmediate(go);
            }

            _spawned.Clear();
        }

        // --- inspect ---------------------------------------------------------

        [Test]
        public void InspectDetectsMinimalGaussianSplatGlb()
        {
            var glb = BuildMinimalSplatGlb();
            var info = SceneSyncGaussianSplatGlb.Inspect(glb);

            Assert.That(info.Parsed, Is.True);
            Assert.That(info.HasGaussianSplatting, Is.True);
            Assert.That(info.ExtensionDeclared, Is.True);
            Assert.That(info.ExtensionRequired, Is.False);
            Assert.That(info.HasRegularMeshPrimitive, Is.False);
            Assert.That(info.Valid, Is.True);
            Assert.That(info.SplatCount, Is.EqualTo(3));
            Assert.That(info.Primitives.Count, Is.EqualTo(1));
            Assert.That(info.Errors, Is.Empty);
            Assert.That(info.Warnings, Is.Empty);
            Assert.That(info.ByteLength, Is.EqualTo(glb.Length));

            var primitive = info.Primitives[0];
            Assert.That(primitive.Kernel, Is.EqualTo("ellipse"));
            Assert.That(primitive.ColorSpace, Is.EqualTo("srgb_rec709_display"));
            Assert.That(primitive.ValidMode, Is.True);
            Assert.That(primitive.MissingAttributes, Is.Empty);
        }

        [Test]
        public void InspectRejectsGlbWithoutTheDeclaredExtension()
        {
            var info = InspectJson(SplatGltfJson(extensionsUsed: "[]"));

            Assert.That(info.HasGaussianSplatting, Is.True);
            Assert.That(info.Valid, Is.False);
            Assert.That(info.Errors.Count, Is.EqualTo(1));
        }

        [Test]
        public void InspectRejectsNonPointsPrimitiveMode()
        {
            var info = InspectJson(SplatGltfJson(mode: 4));

            Assert.That(info.Valid, Is.False);
            Assert.That(info.Errors[0], Does.Contain("POINTS"));
        }

        [Test]
        public void InspectRejectsMissingRequiredAttributes()
        {
            var attributes = "{"
                + "\"POSITION\":0,"
                + "\"KHR_gaussian_splatting:ROTATION\":1,"
                + "\"KHR_gaussian_splatting:SCALE\":2,"
                + "\"KHR_gaussian_splatting:SH_DEGREE_0_COEF_0\":4"
                + "}";
            var info = InspectJson(SplatGltfJson(attributes: attributes));

            Assert.That(info.Valid, Is.False);
            Assert.That(info.Primitives[0].MissingAttributes,
                Does.Contain("KHR_gaussian_splatting:OPACITY"));
        }

        [Test]
        public void InspectTreatsUnknownKernelAsWarningNotError()
        {
            var info = InspectJson(SplatGltfJson(kernel: "gaussian"));

            Assert.That(info.Valid, Is.True);
            Assert.That(info.Warnings.Count, Is.EqualTo(1));
            Assert.That(info.Warnings[0], Does.Contain("kernel"));
        }

        [Test]
        public void InspectAcceptsOmittedProjectionAndSortingMethod()
        {
            var extension = "{\"kernel\":\"ellipse\",\"colorSpace\":\"srgb_rec709_display\"}";
            var info = InspectJson(SplatGltfJson(extension: extension));

            Assert.That(info.Valid, Is.True);
            Assert.That(info.Warnings, Is.Empty);
        }

        [Test]
        public void InspectReportsMeshAndSplatPrimitivesTogether()
        {
            var meshes = "["
                + "{\"primitives\":[" + SplatPrimitiveJson() + "]},"
                + "{\"primitives\":[{\"mode\":4,\"attributes\":{\"POSITION\":0}}]}"
                + "]";
            var info = InspectJson(SplatGltfJson(meshes: meshes));

            Assert.That(info.HasGaussianSplatting, Is.True);
            Assert.That(info.HasRegularMeshPrimitive, Is.True);
        }

        [Test]
        public void InspectIgnoresPlainMeshGlb()
        {
            var json = "{\"asset\":{\"version\":\"2.0\"},"
                + "\"meshes\":[{\"primitives\":[{\"mode\":4,\"attributes\":{\"POSITION\":0}}]}],"
                + "\"accessors\":[{\"count\":3,\"type\":\"VEC3\",\"componentType\":5126}]}";
            var info = InspectJson(json);

            Assert.That(info.HasGaussianSplatting, Is.False);
            Assert.That(info.HasRegularMeshPrimitive, Is.True);
            Assert.That(info.Valid, Is.False);
        }

        [Test]
        public void TryParseGlbRejectsMalformedContainers()
        {
            SceneSyncGaussianSplatGlb.GlbChunks chunks;
            string error;

            Assert.That(SceneSyncGaussianSplatGlb.TryParseGlb(new byte[0], out chunks, out error), Is.False);
            Assert.That(error, Is.EqualTo("GLB is too short"));

            var glb = BuildMinimalSplatGlb();

            var badMagic = (byte[])glb.Clone();
            badMagic[0] = 0x00;
            Assert.That(SceneSyncGaussianSplatGlb.TryParseGlb(badMagic, out chunks, out error), Is.False);
            Assert.That(error, Is.EqualTo("Invalid GLB magic"));

            var badLength = (byte[])glb.Clone();
            WriteUInt32(badLength, 8, (uint)(glb.Length + 64));
            Assert.That(SceneSyncGaussianSplatGlb.TryParseGlb(badLength, out chunks, out error), Is.False);
            Assert.That(error, Is.EqualTo("Invalid GLB length"));

            Assert.That(SceneSyncGaussianSplatGlb.TryParseGlb(glb, out chunks, out error), Is.True);
            Assert.That(chunks.BinOffset, Is.GreaterThan(0));
            Assert.That(chunks.BinLength, Is.GreaterThan(0));
        }

        // --- json reader -----------------------------------------------------

        [Test]
        public void JsonReaderHandlesGltfShapedInput()
        {
            object value;
            string error;
            var ok = SceneSyncGlbJson.TryParse(
                "{\"a\":[1,2.5,-3e2],\"b\":{\"KHR_x:Y\":7},\"c\":\"\\u3042\\n\",\"d\":true,\"e\":null}",
                out value, out error);

            Assert.That(ok, Is.True, error);
            var root = SceneSyncGlbJson.AsObject(value);
            Assert.That(root, Is.Not.Null);

            var array = SceneSyncGlbJson.AsArray(SceneSyncGlbJson.Get(root, "a"));
            Assert.That(array.Count, Is.EqualTo(3));
            Assert.That((double)array[2], Is.EqualTo(-300d).Within(1e-9));
            Assert.That(SceneSyncGlbJson.GetInt(SceneSyncGlbJson.Get(root, "b"), "KHR_x:Y", 0), Is.EqualTo(7));
            Assert.That(SceneSyncGlbJson.AsString(SceneSyncGlbJson.Get(root, "c")), Is.EqualTo("あ\n"));
            Assert.That(SceneSyncGlbJson.GetBool(root, "d", false), Is.True);
            Assert.That(SceneSyncGlbJson.Get(root, "e"), Is.Null);
        }

        [Test]
        public void JsonReaderRejectsBrokenInput()
        {
            object value;
            string error;

            Assert.That(SceneSyncGlbJson.TryParse("{\"a\":1", out value, out error), Is.False);
            Assert.That(SceneSyncGlbJson.TryParse("{} trailing", out value, out error), Is.False);
            Assert.That(SceneSyncGlbJson.TryParse("", out value, out error), Is.False);
        }

        [Test]
        public void JsonReaderTreatsNonIntegerNumbersAsNonIndices()
        {
            object value;
            string error;
            SceneSyncGlbJson.TryParse("{\"a\":1.5,\"b\":2}", out value, out error);

            int parsed;
            Assert.That(SceneSyncGlbJson.TryGetInt(SceneSyncGlbJson.Get(value, "a"), out parsed), Is.False);
            Assert.That(SceneSyncGlbJson.TryGetInt(SceneSyncGlbJson.Get(value, "b"), out parsed), Is.True);
            Assert.That(parsed, Is.EqualTo(2));
        }

        // --- preview ---------------------------------------------------------

        [Test]
        public void PreviewDecodesPositionsAndColors()
        {
            var preview = SceneSyncGaussianSplatPreview.Build(BuildMinimalSplatGlb());
            Assert.That(preview.Ok, Is.True, preview.Reason);
            Assert.That(preview.PointCount, Is.EqualTo(3));

            Track(preview.Visual);
            var mesh = preview.Visual.GetComponent<MeshFilter>().sharedMesh;
            Assert.That(mesh, Is.Not.Null);
            Assert.That(mesh.GetTopology(0), Is.EqualTo(MeshTopology.Points));

            var vertices = mesh.vertices;
            var colors = mesh.colors;
            Assert.That(vertices.Length, Is.EqualTo(3));
            Assert.That(colors.Length, Is.EqualTo(3));

            // glTF (-0.6, -0.4, 0) は glTFast と同じ X 反転で Unity 空間へ移る。
            Assert.That(vertices[0].x, Is.EqualTo(0.6f).Within(1e-4f));
            Assert.That(vertices[0].y, Is.EqualTo(-0.4f).Within(1e-4f));
            Assert.That(vertices[0].z, Is.EqualTo(0f).Within(1e-4f));

            // SH0 は 0.5 + C0 * coefficient で RGB に戻る。OPACITY はそのまま alpha。
            Assert.That(colors[0].r, Is.EqualTo(1f).Within(0.01f));
            Assert.That(colors[0].g, Is.EqualTo(0.2f).Within(0.01f));
            Assert.That(colors[0].b, Is.EqualTo(0.2f).Within(0.01f));
            Assert.That(colors[0].a, Is.EqualTo(0.95f).Within(0.01f));
        }

        [Test]
        public void PreviewPrefersColor0WhenPresent()
        {
            var preview = SceneSyncGaussianSplatPreview.Build(BuildMinimalSplatGlb(includeColor0: true));
            Assert.That(preview.Ok, Is.True, preview.Reason);

            Track(preview.Visual);
            var colors = preview.Visual.GetComponent<MeshFilter>().sharedMesh.colors;
            // COLOR_0 は normalized ubyte で (0, 255, 0, 128) を入れてある。
            Assert.That(colors[0].r, Is.EqualTo(0f).Within(0.01f));
            Assert.That(colors[0].g, Is.EqualTo(1f).Within(0.01f));
            Assert.That(colors[0].a, Is.EqualTo(128f / 255f).Within(0.01f));
        }

        [Test]
        public void PreviewDisposesGeneratedMeshAndDefaultMaterial()
        {
            var preview = SceneSyncGaussianSplatPreview.Build(BuildMinimalSplatGlb());
            Assert.That(preview.Ok, Is.True, preview.Reason);

            var mesh = preview.Visual.GetComponent<MeshFilter>().sharedMesh;
            var material = preview.Visual.GetComponent<MeshRenderer>().sharedMaterial;
            var hadMaterial = material != null;
            Assert.That(mesh, Is.Not.Null);

            UnityEngine.Object.DestroyImmediate(preview.Visual);

            Assert.That(mesh == null, Is.True, "generated preview mesh must be destroyed");
            if (hadMaterial)
                Assert.That(material == null, Is.True, "generated default material must be destroyed");
        }

        [Test]
        public void PreviewRefusesNonSplatInput()
        {
            var json = "{\"asset\":{\"version\":\"2.0\"},"
                + "\"meshes\":[{\"primitives\":[{\"mode\":4,\"attributes\":{\"POSITION\":0}}]}],"
                + "\"accessors\":[{\"count\":3,\"type\":\"VEC3\",\"componentType\":5126}]}";
            var preview = SceneSyncGaussianSplatPreview.Build(BuildGlb(json, new byte[16]));

            Assert.That(preview.Ok, Is.False);
            Assert.That(preview.Reason, Is.EqualTo("no-gaussian-splat-primitive"));
        }

        // --- backend ---------------------------------------------------------

        [Test]
        public void CreateVisualFallsBackToPreviewWithoutABackend()
        {
            SceneSyncGaussianSplatBackend.Unregister();
            Assert.That(SceneSyncGaussianSplatBackend.IsAvailable, Is.False);

            var visual = SceneSyncGaussianSplatBackend.CreateVisual(BuildMinimalSplatGlb());
            Assert.That(visual.Ok, Is.True, visual.Reason);
            Assert.That(visual.Source, Is.EqualTo(SceneSyncGaussianSplatBackend.SourcePreview));

            Track(visual.Visual);
            var marker = visual.Visual.GetComponent<SceneSyncGaussianSplatMarker>();
            Assert.That(marker, Is.Not.Null);
            Assert.That(marker.PointCount, Is.EqualTo(3));
        }

        [Test]
        public void CreateVisualUsesTheRegisteredBackend()
        {
            var backend = new StubBackend();
            SceneSyncGaussianSplatBackend.Register(backend);
            Assert.That(SceneSyncGaussianSplatBackend.BackendName, Is.EqualTo("StubBackend"));

            var visual = SceneSyncGaussianSplatBackend.CreateVisual(BuildMinimalSplatGlb());
            Track(visual.Visual);

            Assert.That(visual.Source, Is.EqualTo(SceneSyncGaussianSplatBackend.SourceBackend));
            Assert.That(backend.CallCount, Is.EqualTo(1));
            Assert.That(backend.LastInfo.SplatCount, Is.EqualTo(3));
            Assert.That(visual.Visual.GetComponent<SceneSyncGaussianSplatMarker>().BackendName,
                Is.EqualTo("StubBackend"));
        }

        [Test]
        public void CreateVisualFallsBackWhenTheBackendDeclines()
        {
            var backend = new StubBackend();
            backend.Accept = false;
            SceneSyncGaussianSplatBackend.Register(backend);

            var visual = SceneSyncGaussianSplatBackend.CreateVisual(BuildMinimalSplatGlb());
            Track(visual.Visual);

            Assert.That(visual.Source, Is.EqualTo(SceneSyncGaussianSplatBackend.SourcePreview));
            Assert.That(backend.CallCount, Is.EqualTo(0));
        }

        [Test]
        public void CreateVisualFallsBackWhenTheBackendReturnsNothing()
        {
            var backend = new StubBackend();
            backend.ReturnNull = true;
            SceneSyncGaussianSplatBackend.Register(backend);

            var visual = SceneSyncGaussianSplatBackend.CreateVisual(BuildMinimalSplatGlb());
            Track(visual.Visual);

            Assert.That(visual.Source, Is.EqualTo(SceneSyncGaussianSplatBackend.SourcePreview));
        }

        [Test]
        public void CreateVisualRefusesNonSplatGlb()
        {
            var json = "{\"asset\":{\"version\":\"2.0\"},\"meshes\":[]}";
            var visual = SceneSyncGaussianSplatBackend.CreateVisual(BuildGlb(json, new byte[4]));

            Assert.That(visual.Ok, Is.False);
            Assert.That(visual.Reason, Is.EqualTo("not-a-gaussian-splat-glb"));
        }

        // --- source component -------------------------------------------------

        [Test]
        public void SourceComponentBuildsAndClearsItsVisual()
        {
            var host = new GameObject("SplatHost");
            Track(host);
            var source = host.AddComponent<SceneSyncGaussianSplatSource>();

            Assert.That(source.LoadFromBytes(BuildMinimalSplatGlb()), Is.True);
            Assert.That(source.HasVisual, Is.True);
            Assert.That(source.Info.SplatCount, Is.EqualTo(3));
            Assert.That(source.VisualSource, Is.EqualTo(SceneSyncGaussianSplatBackend.SourcePreview));

            var root = host.transform.Find(SceneSyncGaussianSplatSource.VisualRootName);
            Assert.That(root, Is.Not.Null);
            Assert.That((root.gameObject.hideFlags & HideFlags.DontSave), Is.EqualTo(HideFlags.DontSave));
            Assert.That(root.localRotation.eulerAngles.y, Is.EqualTo(180f).Within(0.01f));

            // 読み直しても視覚ノードは1つだけ。
            Assert.That(source.LoadFromBytes(BuildMinimalSplatGlb()), Is.True);
            Assert.That(host.transform.childCount, Is.EqualTo(1));

            source.ClearVisual();
            Assert.That(source.HasVisual, Is.False);
            Assert.That(source.Info, Is.Null);
        }

        [Test]
        public void SourceComponentRejectsPlainMeshGlb()
        {
            var host = new GameObject("SplatHost");
            Track(host);
            var source = host.AddComponent<SceneSyncGaussianSplatSource>();

            var json = "{\"asset\":{\"version\":\"2.0\"},\"meshes\":[]}";
            Assert.That(source.LoadFromBytes(BuildGlb(json, new byte[4])), Is.False);
            Assert.That(source.HasVisual, Is.False);
        }

        // --- helpers ---------------------------------------------------------

        private sealed class StubBackend : ISceneSyncGaussianSplatBackend
        {
            public bool Accept = true;
            public bool ReturnNull;
            public int CallCount;
            public SceneSyncGaussianSplatGlbInfo LastInfo;

            public string Name
            {
                get { return "StubBackend"; }
            }

            public bool CanRender(SceneSyncGaussianSplatGlbInfo info)
            {
                LastInfo = info;
                return Accept;
            }

            public GameObject CreateSplatObject(byte[] glb, SceneSyncGaussianSplatGlbInfo info)
            {
                CallCount++;
                return ReturnNull ? null : new GameObject("StubSplatObject");
            }
        }

        private void Track(GameObject go)
        {
            if (go != null) _spawned.Add(go);
        }

        private static SceneSyncGaussianSplatGlbInfo InspectJson(string json)
        {
            return SceneSyncGaussianSplatGlb.Inspect(BuildGlb(json, new byte[16]));
        }

        private static string SplatPrimitiveJson(
            int mode = 0,
            string attributes = null,
            string extension = null,
            string kernel = "ellipse")
        {
            if (attributes == null)
            {
                attributes = "{"
                    + "\"POSITION\":0,"
                    + "\"KHR_gaussian_splatting:ROTATION\":1,"
                    + "\"KHR_gaussian_splatting:SCALE\":2,"
                    + "\"KHR_gaussian_splatting:OPACITY\":3,"
                    + "\"KHR_gaussian_splatting:SH_DEGREE_0_COEF_0\":4"
                    + "}";
            }

            if (extension == null)
            {
                extension = "{"
                    + "\"kernel\":\"" + kernel + "\","
                    + "\"colorSpace\":\"srgb_rec709_display\","
                    + "\"projection\":\"perspective\","
                    + "\"sortingMethod\":\"cameraDistance\""
                    + "}";
            }

            return "{\"mode\":" + mode + ",\"attributes\":" + attributes
                + ",\"extensions\":{\"KHR_gaussian_splatting\":" + extension + "}}";
        }

        private static string SplatGltfJson(
            int mode = 0,
            string attributes = null,
            string extension = null,
            string kernel = "ellipse",
            string extensionsUsed = "[\"KHR_gaussian_splatting\"]",
            string meshes = null)
        {
            if (meshes == null)
            {
                meshes = "[{\"primitives\":["
                    + SplatPrimitiveJson(mode, attributes, extension, kernel)
                    + "]}]";
            }

            return "{\"asset\":{\"version\":\"2.0\"},"
                + "\"extensionsUsed\":" + extensionsUsed + ","
                + "\"meshes\":" + meshes + ","
                + "\"accessors\":["
                + "{\"count\":3,\"type\":\"VEC3\",\"componentType\":5126},"
                + "{\"count\":3,\"type\":\"VEC4\",\"componentType\":5126},"
                + "{\"count\":3,\"type\":\"VEC3\",\"componentType\":5126},"
                + "{\"count\":3,\"type\":\"SCALAR\",\"componentType\":5126},"
                + "{\"count\":3,\"type\":\"VEC3\",\"componentType\":5126}"
                + "]}";
        }

        /// <summary>
        /// 3 splat の最小 KHR_gaussian_splatting GLB。
        /// scripts/generate-minimal-khr-gaussian-splatting.mjs と同じ構成。
        /// </summary>
        internal static byte[] BuildMinimalSplatGlb(bool includeColor0 = false)
        {
            var positions = new[]
            {
                new Vector3(-0.6f, -0.4f, 0f),
                new Vector3(0f, -0.4f, 0f),
                new Vector3(0.6f, -0.4f, 0f),
            };
            var colors = new[]
            {
                new Color(1f, 0.2f, 0.2f),
                new Color(0.2f, 1f, 0.2f),
                new Color(0.2f, 0.4f, 1f),
            };

            var bin = new List<byte>();

            var positionOffset = bin.Count;
            foreach (var position in positions)
            {
                AppendFloat(bin, position.x);
                AppendFloat(bin, position.y);
                AppendFloat(bin, position.z);
            }

            var rotationOffset = bin.Count;
            for (var i = 0; i < positions.Length; i++)
            {
                AppendFloat(bin, 0f);
                AppendFloat(bin, 0f);
                AppendFloat(bin, 0f);
                AppendFloat(bin, 1f);
            }

            var scaleOffset = bin.Count;
            for (var i = 0; i < positions.Length; i++)
            {
                AppendFloat(bin, 0.1f);
                AppendFloat(bin, 0.1f);
                AppendFloat(bin, 0.1f);
            }

            var opacityOffset = bin.Count;
            for (var i = 0; i < positions.Length; i++) AppendFloat(bin, 0.95f);

            var sh0Offset = bin.Count;
            foreach (var color in colors)
            {
                AppendFloat(bin, (color.r - 0.5f) / ShC0);
                AppendFloat(bin, (color.g - 0.5f) / ShC0);
                AppendFloat(bin, (color.b - 0.5f) / ShC0);
            }

            var color0Offset = bin.Count;
            if (includeColor0)
            {
                for (var i = 0; i < positions.Length; i++)
                {
                    bin.Add(0);
                    bin.Add(255);
                    bin.Add(0);
                    bin.Add(128);
                }
            }

            var count = positions.Length;
            var bufferViews = new StringBuilder();
            bufferViews.Append('[');
            AppendBufferView(bufferViews, positionOffset, count * 12, false);
            AppendBufferView(bufferViews, rotationOffset, count * 16, true);
            AppendBufferView(bufferViews, scaleOffset, count * 12, true);
            AppendBufferView(bufferViews, opacityOffset, count * 4, true);
            AppendBufferView(bufferViews, sh0Offset, count * 12, true);
            if (includeColor0) AppendBufferView(bufferViews, color0Offset, count * 4, true);
            bufferViews.Append(']');

            var accessors = new StringBuilder();
            accessors.Append('[');
            accessors.Append("{\"bufferView\":0,\"byteOffset\":0,\"componentType\":5126,\"count\":")
                .Append(count).Append(",\"type\":\"VEC3\"}");
            accessors.Append(",{\"bufferView\":1,\"byteOffset\":0,\"componentType\":5126,\"count\":")
                .Append(count).Append(",\"type\":\"VEC4\"}");
            accessors.Append(",{\"bufferView\":2,\"byteOffset\":0,\"componentType\":5126,\"count\":")
                .Append(count).Append(",\"type\":\"VEC3\"}");
            accessors.Append(",{\"bufferView\":3,\"byteOffset\":0,\"componentType\":5126,\"count\":")
                .Append(count).Append(",\"type\":\"SCALAR\"}");
            accessors.Append(",{\"bufferView\":4,\"byteOffset\":0,\"componentType\":5126,\"count\":")
                .Append(count).Append(",\"type\":\"VEC3\"}");
            if (includeColor0)
            {
                accessors.Append(",{\"bufferView\":5,\"byteOffset\":0,\"componentType\":5121,\"count\":")
                    .Append(count).Append(",\"type\":\"VEC4\",\"normalized\":true}");
            }

            accessors.Append(']');

            var attributes = new StringBuilder();
            attributes.Append("{\"POSITION\":0");
            if (includeColor0) attributes.Append(",\"COLOR_0\":5");
            attributes.Append(",\"KHR_gaussian_splatting:ROTATION\":1");
            attributes.Append(",\"KHR_gaussian_splatting:SCALE\":2");
            attributes.Append(",\"KHR_gaussian_splatting:OPACITY\":3");
            attributes.Append(",\"KHR_gaussian_splatting:SH_DEGREE_0_COEF_0\":4}");

            var json = "{\"asset\":{\"version\":\"2.0\"},"
                + "\"extensionsUsed\":[\"KHR_gaussian_splatting\"],"
                + "\"scene\":0,\"scenes\":[{\"nodes\":[0]}],\"nodes\":[{\"mesh\":0}],"
                + "\"meshes\":[{\"primitives\":[" + SplatPrimitiveJson(0, attributes.ToString()) + "]}],"
                + "\"buffers\":[{\"byteLength\":" + bin.Count + "}],"
                + "\"bufferViews\":" + bufferViews
                + ",\"accessors\":" + accessors + "}";

            return BuildGlb(json, bin.ToArray());
        }

        private static void AppendBufferView(StringBuilder builder, int byteOffset, int byteLength, bool comma)
        {
            if (comma) builder.Append(',');
            builder.Append("{\"buffer\":0,\"byteOffset\":").Append(byteOffset)
                .Append(",\"byteLength\":").Append(byteLength).Append('}');
        }

        private static void AppendFloat(List<byte> target, float value)
        {
            target.AddRange(BitConverter.GetBytes(value));
        }

        private static byte[] BuildGlb(string json, byte[] bin)
        {
            var jsonBytes = Encoding.UTF8.GetBytes(json);
            var paddedJsonLength = Align4(jsonBytes.Length);
            var paddedBinLength = Align4(bin.Length);
            var total = 12 + 8 + paddedJsonLength + 8 + paddedBinLength;

            var glb = new byte[total];
            var offset = 0;

            WriteUInt32(glb, offset, 0x46546C67); offset += 4;
            WriteUInt32(glb, offset, 2); offset += 4;
            WriteUInt32(glb, offset, (uint)total); offset += 4;

            WriteUInt32(glb, offset, (uint)paddedJsonLength); offset += 4;
            WriteUInt32(glb, offset, 0x4E4F534A); offset += 4;
            Array.Copy(jsonBytes, 0, glb, offset, jsonBytes.Length);
            for (var i = jsonBytes.Length; i < paddedJsonLength; i++) glb[offset + i] = 0x20;
            offset += paddedJsonLength;

            WriteUInt32(glb, offset, (uint)paddedBinLength); offset += 4;
            WriteUInt32(glb, offset, 0x004E4942); offset += 4;
            Array.Copy(bin, 0, glb, offset, bin.Length);

            return glb;
        }

        private static int Align4(int value)
        {
            return (value + 3) & ~3;
        }

        private static void WriteUInt32(byte[] target, int offset, uint value)
        {
            target[offset] = (byte)(value & 0xFF);
            target[offset + 1] = (byte)((value >> 8) & 0xFF);
            target[offset + 2] = (byte)((value >> 16) & 0xFF);
            target[offset + 3] = (byte)((value >> 24) & 0xFF);
        }
    }
}
