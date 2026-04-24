#include "SceneSyncEditorModule.h"
#include "Modules/ModuleManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogSceneSyncEditor, Log, All);

void FSceneSyncEditorModule::StartupModule()
{
    UE_LOG(LogSceneSyncEditor, Log, TEXT("SceneSyncEditor: StartupModule"));
}

void FSceneSyncEditorModule::ShutdownModule()
{
    UE_LOG(LogSceneSyncEditor, Log, TEXT("SceneSyncEditor: ShutdownModule"));
}

IMPLEMENT_MODULE(FSceneSyncEditorModule, SceneSyncEditor)
