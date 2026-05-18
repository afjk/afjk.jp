#if UNITY_EDITOR
using System;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;
using UnityEngine;

namespace Afjk.SceneSync.Editor
{
    internal static class SceneSyncUnityGltfInstaller
    {
        internal const string Define = "SCENESYNC_USE_UNITYGLTF";
        internal const string PackageUrl = "https://github.com/KhronosGroup/UnityGLTF.git";

        private static AddRequest _addRequest;
        private static ListRequest _listRequest;
        private static bool? _isUnityGltfPackageInstalled;

        public static bool IsInstalling => _addRequest != null;
        public static bool IsCheckingPackageStatus => _listRequest != null;
        public static bool IsUnityGltfPackageInstalled => _isUnityGltfPackageInstalled == true;

        public static void RefreshUnityGltfPackageStatus()
        {
            if (_listRequest != null) return;

            _listRequest = Client.List(true);
            EditorApplication.update += PollPackageList;
        }

        private static void PollPackageList()
        {
            if (_listRequest == null) return;
            if (!_listRequest.IsCompleted) return;

            if (_listRequest.Status == StatusCode.Success)
            {
                _isUnityGltfPackageInstalled = _listRequest.Result.Any(package =>
                    package.name == "com.khronos.unitygltf" ||
                    package.displayName.Contains("UnityGLTF") ||
                    package.packageId.Contains("KhronosGroup/UnityGLTF")
                );
            }
            else
            {
                Debug.LogWarning("[SceneSync] Failed to check UnityGLTF package status: " + _listRequest.Error.message);
                _isUnityGltfPackageInstalled = null;
            }

            _listRequest = null;
            EditorApplication.update -= PollPackageList;
        }

        public static bool IsUnityGltfDefineEnabled()
        {
#if UNITY_2021_2_OR_NEWER
            var target = NamedBuildTarget.FromBuildTargetGroup(EditorUserBuildSettings.selectedBuildTargetGroup);
            var defines = PlayerSettings.GetScriptingDefineSymbols(target);
#else
            var group = EditorUserBuildSettings.selectedBuildTargetGroup;
            var defines = PlayerSettings.GetScriptingDefineSymbolsForGroup(group);
#endif
            return defines.Split(';').Any(x => x == Define);
        }

        public static void EnsureUnityGltfDefine()
        {
#if UNITY_2021_2_OR_NEWER
            var target = NamedBuildTarget.FromBuildTargetGroup(EditorUserBuildSettings.selectedBuildTargetGroup);
            var defines = PlayerSettings.GetScriptingDefineSymbols(target);
            if (defines.Split(';').Any(x => x == Define)) return;

            PlayerSettings.SetScriptingDefineSymbols(
                target,
                string.IsNullOrWhiteSpace(defines) ? Define : defines + ";" + Define
            );
#else
            var group = EditorUserBuildSettings.selectedBuildTargetGroup;
            var defines = PlayerSettings.GetScriptingDefineSymbolsForGroup(group);
            if (defines.Split(';').Any(x => x == Define)) return;

            PlayerSettings.SetScriptingDefineSymbolsForGroup(
                group,
                string.IsNullOrWhiteSpace(defines) ? Define : defines + ";" + Define
            );
#endif
        }

        public static void InstallUnityGltf()
        {
            if (_addRequest != null)
            {
                Debug.Log("[SceneSync] UnityGLTF installation is already running.");
                return;
            }

            Debug.Log("[SceneSync] Installing UnityGLTF: " + PackageUrl);
            _addRequest = Client.Add(PackageUrl);
            EditorApplication.update += PollInstall;
        }

        private static void PollInstall()
        {
            if (_addRequest == null) return;
            if (!_addRequest.IsCompleted) return;

            if (_addRequest.Status == StatusCode.Success)
            {
                Debug.Log("[SceneSync] UnityGLTF installed: " + _addRequest.Result.packageId);
                _isUnityGltfPackageInstalled = true;
                EnsureUnityGltfDefine();

                EditorUtility.DisplayDialog(
                    "Scene Sync",
                    "UnityGLTF has been installed. Unity may recompile scripts now.",
                    "OK"
                );
            }
            else if (_addRequest.Status == StatusCode.Failure)
            {
                Debug.LogError("[SceneSync] Failed to install UnityGLTF: " + _addRequest.Error.message);
                EditorUtility.DisplayDialog(
                    "Scene Sync",
                    "Failed to install UnityGLTF:\n" + _addRequest.Error.message,
                    "OK"
                );
            }

            _addRequest = null;
            EditorApplication.update -= PollInstall;
        }
    }
}
#endif
