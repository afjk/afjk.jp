#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "SceneSyncTypes.h"
#include "SceneSyncBlobClient.h"
#include "Dom/JsonObject.h"
#include "Containers/Ticker.h"
#include "SceneSyncPresenceClient.h"
#include "SceneSyncSubsystem.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnSceneSyncConnectedBP);
DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnSceneSyncDisconnectedBP);

UCLASS()
class SCENESYNCRUNTIME_API USceneSyncSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Deinitialize() override;

    UFUNCTION(BlueprintCallable, Category = "SceneSync")
    void Connect(const FString& PresenceUrl, const FString& Room, const FString& Nickname = TEXT("Unreal"));

    UFUNCTION(BlueprintCallable, Category = "SceneSync")
    void Disconnect();

    UFUNCTION(BlueprintCallable, Category = "SceneSync")
    bool IsConnected() const;

    UFUNCTION(BlueprintCallable, Category = "SceneSync")
    void SelectObject(AActor* Actor);

    UFUNCTION(BlueprintCallable, Category = "SceneSync")
    void DeselectObject();

    UFUNCTION(BlueprintCallable, Category = "SceneSync")
    void SyncAllMeshes();

    const TArray<FSceneSyncPeerInfo>& GetPeers() const;

    UPROPERTY(BlueprintAssignable, Category = "SceneSync")
    FOnSceneSyncConnectedBP OnConnectedBP;

    UPROPERTY(BlueprintAssignable, Category = "SceneSync")
    FOnSceneSyncDisconnectedBP OnDisconnectedBP;

private:
    bool Tick(float DeltaTime);

    void OnClientConnected();
    void OnClientDisconnected();
    void OnPeersUpdated(const TArray<FSceneSyncPeerInfo>& Peers);
    void OnHandoffReceived(TSharedPtr<FJsonObject> Payload);

    // Scene receive handlers
    void HandleSceneState(const TSharedPtr<FJsonObject>& Payload);
    void HandleSceneAdd(const TSharedPtr<FJsonObject>& Payload);
    void HandleSceneDelta(const TSharedPtr<FJsonObject>& Payload);
    void HandleSceneRemove(const TSharedPtr<FJsonObject>& Payload);
    void HandleSceneLock(const TSharedPtr<FJsonObject>& Payload, const FString& FromId);
    void HandleSceneUnlock(const TSharedPtr<FJsonObject>& Payload);
    void HandleSceneRequest(const FString& FromId);
    void HandleSceneMesh(const TSharedPtr<FJsonObject>& Payload);

    // Scene send helpers
    void SendTransformDelta();
    void SendSceneAdd(AActor* Actor);
    void SendSceneRemove(const FString& ObjectId);
    void SendSceneState(const FString& TargetId);
    void DetectHierarchyChanges();

    // Actor spawn helpers
    AActor* SpawnPrimitive(const FString& ObjectId, const FString& PrimitiveType, const FString& Color);
    void DownloadAndCreateObject(const FString& ObjectId, const FString& Name,
                                  const FString& MeshPath,
                                  const FVector& Pos, const FQuat& Rot, const FVector& Scale);
    void ApplyTransformToActor(AActor* Actor, const FVector& Pos, const FQuat& Rot, const FVector& Scale);
    void OnGlbDownloaded(bool bSuccess, TArray<uint8> Data,
                          FString ObjectId, FString Name,
                          FVector Pos, FQuat Rot, FVector Scale);

    // Export actor mesh as glB bytes (UE 5.4+ GLTFExporter, no-op if unavailable)
    bool ExportActorAsGlb(AActor* Actor, TArray<uint8>& OutData);
    FString GetOrAssignObjectId(AActor* Actor);
    AActor* FindActorByObjectId(const FString& ObjectId) const;
    FString GetObjectIdFromActor(const AActor* Actor) const;

    TUniquePtr<FSceneSyncPresenceClient> Client;
    FSceneSyncBlobClient BlobClient;

    // Managed scene state
    TMap<FString, TWeakObjectPtr<AActor>> ManagedActors;
    TSet<FString> KnownObjectIds;
    TMap<FString, FString> MeshPaths;
    TMap<FString, FString> Locks;  // objectId -> lockOwnerId
    FString CurrentlyLockedId;
    TWeakObjectPtr<AActor> SelectedActor;

    struct FTransformSnapshot
    {
        FVector Pos;
        FQuat Rot;
        FVector Scale;
    };
    TMap<FString, FTransformSnapshot> LastSnapshots;

    double LastSendTime = 0.0;
    static constexpr double SendInterval = 0.05;

    double LastHierarchyCheckTime = 0.0;
    static constexpr double HierarchyCheckInterval = 0.5;

    bool bSceneReceived = false;
    bool bFirstPeersReceived = false;

    FTSTicker::FDelegateHandle TickDelegateHandle;
};
