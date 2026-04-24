#include "SceneSyncRuntimeModule.h"
#include "Modules/ModuleManager.h"
#include "WebSocketsModule.h"

DEFINE_LOG_CATEGORY_STATIC(LogSceneSync, Log, All);

void FSceneSyncRuntimeModule::StartupModule()
{
    UE_LOG(LogSceneSync, Log, TEXT("SceneSyncRuntime: StartupModule"));
    FModuleManager::LoadModuleChecked<FWebSocketsModule>("WebSockets");
}

void FSceneSyncRuntimeModule::ShutdownModule()
{
    UE_LOG(LogSceneSync, Log, TEXT("SceneSyncRuntime: ShutdownModule"));
}

IMPLEMENT_MODULE(FSceneSyncRuntimeModule, SceneSyncRuntime)
