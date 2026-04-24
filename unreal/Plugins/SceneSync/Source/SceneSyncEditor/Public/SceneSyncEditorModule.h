#pragma once

#include "Modules/ModuleManager.h"
#include "Framework/Docking/TabManager.h"

class FSceneSyncEditorModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

private:
    TSharedRef<SDockTab> OnSpawnTab(const FSpawnTabArgs& Args);
    void RegisterMenuEntry();
    void OnEditorSelectionChanged(UObject* NewSelection);
};
