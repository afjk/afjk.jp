#pragma once

#include "CoreMinimal.h"
#include "EditorSubsystem.h"
#include "SceneSyncPresenceClient.h"
#include "SceneSyncBlobClient.h"
#include "SceneSyncTypes.h"
#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "SceneSyncEditorSubsystem.generated.h"

UCLASS()
class USceneSyncEditorSubsystem : public UEditorSubsystem
{
    GENERATED_BODY()

public:
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Deinitialize() override;

    void Connect(const FString& Url, const FString& Room, const FString& Nickname);
    void Disconnect();
    bool IsConnected() const;
    const TArray<FSceneSyncPeerInfo>& GetPeers() const;

private:
    bool Tick(float DeltaTime);
    void OnClientConnected();
    void OnClientDisconnected();
    void OnPeersUpdated(const TArray<FSceneSyncPeerInfo>& Peers);
    void OnHandoffReceived(TSharedPtr<FJsonObject> Payload);

    void HandleSceneState(const TSharedPtr<FJsonObject>& Payload);
    void HandleSceneAdd(const TSharedPtr<FJsonObject>& Payload);
    void HandleSceneDelta(const TSharedPtr<FJsonObject>& Payload);
    void HandleSceneRemove(const TSharedPtr<FJsonObject>& Payload);
    void HandleSceneMesh(const TSharedPtr<FJsonObject>& Payload);
    void HandleSceneRequest(const FString& FromId);
    void SendSceneState(const FString& TargetId);

    void DownloadAndCreateObject(const FString& ObjectId, const FString& Name, const FString& MeshPath,
                                  const FVector& Pos, const FQuat& Rot, const FVector& Scale);
    void OnGlbDownloaded(bool bSuccess, TArray<uint8> Data,
                          FString ObjectId, FString Name, FVector Pos, FQuat Rot, FVector Scale);

    AActor* SpawnPrimitive(const FString& ObjectId, const FString& PrimitiveType, const FString& Color);
    void ApplyTransformToActor(AActor* Actor, const FVector& Pos, const FQuat& Rot, const FVector& Scale);
    AActor* FindActorByObjectId(const FString& ObjectId) const;
    FString GetObjectIdFromActor(const AActor* Actor) const;
    UWorld* GetEditorWorld() const;

    TUniquePtr<FSceneSyncPresenceClient> Client;
    FSceneSyncBlobClient BlobClient;

    TMap<FString, TWeakObjectPtr<AActor>> ManagedActors;
    TSet<FString> KnownObjectIds;
    TMap<FString, FString> MeshPaths;

    bool bFirstPeersReceived = false;

    FTSTicker::FDelegateHandle TickDelegateHandle;
};
