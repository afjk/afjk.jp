#pragma once

#include "Modules/ModuleManager.h"

class FSceneSyncEditorModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;
};
