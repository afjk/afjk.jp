using System;
using System.IO;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;

namespace Afjk.SceneSync.Tests
{
    /// <summary>
    /// UnitySplats が target project に入っているとき、reflection adapter が本物の
    /// GsplatRenderer / GsplatAsset を生成し、破棄まで完了することを確認する。
    /// optional dependency 未導入 project では明示的に skip する。
    /// </summary>
    public sealed class SceneSyncUnitySplatsBackendTests
    {
        [TearDown]
        public void TearDown()
        {
            SceneSyncGaussianSplatBackend.Unregister();
        }

        [Test]
        public void CreatesAndDisposesARealUnitySplatsObject()
        {
            ISceneSyncGaussianSplatBackend detected;
            if (!SceneSyncUnitySplatsBackend.TryCreate(out detected))
                Assert.Ignore("UnitySplats v1.2.0 is not installed in this test project");

            Assert.That(SceneSyncGaussianSplatBackend.ResetToDefaultBackend(), Is.True);
            Assert.That(SceneSyncGaussianSplatBackend.BackendName,
                Is.EqualTo(SceneSyncUnitySplatsBackend.DisplayName));

            var visual = SceneSyncGaussianSplatBackend.CreateVisual(
                SceneSyncGaussianSplatGlbTests.BuildMinimalSplatGlb());
            Assert.That(visual.Ok, Is.True, visual.Reason);
            Assert.That(visual.Source, Is.EqualTo(SceneSyncGaussianSplatBackend.SourceBackend));

            var rendererType = Type.GetType("Gsplat.GsplatRenderer, Gsplat", true);
            var renderer = visual.Visual.GetComponent(rendererType);
            Assert.That(renderer, Is.Not.Null, "real GsplatRenderer component");

            var assetField = rendererType.GetField("GsplatAsset", BindingFlags.Public | BindingFlags.Instance);
            var asset = assetField.GetValue(renderer) as UnityEngine.Object;
            Assert.That(asset, Is.Not.Null, "runtime GsplatAsset");

            var splatCount = asset.GetType().GetField("SplatCount").GetValue(asset);
            Assert.That(Convert.ToUInt32(splatCount), Is.EqualTo(3u));
            Assert.That(visual.Visual.GetComponent<SceneSyncUnitySplatsOwnedAsset>().RuntimeAsset,
                Is.SameAs(asset));

            UnityEngine.Object.DestroyImmediate(visual.Visual);
            Assert.That(asset == null, Is.True, "runtime GsplatAsset must be destroyed with the visual");
        }

        [Test]
        public void LoadsConfiguredRealCaptureWithAllSphericalHarmonics()
        {
            var path = Environment.GetEnvironmentVariable("SCENESYNC_GAUSSIAN_GLB_FIXTURE");
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
                Assert.Ignore("SCENESYNC_GAUSSIAN_GLB_FIXTURE is not configured");

            ISceneSyncGaussianSplatBackend detected;
            if (!SceneSyncUnitySplatsBackend.TryCreate(out detected))
                Assert.Ignore("UnitySplats v1.2.0 is not installed in this test project");

            var bytes = File.ReadAllBytes(path);
            var info = SceneSyncGaussianSplatGlb.Inspect(bytes);
            Assert.That(info.Valid, Is.True, string.Join("; ", info.Errors));
            Assert.That(info.SplatCount, Is.GreaterThan(0));

            SceneSyncGaussianSplatBackend.ResetToDefaultBackend();
            var visual = SceneSyncGaussianSplatBackend.CreateVisual(bytes, info);
            Assert.That(visual.Source, Is.EqualTo(SceneSyncGaussianSplatBackend.SourceBackend));

            var rendererType = Type.GetType("Gsplat.GsplatRenderer, Gsplat", true);
            var renderer = visual.Visual.GetComponent(rendererType);
            var asset = rendererType.GetField("GsplatAsset").GetValue(renderer) as UnityEngine.Object;
            Assert.That(asset, Is.Not.Null);
            Assert.That(Convert.ToUInt32(asset.GetType().GetField("SplatCount").GetValue(asset)),
                Is.EqualTo((uint)info.SplatCount));
            Assert.That(Convert.ToByte(asset.GetType().GetField("SHBands").GetValue(asset)),
                Is.EqualTo(3), "SH degree 3 must reach the renderer asset");

            UnityEngine.Object.DestroyImmediate(visual.Visual);
            Assert.That(asset == null, Is.True);
        }
    }
}
