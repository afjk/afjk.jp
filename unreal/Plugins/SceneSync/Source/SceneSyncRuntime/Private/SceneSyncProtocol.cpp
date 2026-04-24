#include "SceneSyncProtocol.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

// Wire (Three.js): Y-up, right-hand, meters
// UE:             Z-up, left-hand, centimeters
//
// PosFromWire([x,y,z]) = FVector( x*100,  -z*100,  y*100 )
// PosToWire(V)         = [V.X/100, V.Z/100, -V.Y/100]
// RotFromWire([x,y,z,w]) = FQuat(-x, z, -y, w).Normalized
// RotToWire(Q)           = [-Q.X, -Q.Z, Q.Y, Q.W]
// ScaleFromWire([x,y,z]) = FVector(x, z, y)
// ScaleToWire(V)         = [V.X, V.Z, V.Y]

FVector FSceneSyncProtocol::PosFromWire(const TArray<double>& W)
{
    if (W.Num() < 3) return FVector::ZeroVector;
    return FVector(W[0] * 100.0, -W[2] * 100.0, W[1] * 100.0);
}

TArray<double> FSceneSyncProtocol::PosToWire(const FVector& V)
{
    return { V.X / 100.0, V.Z / 100.0, -V.Y / 100.0 };
}

FQuat FSceneSyncProtocol::RotFromWire(const TArray<double>& W)
{
    if (W.Num() < 4) return FQuat::Identity;
    return FQuat(-W[0], W[2], -W[1], W[3]).GetNormalized();
}

TArray<double> FSceneSyncProtocol::RotToWire(const FQuat& Q)
{
    return { -Q.X, -Q.Z, Q.Y, Q.W };
}

FVector FSceneSyncProtocol::ScaleFromWire(const TArray<double>& W)
{
    if (W.Num() < 3) return FVector::OneVector;
    return FVector(W[0], W[2], W[1]);
}

TArray<double> FSceneSyncProtocol::ScaleToWire(const FVector& V)
{
    return { V.X, V.Z, V.Y };
}

static TArray<double> VecToDoubleArray(const TArray<double>& V) { return V; }

static TSharedPtr<FJsonValue> DoubleArrayToJson(const TArray<double>& Arr)
{
    TArray<TSharedPtr<FJsonValue>> Values;
    for (double D : Arr)
    {
        Values.Add(MakeShareable(new FJsonValueNumber(D)));
    }
    return MakeShareable(new FJsonValueArray(Values));
}

FString FSceneSyncProtocol::SerializeJson(const TSharedPtr<FJsonObject>& Obj)
{
    FString Out;
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
    FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
    return Out;
}

FString FSceneSyncProtocol::MakeSceneDelta(const FString& ObjectId, const FVector& Pos, const FQuat& Rot, const FVector& Scale)
{
    TSharedPtr<FJsonObject> Payload = MakeShareable(new FJsonObject);
    Payload->SetStringField(TEXT("kind"), TEXT("scene-delta"));
    Payload->SetStringField(TEXT("objectId"), ObjectId);
    Payload->SetField(TEXT("position"), DoubleArrayToJson(PosToWire(Pos)));
    Payload->SetField(TEXT("rotation"), DoubleArrayToJson(RotToWire(Rot)));
    Payload->SetField(TEXT("scale"), DoubleArrayToJson(ScaleToWire(Scale)));
    return SerializeJson(Payload);
}

FString FSceneSyncProtocol::MakeSceneAdd(const FString& ObjectId, const FString& Name,
                                          const FVector& Pos, const FQuat& Rot, const FVector& Scale,
                                          const FString& MeshPath,
                                          const TSharedPtr<FJsonObject>& Asset)
{
    TSharedPtr<FJsonObject> Payload = MakeShareable(new FJsonObject);
    Payload->SetStringField(TEXT("kind"), TEXT("scene-add"));
    Payload->SetStringField(TEXT("objectId"), ObjectId);
    Payload->SetStringField(TEXT("name"), Name);
    Payload->SetField(TEXT("position"), DoubleArrayToJson(PosToWire(Pos)));
    Payload->SetField(TEXT("rotation"), DoubleArrayToJson(RotToWire(Rot)));
    Payload->SetField(TEXT("scale"), DoubleArrayToJson(ScaleToWire(Scale)));

    if (!MeshPath.IsEmpty())
    {
        Payload->SetStringField(TEXT("meshPath"), MeshPath);
    }
    if (Asset.IsValid())
    {
        Payload->SetObjectField(TEXT("asset"), Asset);
    }
    return SerializeJson(Payload);
}

FString FSceneSyncProtocol::MakeSceneRemove(const FString& ObjectId)
{
    TSharedPtr<FJsonObject> Payload = MakeShareable(new FJsonObject);
    Payload->SetStringField(TEXT("kind"), TEXT("scene-remove"));
    Payload->SetStringField(TEXT("objectId"), ObjectId);
    return SerializeJson(Payload);
}

FString FSceneSyncProtocol::MakeSceneMesh(const FString& ObjectId, const FString& MeshPath)
{
    TSharedPtr<FJsonObject> Payload = MakeShareable(new FJsonObject);
    Payload->SetStringField(TEXT("kind"), TEXT("scene-mesh"));
    Payload->SetStringField(TEXT("objectId"), ObjectId);
    Payload->SetStringField(TEXT("meshPath"), MeshPath);
    return SerializeJson(Payload);
}

FString FSceneSyncProtocol::MakeSceneLock(const FString& ObjectId)
{
    TSharedPtr<FJsonObject> Payload = MakeShareable(new FJsonObject);
    Payload->SetStringField(TEXT("kind"), TEXT("scene-lock"));
    Payload->SetStringField(TEXT("objectId"), ObjectId);
    return SerializeJson(Payload);
}

FString FSceneSyncProtocol::MakeSceneUnlock(const FString& ObjectId)
{
    TSharedPtr<FJsonObject> Payload = MakeShareable(new FJsonObject);
    Payload->SetStringField(TEXT("kind"), TEXT("scene-unlock"));
    Payload->SetStringField(TEXT("objectId"), ObjectId);
    return SerializeJson(Payload);
}

FString FSceneSyncProtocol::MakeSceneRequest()
{
    TSharedPtr<FJsonObject> Payload = MakeShareable(new FJsonObject);
    Payload->SetStringField(TEXT("kind"), TEXT("scene-request"));
    return SerializeJson(Payload);
}

FString FSceneSyncProtocol::MakeSceneState(const TMap<FString, TSharedPtr<FJsonObject>>& Objects)
{
    TSharedPtr<FJsonObject> ObjectsJson = MakeShareable(new FJsonObject);
    for (auto& Pair : Objects)
    {
        ObjectsJson->SetObjectField(Pair.Key, Pair.Value);
    }

    TSharedPtr<FJsonObject> Payload = MakeShareable(new FJsonObject);
    Payload->SetStringField(TEXT("kind"), TEXT("scene-state"));
    Payload->SetObjectField(TEXT("objects"), ObjectsJson);
    return SerializeJson(Payload);
}

TSharedPtr<FJsonObject> FSceneSyncProtocol::ParsePayload(const FString& RawJson)
{
    TSharedPtr<FJsonObject> Result;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RawJson);
    if (!FJsonSerializer::Deserialize(Reader, Result))
    {
        return nullptr;
    }
    return Result;
}

FString FSceneSyncProtocol::ExtractKind(const TSharedPtr<FJsonObject>& Obj)
{
    if (!Obj.IsValid()) return TEXT("");
    FString Kind;
    Obj->TryGetStringField(TEXT("kind"), Kind);
    return Kind;
}

FString FSceneSyncProtocol::ExtractFromId(const TSharedPtr<FJsonObject>& Obj)
{
    if (!Obj.IsValid()) return TEXT("");
    FString FromId;
    Obj->TryGetStringField(TEXT("from"), FromId);
    return FromId;
}

FString FSceneSyncProtocol::ExtractObjectId(const TSharedPtr<FJsonObject>& Obj)
{
    if (!Obj.IsValid()) return TEXT("");
    FString ObjectId;
    Obj->TryGetStringField(TEXT("objectId"), ObjectId);
    return ObjectId;
}

TArray<double> FSceneSyncProtocol::GetDoubleArray(const TSharedPtr<FJsonObject>& Obj, const FString& Key)
{
    TArray<double> Result;
    const TArray<TSharedPtr<FJsonValue>>* Arr;
    if (Obj.IsValid() && Obj->TryGetArrayField(Key, Arr))
    {
        for (auto& V : *Arr)
        {
            Result.Add(V->AsNumber());
        }
    }
    return Result;
}

FSceneSyncTransformData FSceneSyncProtocol::ExtractTransform(const TSharedPtr<FJsonObject>& Obj)
{
    FSceneSyncTransformData T;
    if (!Obj.IsValid()) return T;

    TArray<double> Pos = GetDoubleArray(Obj, TEXT("position"));
    TArray<double> Rot = GetDoubleArray(Obj, TEXT("rotation"));
    TArray<double> Scale = GetDoubleArray(Obj, TEXT("scale"));

    if (Pos.Num() >= 3)
    {
        T.Position = PosFromWire(Pos);
        T.bHasPosition = true;
    }
    if (Rot.Num() >= 4)
    {
        T.Rotation = RotFromWire(Rot);
        T.bHasRotation = true;
    }
    if (Scale.Num() >= 3)
    {
        T.Scale = ScaleFromWire(Scale);
        T.bHasScale = true;
    }
    return T;
}
