#pragma once

#include "CoreMinimal.h"
#include "SceneSyncTypes.h"
#include "Dom/JsonObject.h"

class SCENESYNCRUNTIME_API FSceneSyncProtocol
{
public:
    // --- Coordinate conversion: Three.js Y-up right-hand meters <-> UE Z-up left-hand cm ---

    static FVector PosFromWire(const TArray<double>& W);
    static TArray<double> PosToWire(const FVector& V);
    static FQuat RotFromWire(const TArray<double>& W);
    static TArray<double> RotToWire(const FQuat& Q);
    static FVector ScaleFromWire(const TArray<double>& W);
    static TArray<double> ScaleToWire(const FVector& V);

    // --- Message builders ---

    static FString MakeSceneDelta(const FString& ObjectId, const FVector& Pos, const FQuat& Rot, const FVector& Scale);
    static FString MakeSceneAdd(const FString& ObjectId, const FString& Name,
                                const FVector& Pos, const FQuat& Rot, const FVector& Scale,
                                const FString& MeshPath = TEXT(""),
                                const TSharedPtr<FJsonObject>& Asset = nullptr);
    static FString MakeSceneRemove(const FString& ObjectId);
    static FString MakeSceneMesh(const FString& ObjectId, const FString& MeshPath);
    static FString MakeSceneLock(const FString& ObjectId);
    static FString MakeSceneUnlock(const FString& ObjectId);
    static FString MakeSceneRequest();
    static FString MakeSceneState(const TMap<FString, TSharedPtr<FJsonObject>>& Objects);

    // --- Message parsers ---

    static TSharedPtr<FJsonObject> ParsePayload(const FString& RawJson);
    static FString ExtractKind(const TSharedPtr<FJsonObject>& Obj);
    static FString ExtractFromId(const TSharedPtr<FJsonObject>& Obj);
    static FString ExtractObjectId(const TSharedPtr<FJsonObject>& Obj);
    static FSceneSyncTransformData ExtractTransform(const TSharedPtr<FJsonObject>& Obj);

private:
    static FString SerializeJson(const TSharedPtr<FJsonObject>& Obj);
    static TArray<double> GetDoubleArray(const TSharedPtr<FJsonObject>& Obj, const FString& Key);
};
