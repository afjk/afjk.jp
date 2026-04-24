using UnrealBuildTool;

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
            "Slate",
            "SlateCore",
            "EditorStyle",
            "LevelEditor",
            "ToolMenus",
            "WorkspaceMenuStructure",
            "SceneSyncRuntime",
        });
    }
}
