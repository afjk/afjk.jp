using UnrealBuildTool;
using System.IO;

public class SceneSyncEditor : ModuleRules
{
    public SceneSyncEditor(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
            "UnrealEd",
            "EditorSubsystem",
            "Slate",
            "SlateCore",
            "LevelEditor",
            "ToolMenus",
            "WorkspaceMenuStructure",
            "Json",
            "JsonUtilities",
            "HTTP",
            "WebSockets",
            "SceneSyncRuntime",
        });

        string glTFRuntimePath = Path.Combine(PluginDirectory, "..", "glTFRuntime");
        if (Directory.Exists(glTFRuntimePath))
        {
            PublicDependencyModuleNames.Add("glTFRuntime");
        }
    }
}
