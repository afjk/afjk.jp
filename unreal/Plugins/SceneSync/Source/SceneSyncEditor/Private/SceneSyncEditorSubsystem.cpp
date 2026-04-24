#include "SceneSyncEditorSubsystem.h"
#include "SceneSyncProtocol.h"
#include "Engine/StaticMeshActor.h"
#include "Components/StaticMeshComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Editor.h"

#if WITH_GLTFRUNTIME
#include "glTFRuntimeParser.h"
#include "glTFRuntimeAsset.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogSceneSyncEditorSS, Log, All);

static const FName TagSceneSyncEd = TEXT("SceneSync");
static const FString TagPrefixIdEd = TEXT("SceneSyncId:");

void USceneSyncEditorSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);

    Client = MakeUnique<FSceneSyncPresenceClient>();
    Client->OnConnected.AddUObject(this, &USceneSyncEditorSubsystem::OnClientConnected);
    Client->OnDisconnected.AddUObject(this, &USceneSyncEditorSubsystem::OnClientDisconnected);
    Client->OnPeersUpdated.AddUObject(this, &USceneSyncEditorSubsystem::OnPeersUpdated);
    Client->OnHandoffReceived.AddUObject(this, &USceneSyncEditorSubsystem::OnHandoffReceived);

    TickDelegateHandle = FTSTicker::GetCoreTicker().AddTicker(
        FTickerDelegate::CreateUObject(this, &USceneSyncEditorSubsystem::Tick));
}

void USceneSyncEditorSubsystem::Deinitialize()
{
    FTSTicker::GetCoreTicker().RemoveTicker(TickDelegateHandle);
    if (Client.IsValid())
    {
        Client->bShouldReconnect = false;
        Client->Disconnect();
    }
    Super::Deinitialize();
}

void USceneSyncEditorSubsystem::Connect(const FString& Url, const FString& Room, const FString& Nickname)
{
    BlobClient.SetBlobBaseUrl(FSceneSyncBlobClient::DeriveFromPresenceUrl(Url));
    bFirstPeersReceived = false;
    Client->bShouldReconnect = true;
    Client->Connect(Url, Room, Nickname);
}

void USceneSyncEditorSubsystem::Disconnect()
{
    Client->bShouldReconnect = false;
    Client->Disconnect();
}

bool USceneSyncEditorSubsystem::IsConnected() const
{
    return Client.IsValid() && Client->IsConnected();
}

const TArray<FSceneSyncPeerInfo>& USceneSyncEditorSubsystem::GetPeers() const
{
    static TArray<FSceneSyncPeerInfo> Empty;
    return Client.IsValid() ? Client->GetPeers() : Empty;
}

bool USceneSyncEditorSubsystem::Tick(float DeltaTime)
{
    return true;
}

void USceneSyncEditorSubsystem::OnClientConnected()
{
    UE_LOG(LogSceneSyncEditorSS, Log, TEXT("Connected"));
}

void USceneSyncEditorSubsystem::OnClientDisconnected()
{
    UE_LOG(LogSceneSyncEditorSS, Log, TEXT("Disconnected"));
}

void USceneSyncEditorSubsystem::OnPeersUpdated(const TArray<FSceneSyncPeerInfo>& Peers)
{
    if (!bFirstPeersReceived && Peers.Num() > 0)
    {
        bFirstPeersReceived = true;
        FString RequestJson = FSceneSyncProtocol::MakeSceneRequest();
        for (const FSceneSyncPeerInfo& Peer : Peers)
        {
            if (Peer.Id != Client->GetId())
            {
                Client->SendHandoff(Peer.Id, RequestJson);
                break;
            }
        }
    }
}

void USceneSyncEditorSubsystem::OnHandoffReceived(TSharedPtr<FJsonObject> Payload)
{
    if (!Payload.IsValid()) return;

    FString Kind = FSceneSyncProtocol::ExtractKind(Payload);
    FString FromId = FSceneSyncProtocol::ExtractFromId(Payload);

    if (Kind == TEXT("scene-state"))        HandleSceneState(Payload);
    else if (Kind == TEXT("scene-add"))     HandleSceneAdd(Payload);
    else if (Kind == TEXT("scene-delta"))   HandleSceneDelta(Payload);
    else if (Kind == TEXT("scene-remove"))  HandleSceneRemove(Payload);
    else if (Kind == TEXT("scene-mesh"))    HandleSceneMesh(Payload);
    else if (Kind == TEXT("scene-request")) HandleSceneRequest(FromId);
}

void USceneSyncEditorSubsystem::HandleSceneState(const TSharedPtr<FJsonObject>& Payload)
{
    const TSharedPtr<FJsonObject>* ObjectsField;
    if (!Payload->TryGetObjectField(TEXT("objects"), ObjectsField)) return;

    for (auto& Pair : (*ObjectsField)->Values)
    {
        const TSharedPtr<FJsonObject>* EntryObj;
        if (!Pair.Value->TryGetObject(EntryObj)) continue;

        TSharedPtr<FJsonObject> AddPayload = MakeShareable(new FJsonObject(**EntryObj));
        AddPayload->SetStringField(TEXT("kind"), TEXT("scene-add"));
        AddPayload->SetStringField(TEXT("objectId"), Pair.Key);
        HandleSceneAdd(AddPayload);
    }
}

void USceneSyncEditorSubsystem::HandleSceneAdd(const TSharedPtr<FJsonObject>& Payload)
{
    FString ObjectId = FSceneSyncProtocol::ExtractObjectId(Payload);
    if (ObjectId.IsEmpty()) return;

    FSceneSyncTransformData T = FSceneSyncProtocol::ExtractTransform(Payload);
    FVector Pos   = T.bHasPosition ? T.Position : FVector::ZeroVector;
    FQuat   Rot   = T.bHasRotation ? T.Rotation : FQuat::Identity;
    FVector Scale = T.bHasScale    ? T.Scale    : FVector::OneVector;

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
    if (!MeshPath.IsEmpty()) MeshPaths.Add(ObjectId, MeshPath);

    FString Name;
    Payload->TryGetStringField(TEXT("name"), Name);
    if (Name.IsEmpty()) Name = ObjectId;

    if (!MeshPath.IsEmpty())
    {
        DownloadAndCreateObject(ObjectId, Name, MeshPath, Pos, Rot, Scale);
        return;
    }

    const TSharedPtr<FJsonObject>* AssetObj;
    AActor* NewActor = nullptr;

    if (Payload->TryGetObjectField(TEXT("asset"), AssetObj))
    {
        FString AssetType;
        (*AssetObj)->TryGetStringField(TEXT("type"), AssetType);
        if (AssetType == TEXT("primitive"))
        {
            FString Primitive, Color;
            (*AssetObj)->TryGetStringField(TEXT("primitive"), Primitive);
            (*AssetObj)->TryGetStringField(TEXT("color"), Color);
            NewActor = SpawnPrimitive(ObjectId, Primitive, Color);
        }
    }

    if (!NewActor)
    {
        NewActor = SpawnPrimitive(ObjectId, TEXT("box"), TEXT("#888888"));
    }

    if (NewActor)
    {
        NewActor->Tags.AddUnique(TagSceneSyncEd);
        NewActor->Tags.AddUnique(FName(*(TagPrefixIdEd + ObjectId)));
        NewActor->SetActorLabel(Name);
        ApplyTransformToActor(NewActor, Pos, Rot, Scale);
        ManagedActors.Add(ObjectId, NewActor);
        KnownObjectIds.Add(ObjectId);
        UE_LOG(LogSceneSyncEditorSS, Log, TEXT("scene-add: %s (%s)"), *ObjectId, *Name);
    }
}

void USceneSyncEditorSubsystem::HandleSceneDelta(const TSharedPtr<FJsonObject>& Payload)
{
    FString ObjectId = FSceneSyncProtocol::ExtractObjectId(Payload);
    if (ObjectId.IsEmpty()) return;

    AActor* Actor = FindActorByObjectId(ObjectId);
    if (!Actor) return;

    FSceneSyncTransformData T = FSceneSyncProtocol::ExtractTransform(Payload);
    if (T.bHasPosition) Actor->SetActorLocation(T.Position, false, nullptr, ETeleportType::TeleportPhysics);
    if (T.bHasRotation) Actor->SetActorRotation(T.Rotation.Rotator(), ETeleportType::TeleportPhysics);
    if (T.bHasScale)    Actor->SetActorScale3D(T.Scale);
}

void USceneSyncEditorSubsystem::HandleSceneRemove(const TSharedPtr<FJsonObject>& Payload)
{
    FString ObjectId = FSceneSyncProtocol::ExtractObjectId(Payload);
    if (ObjectId.IsEmpty()) return;

    if (AActor* Actor = FindActorByObjectId(ObjectId))
    {
        Actor->Destroy();
    }
    ManagedActors.Remove(ObjectId);
    KnownObjectIds.Remove(ObjectId);
    MeshPaths.Remove(ObjectId);
    UE_LOG(LogSceneSyncEditorSS, Log, TEXT("scene-remove: %s"), *ObjectId);
}

void USceneSyncEditorSubsystem::HandleSceneMesh(const TSharedPtr<FJsonObject>& Payload)
{
    FString ObjectId = FSceneSyncProtocol::ExtractObjectId(Payload);
    FString MeshPath;
    Payload->TryGetStringField(TEXT("meshPath"), MeshPath);
    if (ObjectId.IsEmpty() || MeshPath.IsEmpty()) return;

    MeshPaths.Add(ObjectId, MeshPath);

    AActor* Existing = FindActorByObjectId(ObjectId);
    if (!Existing) return;

    FVector Pos   = Existing->GetActorLocation();
    FQuat   Rot   = Existing->GetActorQuat();
    FVector Scale = Existing->GetActorScale3D();
    FString Name  = Existing->GetActorLabel();

    DownloadAndCreateObject(ObjectId, Name, MeshPath, Pos, Rot, Scale);
}

void USceneSyncEditorSubsystem::DownloadAndCreateObject(const FString& ObjectId, const FString& Name,
    const FString& MeshPath, const FVector& Pos, const FQuat& Rot, const FVector& Scale)
{
    // Placeholder cube while downloading
    AActor* Placeholder = SpawnPrimitive(ObjectId, TEXT("box"), TEXT("#888888"));
    if (Placeholder)
    {
        Placeholder->Tags.AddUnique(TagSceneSyncEd);
        Placeholder->Tags.AddUnique(FName(*(TagPrefixIdEd + ObjectId)));
        Placeholder->SetActorLabel(Name + TEXT(" (loading)"));
        ApplyTransformToActor(Placeholder, Pos, Rot, Scale);
        ManagedActors.Add(ObjectId, Placeholder);
        KnownObjectIds.Add(ObjectId);
    }

    TWeakObjectPtr<USceneSyncEditorSubsystem> WeakThis(this);
    BlobClient.DownloadGlb(MeshPath, FOnBlobDownloaded::CreateLambda(
        [WeakThis, ObjectId, Name, Pos, Rot, Scale](bool bSuccess, TArray<uint8> Data)
        {
            if (USceneSyncEditorSubsystem* Self = WeakThis.Get())
            {
                Self->OnGlbDownloaded(bSuccess, MoveTemp(Data), ObjectId, Name, Pos, Rot, Scale);
            }
        }));
}

void USceneSyncEditorSubsystem::OnGlbDownloaded(bool bSuccess, TArray<uint8> Data,
    FString ObjectId, FString Name, FVector Pos, FQuat Rot, FVector Scale)
{
    if (!bSuccess || Data.Num() == 0)
    {
        UE_LOG(LogSceneSyncEditorSS, Warning, TEXT("glB download failed for %s, keeping placeholder"), *ObjectId);
        return;
    }

#if WITH_GLTFRUNTIME
    UWorld* World = GetEditorWorld();
    if (!World) return;

    FglTFRuntimeConfig Config;
    UglTFRuntimeAsset* GltfAsset = NewObject<UglTFRuntimeAsset>();
    if (!GltfAsset->LoadFromData(Data.GetData(), Data.Num(), Config))
    {
        UE_LOG(LogSceneSyncEditorSS, Warning, TEXT("glTFRuntime: LoadFromData failed for %s"), *ObjectId);
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

    // glTF forward (-Z) maps to UE +Y after coordinate conversion, but UE forward is +X.
    // Correct by rotating all mesh components -90° around Z relative to the root.
    static const FQuat GltfCoordFix = FQuat(FVector::ZAxisVector, FMath::DegreesToRadians(-90.f));

    FglTFRuntimeStaticMeshConfig MeshConfig;
    TArray<FglTFRuntimeNode> Nodes = GltfAsset->GetNodes();
    for (auto& Node : Nodes)
    {
        UStaticMesh* Mesh = GltfAsset->LoadStaticMesh(Node.Index, MeshConfig);
        if (Mesh)
        {
            UStaticMeshComponent* Comp = NewObject<UStaticMeshComponent>(NewActor);
            Comp->SetStaticMesh(Mesh);
            Comp->AttachToComponent(Root, FAttachmentTransformRules::KeepRelativeTransform);
            Comp->SetRelativeRotation(GltfCoordFix);
            Comp->RegisterComponent();
        }
    }

    NewActor->Tags.AddUnique(TagSceneSyncEd);
    NewActor->Tags.AddUnique(FName(*(TagPrefixIdEd + ObjectId)));
    NewActor->SetActorLabel(Name);
    ApplyTransformToActor(NewActor, Pos, Rot, Scale);
    ManagedActors.Add(ObjectId, NewActor);
    UE_LOG(LogSceneSyncEditorSS, Log, TEXT("glB imported: %s"), *ObjectId);
#else
    UE_LOG(LogSceneSyncEditorSS, Log, TEXT("glTFRuntime not available; keeping placeholder for %s"), *ObjectId);
#endif
}

void USceneSyncEditorSubsystem::HandleSceneRequest(const FString& FromId)
{
    if (!FromId.IsEmpty())
    {
        SendSceneState(FromId);
    }
}

void USceneSyncEditorSubsystem::SendSceneState(const FString& TargetId)
{
    TMap<FString, TSharedPtr<FJsonObject>> Objects;
    for (auto& Pair : ManagedActors)
    {
        AActor* Actor = Pair.Value.Get();
        if (!IsValid(Actor)) continue;

        TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject);
        Entry->SetStringField(TEXT("name"), Actor->GetActorLabel());

        auto SetArr = [&](const FString& Key, const TArray<double>& Arr)
        {
            TArray<TSharedPtr<FJsonValue>> Vals;
            for (double D : Arr) Vals.Add(MakeShareable(new FJsonValueNumber(D)));
            Entry->SetArrayField(Key, Vals);
        };
        SetArr(TEXT("position"), FSceneSyncProtocol::PosToWire(Actor->GetActorLocation()));
        SetArr(TEXT("rotation"), FSceneSyncProtocol::RotToWire(Actor->GetActorQuat()));
        SetArr(TEXT("scale"),    FSceneSyncProtocol::ScaleToWire(Actor->GetActorScale3D()));

        Objects.Add(Pair.Key, Entry);
    }

    FString StateJson = FSceneSyncProtocol::MakeSceneState(Objects);
    if (TargetId.IsEmpty())
        Client->Broadcast(StateJson);
    else
        Client->SendHandoff(TargetId, StateJson);
}

AActor* USceneSyncEditorSubsystem::SpawnPrimitive(const FString& ObjectId, const FString& PrimitiveType, const FString& Color)
{
    UWorld* World = GetEditorWorld();
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
    if (!Mesh) return nullptr;

    FActorSpawnParameters Params;
    Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
    AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(AStaticMeshActor::StaticClass(), FTransform::Identity, Params);
    if (!Actor) return nullptr;

    UStaticMeshComponent* MeshComp = Actor->GetStaticMeshComponent();
    MeshComp->SetStaticMesh(Mesh);
    MeshComp->SetMobility(EComponentMobility::Movable);

    if (!Color.IsEmpty())
    {
        UMaterialInterface* BaseMat = MeshComp->GetMaterial(0);
        if (BaseMat)
        {
            UMaterialInstanceDynamic* DynMat = UMaterialInstanceDynamic::Create(BaseMat, Actor);
            FLinearColor LinearColor = FLinearColor::FromSRGBColor(FColor::FromHex(Color));
            DynMat->SetVectorParameterValue(TEXT("Color"), LinearColor);
            DynMat->SetVectorParameterValue(TEXT("BaseColor"), LinearColor);
            MeshComp->SetMaterial(0, DynMat);
        }
    }

    return Actor;
}

void USceneSyncEditorSubsystem::ApplyTransformToActor(AActor* Actor, const FVector& Pos, const FQuat& Rot, const FVector& Scale)
{
    if (!IsValid(Actor)) return;
    Actor->SetActorLocation(Pos, false, nullptr, ETeleportType::TeleportPhysics);
    Actor->SetActorRotation(Rot.Rotator(), ETeleportType::TeleportPhysics);
    Actor->SetActorScale3D(Scale);
}

AActor* USceneSyncEditorSubsystem::FindActorByObjectId(const FString& ObjectId) const
{
    const TWeakObjectPtr<AActor>* Found = ManagedActors.Find(ObjectId);
    if (Found && Found->IsValid()) return Found->Get();
    return nullptr;
}

FString USceneSyncEditorSubsystem::GetObjectIdFromActor(const AActor* Actor) const
{
    if (!IsValid(Actor)) return TEXT("");
    for (const FName& Tag : Actor->Tags)
    {
        FString TagStr = Tag.ToString();
        if (TagStr.StartsWith(TagPrefixIdEd))
            return TagStr.RightChop(TagPrefixIdEd.Len());
    }
    return TEXT("");
}

UWorld* USceneSyncEditorSubsystem::GetEditorWorld() const
{
    if (!GEditor) return nullptr;
    return GEditor->GetEditorWorldContext().World();
}
