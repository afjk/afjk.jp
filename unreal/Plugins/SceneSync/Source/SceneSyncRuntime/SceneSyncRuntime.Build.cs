using UnrealBuildTool;
using System.IO;

public class SceneSyncRuntime : ModuleRules
{
    public SceneSyncRuntime(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
            "Json",
            "JsonUtilities",
            "HTTP",
            "WebSockets",
        });

        // Optional glTFRuntime integration for runtime glB import
        string glTFRuntimePath = Path.Combine(PluginDirectory, "..", "glTFRuntime");
        if (Directory.Exists(glTFRuntimePath))
        {
            PublicDependencyModuleNames.Add("glTFRuntime");
            PublicDefinitions.Add("WITH_GLTFRUNTIME=1");
        }
        else
        {
            PublicDefinitions.Add("WITH_GLTFRUNTIME=0");
        }
    }
}
