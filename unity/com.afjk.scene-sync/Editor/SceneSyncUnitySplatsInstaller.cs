#if UNITY_EDITOR
using System;
using System.Linq;
using UnityEditor;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;
using UnityEngine;

namespace Afjk.SceneSync.Editor
{
    /// <summary>
    /// UnitySplats と Unity.WebP を、動作確認済みの固定 tag で target project に追加する。
    /// Git package は package.json の推移依存にできないため、導入は consuming project の
    /// manifest に対して Unity Package Manager 経由で行う。
    /// </summary>
    [InitializeOnLoad]
    internal static class SceneSyncUnitySplatsInstaller
    {
        internal const string UnityWebPUrl =
            "https://github.com/netpyoung/unity.webp.git?path=unity_project/Assets/unity.webp#0.3.22";
        internal const string UnitySplatsUrl =
            "https://github.com/arloopa/UnitySplats.git#v1.2.0";

        private const string ReloadAfterInstallKey = "SceneSync.UnitySplats.ReloadAfterInstall";

        private static AddRequest _addRequest;
        private static int _installStep;

        static SceneSyncUnitySplatsInstaller()
        {
            EditorApplication.delayCall += CompletePendingInstallation;
        }

        internal static bool IsInstalling
        {
            get { return _addRequest != null; }
        }

        [MenuItem("Tools/Scene Sync/Install UnitySplats Renderer...", false, 151)]
        internal static void InstallUnitySplats()
        {
            if (_addRequest != null)
            {
                Debug.Log("[SceneSync] UnitySplats installation is already running.");
                return;
            }

            int unityMajor;
            if (!int.TryParse(Application.unityVersion.Split('.')[0], out unityMajor) || unityMajor < 6000)
            {
                EditorUtility.DisplayDialog(
                    "Scene Sync",
                    "UnitySplats v1.2.0 requires Unity 6 (6000.0) or newer.\n"
                    + "This project is running Unity " + Application.unityVersion + ".",
                    "OK");
                return;
            }

            if (!EditorUtility.DisplayDialog(
                    "Install UnitySplats Renderer",
                    "Scene Sync will add these pinned Git packages to this project's manifest:\n\n"
                    + "Unity.WebP 0.3.22\n"
                    + "UnitySplats v1.2.0 (commit "
                    + SceneSyncUnitySplatsBackend.PackageCommit.Substring(0, 12) + ")\n\n"
                    + "Continue?",
                    "Install",
                    "Cancel"))
                return;

            _installStep = 0;
            AddCurrentPackage();
        }

        private static void AddCurrentPackage()
        {
            var url = _installStep == 0 ? UnityWebPUrl : UnitySplatsUrl;
            Debug.Log("[SceneSync] Installing Gaussian Splat renderer dependency: " + url);
            _addRequest = Client.Add(url);
            EditorApplication.update += PollInstall;
        }

        private static void PollInstall()
        {
            if (_addRequest == null || !_addRequest.IsCompleted) return;

            EditorApplication.update -= PollInstall;
            if (_addRequest.Status != StatusCode.Success)
            {
                var message = _addRequest.Error == null ? "unknown package manager error" : _addRequest.Error.message;
                Debug.LogError("[SceneSync] Failed to install UnitySplats dependency: " + message);
                EditorUtility.DisplayDialog(
                    "Scene Sync",
                    "Failed to install the UnitySplats renderer dependency:\n" + message,
                    "OK");
                _addRequest = null;
                _installStep = 0;
                return;
            }

            Debug.Log("[SceneSync] Installed: " + _addRequest.Result.packageId);
            _addRequest = null;
            _installStep++;
            if (_installStep < 2)
            {
                AddCurrentPackage();
                return;
            }

            _installStep = 0;
            SessionState.SetBool(ReloadAfterInstallKey, true);
            Debug.Log("[SceneSync] UnitySplats installed. Waiting for script reload before rebuilding splats.");
        }

        private static void CompletePendingInstallation()
        {
            if (!SessionState.GetBool(ReloadAfterInstallKey, false)) return;
            if (!SceneSyncGaussianSplatBackend.ResetToDefaultBackend()) return;

            SessionState.EraseBool(ReloadAfterInstallKey);
            var sources = Resources.FindObjectsOfTypeAll<SceneSyncGaussianSplatSource>()
                .Where(source => source != null && source.gameObject.scene.IsValid())
                .ToArray();
            foreach (var source in sources) source.Reload();

            SceneView.RepaintAll();
            EditorUtility.DisplayDialog(
                "Scene Sync",
                "UnitySplats v1.2.0 is active. Existing Gaussian Splat previews were rebuilt with the real renderer.",
                "OK");
        }
    }
}
#endif
