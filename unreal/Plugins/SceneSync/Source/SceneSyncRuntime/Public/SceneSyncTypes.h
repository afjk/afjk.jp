#pragma once

#include "CoreMinimal.h"

struct FSceneSyncPeerInfo
{
    FString Id;
    FString Nickname;
    FString Device;
    double LastSeen = 0.0;
};

struct FSceneSyncTransformData
{
    FVector Position = FVector::ZeroVector;
    FQuat Rotation = FQuat::Identity;
    FVector Scale = FVector::OneVector;
    bool bHasPosition = false;
    bool bHasRotation = false;
    bool bHasScale = false;
};
