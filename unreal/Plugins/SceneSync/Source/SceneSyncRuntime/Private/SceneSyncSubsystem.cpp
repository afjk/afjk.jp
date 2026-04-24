#include "SceneSyncSubsystem.h"
#include "SceneSyncPresenceClient.h"
#include "SceneSyncProtocol.h"
#include "Engine/StaticMeshActor.h"
#include "Components/StaticMeshComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Engine/StaticMesh.h"
#include "GameFramework/Actor.h"
#include "Engine/World.h"
#include "TimerManager.h"
#include "HAL/PlatformTime.h"

#if WITH_GLTFRUNTIME
#include "glTFRuntimeParser.h"
#include "glTFRuntimeAsset.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogSceneSyncSubsystem, Log, All);

// Actor tag prefix used for object ID tracking
static const FName TagSceneSync = TEXT("SceneSync");
static const FString TagPrefixId = TEXT("SceneSyncId:");

void USceneSyncSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);

    Client = MakeUnique<FSceneSyncPresenceClient>();
    Client->OnConnected.AddUObject(this, &USceneSyncSubsystem::OnClientConnected);
    Client->OnDisconnected.AddUObject(this, &USceneSyncSubsystem::OnClientDisconnected);
    Client->OnPeersUpdated.AddUObject(this, &USceneSyncSubsystem::OnPeersUpdated);
    Client->OnHandoffReceived.AddUObject(this, &USceneSyncSubsystem::OnHandoffReceived);

    TickDelegateHandle = FTSTicker::GetCoreTicker().AddTicker(
        FTickerDelegate::CreateUObject(this, &USceneSyncSubsystem::Tick));
}

void USceneSyncSubsystem::Deinitialize()
{
    FTSTicker::GetCoreTicker().RemoveTicker(TickDelegateHandle);
    if (Client.IsValid())
    {
        Client->bShouldReconnect = false;
        Client->Disconnect();
    }
    Super::Deinitialize();
}

void USceneSyncSubsystem::Connect(const FString& PresenceUrl, const FString& Room, const FString& Nickname)
{
    BlobClient.SetBlobBaseUrl(FSceneSyncBlobClient::DeriveFromPresenceUrl(PresenceUrl));
    bSceneReceived = false;
    bFirstPeersReceived = false;
    Client->bShouldReconnect = true;
    Client->Connect(PresenceUrl, Room, Nickname);
}

void USceneSyncSubsystem::Disconnect()
{
    Client->bShouldReconnect = false;
    Client->Disconnect();
}

bool USceneSyncSubsystem::IsConnected() const
{
    return Client.IsValid() && Client->IsConnected();
}

bool USceneSyncSubsystem::Tick(float DeltaTime)
{
    if (!IsConnected()) return true;

    double Now = FPlatformTime::Seconds();

    if (Now - LastSendTime >= SendInterval)
    {
        LastSendTime = Now;
        SendTransformDelta();
    }

    if (Now - LastHierarchyCheckTime >= HierarchyCheckInterval)
    {
        LastHierarchyCheckTime = Now;
        DetectHierarchyChanges();
    }

    return true;
}

void USceneSyncSubsystem::OnClientConnected()
{
    UE_LOG(LogSceneSyncSubsystem, Log, TEXT("Connected to presence server"));
    OnConnectedBP.Broadcast();
}

void USceneSyncSubsystem::OnClientDisconnected()
{
    UE_LOG(LogSceneSyncSubsystem, Log, TEXT("Disconnected from presence server"));
    OnDisconnectedBP.Broadcast();
}

void USceneSyncSubsystem::OnPeersUpdated(const TArray<FSceneSyncPeerInfo>& Peers)
{
    UE_LOG(LogSceneSyncSubsystem, Log, TEXT("Peers updated: %d peers"), Peers.Num());
    if (!bFirstPeersReceived && Peers.Num() > 0)
    {
        bFirstPeersReceived = true;
        // Request scene state from another peer if available
        FString RequestJson = FSceneSyncProtocol::MakeSceneRequest();
        Client->Broadcast(RequestJson);
    }
}

void USceneSyncSubsystem::OnHandoffReceived(TSharedPtr<FJsonObject> Payload)
{
    if (!Payload.IsValid()) return;

    FString Kind = FSceneSyncProtocol::ExtractKind(Payload);
    FString FromId = FSceneSyncProtocol::ExtractFromId(Payload);

    UE_LOG(LogSceneSyncSubsystem, Verbose, TEXT("Handoff received: kind=%s from=%s"), *Kind, *FromId);

    if (Kind == TEXT("scene-state"))        HandleSceneState(Payload);
    else if (Kind == TEXT("scene-add"))     HandleSceneAdd(Payload);
    else if (Kind == TEXT("scene-delta"))   HandleSceneDelta(Payload);
    else if (Kind == TEXT("scene-remove"))  HandleSceneRemove(Payload);
    else if (Kind == TEXT("scene-lock"))    HandleSceneLock(Payload, FromId);
    else if (Kind == TEXT("scene-unlock"))  HandleSceneUnlock(Payload);
    else if (Kind == TEXT("scene-request")) HandleSceneRequest(FromId);
}

// ============================================================
// Scene receive — Step 6
// ============================================================

void USceneSyncSubsystem::HandleSceneState(const TSharedPtr<FJsonObject>& Payload)
{
    bSceneReceived = true;
    const TSharedPtr<FJsonObject>* ObjectsField;
    if (!Payload->TryGetObjectField(TEXT("objects"), ObjectsField))
    {
        return;
    }
    for (auto& Pair : (*ObjectsField)->Values)
    {
        const TSharedPtr<FJsonObject>* EntryObj;
        if (!Pair.Value->TryGetObject(EntryObj))
        {
            continue;
        }
        // Build a synthetic scene-add payload from the state entry
        TSharedPtr<FJsonObject> AddPayload = MakeShareable(new FJsonObject(**EntryObj));
        AddPayload->SetStringField(TEXT("kind"), TEXT("scene-add"));
        AddPayload->SetStringField(TEXT("objectId"), Pair.Key);
        HandleSceneAdd(AddPayload);
    }
}

void USceneSyncSubsystem::HandleSceneAdd(const TSharedPtr<FJsonObject>& Payload)
{
    FString ObjectId = FSceneSyncProtocol::ExtractObjectId(Payload);
    if (ObjectId.IsEmpty()) return;

    FSceneSyncTransformData T = FSceneSyncProtocol::ExtractTransform(Payload);
    FVector Pos = T.bHasPosition ? T.Position : FVector::ZeroVector;
    FQuat Rot = T.bHasRotation ? T.Rotation : FQuat::Identity;
    FVector Scale = T.bHasScale ? T.Scale : FVector::OneVector;

    // If already tracked, just update transform
    if (ManagedActors.Contains(ObjectId))
    {
        if (AActor* Existing = ManagedActors[ObjectId].Get())
        {
            ApplyTransformToActor(Existing, Pos, Rot, Scale);
        }
        return;
    }

    FString MeshPath;
    Payload->TryGetStringField(TEXT("meshPath"), MeshPath);
    if (!MeshPath.IsEmpty())
    {
        MeshPaths.Add(ObjectId, MeshPath);
    }

    FString Name;
    Payload->TryGetStringField(TEXT("name"), Name);
    if (Name.IsEmpty()) Name = ObjectId;

    const TSharedPtr<FJsonObject>* AssetObj;
    bool bHasAsset = Payload->TryGetObjectField(TEXT("asset"), AssetObj);

    AActor* NewActor = nullptr;

    if (bHasAsset)
    {
        FString AssetType;
        (*AssetObj)->TryGetStringField(TEXT("type"), AssetType);
        if (AssetType == TEXT("primitive"))
        {
            FString Primitive;
            FString Color;
            (*AssetObj)->TryGetStringField(TEXT("primitive"), Primitive);
            (*AssetObj)->TryGetStringField(TEXT("color"), Color);
            NewActor = SpawnPrimitive(ObjectId, Primitive, Color);
        }
    }
    else if (!MeshPath.IsEmpty())
    {
        DownloadAndCreateObject(ObjectId, Name, MeshPath, Pos, Rot, Scale);
        return; // handled asynchronously
    }

    if (!NewActor)
    {
        // Fallback: spawn a cube
        NewActor = SpawnPrimitive(ObjectId, TEXT("box"), TEXT("#888888"));
    }

    if (NewActor)
    {
        NewActor->Tags.AddUnique(TagSceneSync);
        NewActor->Tags.AddUnique(FName(*(TagPrefixId + ObjectId)));
        NewActor->SetActorLabel(Name);
        ApplyTransformToActor(NewActor, Pos, Rot, Scale);
        ManagedActors.Add(ObjectId, NewActor);
        KnownObjectIds.Add(ObjectId);
        UE_LOG(LogSceneSyncSubsystem, Log, TEXT("scene-add: %s (%s)"), *ObjectId, *Name);
    }
}

void USceneSyncSubsystem::HandleSceneDelta(const TSharedPtr<FJsonObject>& Payload)
{
    FString ObjectId = FSceneSyncProtocol::ExtractObjectId(Payload);
    if (ObjectId.IsEmpty()) return;

    // Ignore delta for currently selected object (Last-Writer-Wins)
    if (SelectedActor.IsValid())
    {
        if (GetObjectIdFromActor(SelectedActor.Get()) == ObjectId) return;
    }

    AActor* Actor = FindActorByObjectId(ObjectId);
    if (!Actor) return;

    FSceneSyncTransformData T = FSceneSyncProtocol::ExtractTransform(Payload);
    if (T.bHasPosition) Actor->SetActorLocation(T.Position, false, nullptr, ETeleportType::TeleportPhysics);
    if (T.bHasRotation) Actor->SetActorRotation(T.Rotation.Rotator(), ETeleportType::TeleportPhysics);
    if (T.bHasScale)    Actor->SetActorScale3D(T.Scale);
}

void USceneSyncSubsystem::HandleSceneRemove(const TSharedPtr<FJsonObject>& Payload)
{
    FString ObjectId = FSceneSyncProtocol::ExtractObjectId(Payload);
    if (ObjectId.IsEmpty()) return;

    if (AActor* Actor = FindActorByObjectId(ObjectId))
    {
        if (SelectedActor.Get() == Actor) DeselectObject();
        Actor->Destroy();
    }
    ManagedActors.Remove(ObjectId);
    KnownObjectIds.Remove(ObjectId);
    MeshPaths.Remove(ObjectId);
    Locks.Remove(ObjectId);
    UE_LOG(LogSceneSyncSubsystem, Log, TEXT("scene-remove: %s"), *ObjectId);
}

void USceneSyncSubsystem::HandleSceneLock(const TSharedPtr<FJsonObject>& Payload, const FString& FromId)
{
    FString ObjectId = FSceneSyncProtocol::ExtractObjectId(Payload);
    if (ObjectId.IsEmpty()) return;

    Locks.Add(ObjectId, FromId);

    // If we are selecting this, deselect
    if (SelectedActor.IsValid() && GetObjectIdFromActor(SelectedActor.Get()) == ObjectId)
    {
        DeselectObject();
    }
}

void USceneSyncSubsystem::HandleSceneUnlock(const TSharedPtr<FJsonObject>& Payload)
{
    FString ObjectId = FSceneSyncProtocol::ExtractObjectId(Payload);
    Locks.Remove(ObjectId);
}

void USceneSyncSubsystem::HandleSceneRequest(const FString& FromId)
{
    UE_LOG(LogSceneSyncSubsystem, Log, TEXT("scene-request from %s"), *FromId);
    if (!FromId.IsEmpty())
    {
        SendSceneState(FromId);
    }
}

// ============================================================
// Scene send — Step 7 & 8
// ============================================================

void USceneSyncSubsystem::SelectObject(AActor* Actor)
{
    if (!IsValid(Actor)) return;

    FString ObjectId = GetObjectIdFromActor(Actor);
    if (ObjectId.IsEmpty()) return;

    // If locked by someone else, reject
    if (FString* LockOwner = Locks.Find(ObjectId))
    {
        if (*LockOwner != Client->GetId()) return;
    }

    // Unlock previous selection
    if (!CurrentlyLockedId.IsEmpty())
    {
        Client->Broadcast(FSceneSyncProtocol::MakeSceneUnlock(CurrentlyLockedId));
    }

    SelectedActor = Actor;
    CurrentlyLockedId = ObjectId;
    Client->Broadcast(FSceneSyncProtocol::MakeSceneLock(ObjectId));
}

void USceneSyncSubsystem::DeselectObject()
{
    if (!CurrentlyLockedId.IsEmpty())
    {
        Client->Broadcast(FSceneSyncProtocol::MakeSceneUnlock(CurrentlyLockedId));
    }
    SelectedActor = nullptr;
    CurrentlyLockedId = TEXT("");
}

void USceneSyncSubsystem::SendTransformDelta()
{
    if (!SelectedActor.IsValid()) return;

    AActor* Actor = SelectedActor.Get();
    FString ObjectId = GetObjectIdFromActor(Actor);
    if (ObjectId.IsEmpty()) return;

    FVector Pos = Actor->GetActorLocation();
    FQuat Rot = Actor->GetActorQuat();
    FVector Scale = Actor->GetActorScale3D();

    // Throttle: skip if no change
    if (FTransformSnapshot* Last = LastSnapshots.Find(ObjectId))
    {
        if (Last->Pos.Equals(Pos, 0.01f) &&
            Last->Rot.Equals(Rot, 0.001f) &&
            Last->Scale.Equals(Scale, 0.001f))
        {
            return;
        }
    }

    LastSnapshots.Add(ObjectId, { Pos, Rot, Scale });

    FString DeltaJson = FSceneSyncProtocol::MakeSceneDelta(ObjectId, Pos, Rot, Scale);
    Client->Broadcast(DeltaJson);
}

void USceneSyncSubsystem::DetectHierarchyChanges()
{
    UWorld* World = GetWorld();
    if (!World) return;

    TSet<FString> CurrentIds;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        AActor* Actor = *It;
        if (!IsValid(Actor)) continue;

        // Skip actors managed by SceneSync (received from remote)
        if (Actor->Tags.Contains(TagSceneSync)) continue;

        UStaticMeshComponent* MeshComp = Actor->FindComponentByClass<UStaticMeshComponent>();
        if (!MeshComp || !MeshComp->GetStaticMesh()) continue;

        FString ObjectId = GetOrAssignObjectId(Actor);
        CurrentIds.Add(ObjectId);

        if (!KnownObjectIds.Contains(ObjectId))
        {
            KnownObjectIds.Add(ObjectId);
            ManagedActors.Add(ObjectId, Actor);
            SendSceneAdd(Actor);
        }
    }

    // Detect removed actors
    TArray<FString> ToRemove;
    for (const FString& Id : KnownObjectIds)
    {
        if (!CurrentIds.Contains(Id))
        {
            // Only remove locally-owned actors (not received ones)
            if (!ManagedActors.Contains(Id) || !ManagedActors[Id].IsValid())
            {
                ToRemove.Add(Id);
            }
        }
    }
    for (const FString& Id : ToRemove)
    {
        SendSceneRemove(Id);
        KnownObjectIds.Remove(Id);
        ManagedActors.Remove(Id);
    }
}

void USceneSyncSubsystem::SendSceneAdd(AActor* Actor)
{
    FString ObjectId = GetOrAssignObjectId(Actor);
    FString Name = Actor->GetActorLabel();
    FVector Pos = Actor->GetActorLocation();
    FQuat Rot = Actor->GetActorQuat();
    FVector Scale = Actor->GetActorScale3D();

    // Build a basic primitive asset descriptor
    TSharedPtr<FJsonObject> Asset = MakeShareable(new FJsonObject);
    Asset->SetStringField(TEXT("type"), TEXT("primitive"));
    Asset->SetStringField(TEXT("primitive"), TEXT("box"));
    Asset->SetStringField(TEXT("color"), TEXT("#888888"));

    FString AddJson = FSceneSyncProtocol::MakeSceneAdd(ObjectId, Name, Pos, Rot, Scale, TEXT(""), Asset);
    Client->Broadcast(AddJson);
    UE_LOG(LogSceneSyncSubsystem, Log, TEXT("scene-add sent: %s"), *ObjectId);
}

void USceneSyncSubsystem::SendSceneRemove(const FString& ObjectId)
{
    Client->Broadcast(FSceneSyncProtocol::MakeSceneRemove(ObjectId));
    UE_LOG(LogSceneSyncSubsystem, Log, TEXT("scene-remove sent: %s"), *ObjectId);
}

void USceneSyncSubsystem::SendSceneState(const FString& TargetId)
{
    TMap<FString, TSharedPtr<FJsonObject>> Objects;
    for (auto& Pair : ManagedActors)
    {
        AActor* Actor = Pair.Value.Get();
        if (!IsValid(Actor)) continue;

        TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject);
        Entry->SetStringField(TEXT("name"), Actor->GetActorLabel());

        auto SetDoubleArr = [&](const FString& Key, const TArray<double>& Arr)
        {
            TArray<TSharedPtr<FJsonValue>> Vals;
            for (double D : Arr) Vals.Add(MakeShareable(new FJsonValueNumber(D)));
            Entry->SetArrayField(Key, Vals);
        };
        SetDoubleArr(TEXT("position"), FSceneSyncProtocol::PosToWire(Actor->GetActorLocation()));
        SetDoubleArr(TEXT("rotation"), FSceneSyncProtocol::RotToWire(Actor->GetActorQuat()));
        SetDoubleArr(TEXT("scale"),    FSceneSyncProtocol::ScaleToWire(Actor->GetActorScale3D()));

        if (FString* MeshPath = MeshPaths.Find(Pair.Key))
        {
            Entry->SetStringField(TEXT("meshPath"), *MeshPath);
        }
        Objects.Add(Pair.Key, Entry);
    }

    FString StateJson = FSceneSyncProtocol::MakeSceneState(Objects);
    if (TargetId.IsEmpty())
    {
        Client->Broadcast(StateJson);
    }
    else
    {
        Client->SendHandoff(TargetId, StateJson);
    }
}

// ============================================================
// Actor helpers
// ============================================================

AActor* USceneSyncSubsystem::SpawnPrimitive(const FString& ObjectId, const FString& PrimitiveType, const FString& Color)
{
    UWorld* World = GetWorld();
    if (!World) return nullptr;

    static TMap<FString, FString> PrimitivePaths = {
        { TEXT("box"),      TEXT("/Engine/BasicShapes/Cube.Cube") },
        { TEXT("sphere"),   TEXT("/Engine/BasicShapes/Sphere.Sphere") },
        { TEXT("cylinder"), TEXT("/Engine/BasicShapes/Cylinder.Cylinder") },
        { TEXT("cone"),     TEXT("/Engine/BasicShapes/Cone.Cone") },
        { TEXT("plane"),    TEXT("/Engine/BasicShapes/Plane.Plane") },
    };

    FString MeshPath = PrimitivePaths.Contains(PrimitiveType)
        ? PrimitivePaths[PrimitiveType]
        : PrimitivePaths[TEXT("box")];

    UStaticMesh* Mesh = LoadObject<UStaticMesh>(nullptr, *MeshPath);
    if (!Mesh)
    {
        UE_LOG(LogSceneSyncSubsystem, Warning, TEXT("Could not load mesh: %s"), *MeshPath);
        return nullptr;
    }

    FActorSpawnParameters Params;
    Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
    AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(AStaticMeshActor::StaticClass(), FTransform::Identity, Params);
    if (!Actor) return nullptr;

    UStaticMeshComponent* MeshComp = Actor->GetStaticMeshComponent();
    MeshComp->SetStaticMesh(Mesh);
    MeshComp->SetMobility(EComponentMobility::Movable);

    // Apply color via dynamic material
    if (!Color.IsEmpty())
    {
        UMaterialInterface* BaseMat = MeshComp->GetMaterial(0);
        if (BaseMat)
        {
            UMaterialInstanceDynamic* DynMat = UMaterialInstanceDynamic::Create(BaseMat, Actor);
            FColor ParsedColor = FColor::FromHex(Color);
            FLinearColor LinearColor = FLinearColor::FromSRGBColor(ParsedColor);
            DynMat->SetVectorParameterValue(TEXT("Color"), LinearColor);
            DynMat->SetVectorParameterValue(TEXT("BaseColor"), LinearColor);
            MeshComp->SetMaterial(0, DynMat);
        }
    }

    return Actor;
}

void USceneSyncSubsystem::DownloadAndCreateObject(const FString& ObjectId, const FString& Name,
                                                   const FString& MeshPath,
                                                   const FVector& Pos, const FQuat& Rot, const FVector& Scale)
{
    UWorld* World = GetWorld();
    if (!World) return;

    // Create placeholder cube while downloading
    AActor* Placeholder = SpawnPrimitive(ObjectId, TEXT("box"), TEXT("#888888"));
    if (Placeholder)
    {
        Placeholder->Tags.AddUnique(TagSceneSync);
        Placeholder->Tags.AddUnique(FName(*(TagPrefixId + ObjectId)));
        Placeholder->SetActorLabel(Name + TEXT(" (loading)"));
        ApplyTransformToActor(Placeholder, Pos, Rot, Scale);
        ManagedActors.Add(ObjectId, Placeholder);
        KnownObjectIds.Add(ObjectId);
    }

    TWeakObjectPtr<USceneSyncSubsystem> WeakThis(this);
    BlobClient.DownloadGlb(MeshPath, FOnBlobDownloaded::CreateLambda(
        [WeakThis, ObjectId, Name, Pos, Rot, Scale](bool bSuccess, TArray<uint8> Data)
        {
            if (USceneSyncSubsystem* Self = WeakThis.Get())
            {
                Self->OnGlbDownloaded(bSuccess, MoveTemp(Data), ObjectId, Name, Pos, Rot, Scale);
            }
        }));
}

void USceneSyncSubsystem::OnGlbDownloaded(bool bSuccess, TArray<uint8> Data,
                                            FString ObjectId, FString Name,
                                            FVector Pos, FQuat Rot, FVector Scale)
{
    if (!bSuccess || Data.Num() == 0)
    {
        UE_LOG(LogSceneSyncSubsystem, Warning, TEXT("glB download failed for %s, keeping placeholder"), *ObjectId);
        return;
    }

#if WITH_GLTFRUNTIME
    UWorld* World = GetWorld();
    if (!World) return;

    FglTFRuntimeConfig Config;
    UglTFRuntimeAsset* GltfAsset = NewObject<UglTFRuntimeAsset>();
    if (!GltfAsset->LoadFromData(Data.GetData(), Data.Num(), Config))
    {
        UE_LOG(LogSceneSyncSubsystem, Warning, TEXT("glTFRuntime: LoadFromData failed for %s"), *ObjectId);
        return;
    }

    // Remove placeholder
    if (AActor* Old = FindActorByObjectId(ObjectId))
    {
        Old->Destroy();
    }

    FActorSpawnParameters Params;
    Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
    AActor* NewActor = World->SpawnActor<AActor>(AActor::StaticClass(), FTransform::Identity, Params);
    if (!NewActor) return;

    USceneComponent* Root = NewObject<USceneComponent>(NewActor, TEXT("Root"));
    NewActor->SetRootComponent(Root);
    Root->RegisterComponent();

    FglTFRuntimeStaticMeshConfig MeshConfig;
    TArray<FglTFRuntimeNode> Nodes;
    GltfAsset->GetNodes(Nodes);
    for (auto& Node : Nodes)
    {
        UStaticMesh* Mesh = GltfAsset->LoadStaticMesh(Node.Index, MeshConfig);
        if (Mesh)
        {
            UStaticMeshComponent* Comp = NewObject<UStaticMeshComponent>(NewActor);
            Comp->SetStaticMesh(Mesh);
            Comp->AttachToComponent(Root, FAttachmentTransformRules::KeepRelativeTransform);
            Comp->RegisterComponent();
        }
    }

    NewActor->Tags.AddUnique(TagSceneSync);
    NewActor->Tags.AddUnique(FName(*(TagPrefixId + ObjectId)));
    NewActor->SetActorLabel(Name);
    ApplyTransformToActor(NewActor, Pos, Rot, Scale);
    ManagedActors.Add(ObjectId, NewActor);
    UE_LOG(LogSceneSyncSubsystem, Log, TEXT("glB imported: %s"), *ObjectId);
#else
    UE_LOG(LogSceneSyncSubsystem, Log, TEXT("glTFRuntime not available; keeping placeholder for %s"), *ObjectId);
#endif
}

void USceneSyncSubsystem::ApplyTransformToActor(AActor* Actor, const FVector& Pos, const FQuat& Rot, const FVector& Scale)
{
    if (!IsValid(Actor)) return;
    Actor->SetActorLocation(Pos, false, nullptr, ETeleportType::TeleportPhysics);
    Actor->SetActorRotation(Rot.Rotator(), ETeleportType::TeleportPhysics);
    Actor->SetActorScale3D(Scale);
}

FString USceneSyncSubsystem::GetOrAssignObjectId(AActor* Actor)
{
    FString Existing = GetObjectIdFromActor(Actor);
    if (!Existing.IsEmpty()) return Existing;

    FString NewId = FString::Printf(TEXT("ue-%u"), Actor->GetUniqueID());
    Actor->Tags.AddUnique(FName(*(TagPrefixId + NewId)));
    return NewId;
}

FString USceneSyncSubsystem::GetObjectIdFromActor(const AActor* Actor) const
{
    if (!IsValid(Actor)) return TEXT("");
    for (const FName& Tag : Actor->Tags)
    {
        FString TagStr = Tag.ToString();
        if (TagStr.StartsWith(TagPrefixId))
        {
            return TagStr.RightChop(TagPrefixId.Len());
        }
    }
    return TEXT("");
}

AActor* USceneSyncSubsystem::FindActorByObjectId(const FString& ObjectId) const
{
    const TWeakObjectPtr<AActor>* Found = ManagedActors.Find(ObjectId);
    if (Found && Found->IsValid()) return Found->Get();
    return nullptr;
}
