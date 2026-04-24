#include "SceneSyncPresenceClient.h"
#include "WebSocketsModule.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "TimerManager.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"

DEFINE_LOG_CATEGORY_STATIC(LogSceneSyncPresence, Log, All);

static const float ReconnectDelay = 3.0f;

FSceneSyncPresenceClient::FSceneSyncPresenceClient()
{
    // WebSockets module is loaded by FSceneSyncRuntimeModule::StartupModule
}

FSceneSyncPresenceClient::~FSceneSyncPresenceClient()
{
    bShouldReconnect = false;
    Disconnect();
}

void FSceneSyncPresenceClient::Connect(const FString& PresenceUrl, const FString& Room, const FString& Nickname)
{
    SavedPresenceUrl = PresenceUrl;
    CurrentRoom = Room;
    SavedNickname = Nickname;

    FString EncodedRoom = FGenericPlatformHttp::UrlEncode(Room);
    FString WsUrl = FString::Printf(TEXT("%s/?room=%s"), *PresenceUrl, *EncodedRoom);
    UE_LOG(LogSceneSyncPresence, Log, TEXT("Connecting to %s"), *WsUrl);

    WebSocket = FWebSocketsModule::Get().CreateWebSocket(WsUrl, TEXT(""));
    WebSocket->OnConnected().AddRaw(this, &FSceneSyncPresenceClient::OnWebSocketConnected);
    WebSocket->OnClosed().AddRaw(this, &FSceneSyncPresenceClient::OnWebSocketClosed);
    WebSocket->OnMessage().AddRaw(this, &FSceneSyncPresenceClient::OnWebSocketMessage);
    WebSocket->OnConnectionError().AddRaw(this, &FSceneSyncPresenceClient::OnWebSocketError);
    WebSocket->Connect();
}

void FSceneSyncPresenceClient::Disconnect()
{
    bShouldReconnect = false;
    if (WebSocket.IsValid() && bConnected)
    {
        WebSocket->Close();
    }
    bConnected = false;
}

bool FSceneSyncPresenceClient::IsConnected() const
{
    return bConnected;
}

void FSceneSyncPresenceClient::Broadcast(const FString& PayloadJson)
{
    // Avoid round-trip parse/serialize; PayloadJson is already valid JSON
    SendRaw(FString::Printf(TEXT("{\"type\":\"broadcast\",\"payload\":%s}"), *PayloadJson));
}

void FSceneSyncPresenceClient::SendHandoff(const FString& TargetId, const FString& PayloadJson)
{
    SendRaw(FString::Printf(TEXT("{\"type\":\"handoff\",\"targetId\":\"%s\",\"payload\":%s}"),
        *TargetId, *PayloadJson));
}

void FSceneSyncPresenceClient::SendRaw(const FString& Json)
{
    if (WebSocket.IsValid() && bConnected)
    {
        WebSocket->Send(Json);
    }
}

void FSceneSyncPresenceClient::OnWebSocketConnected()
{
    UE_LOG(LogSceneSyncPresence, Log, TEXT("WebSocket connected"));
    bConnected = true;
    SendHello();
}

void FSceneSyncPresenceClient::OnWebSocketClosed(int32 StatusCode, const FString& Reason, bool bWasClean)
{
    UE_LOG(LogSceneSyncPresence, Log, TEXT("WebSocket closed: %d %s"), StatusCode, *Reason);
    bConnected = false;
    Peers.Empty();
    OnDisconnected.Broadcast();
    if (bShouldReconnect)
    {
        ScheduleReconnect();
    }
}

void FSceneSyncPresenceClient::OnWebSocketError(const FString& Error)
{
    UE_LOG(LogSceneSyncPresence, Warning, TEXT("WebSocket error: %s"), *Error);
    bConnected = false;
    Peers.Empty();
    OnDisconnected.Broadcast();
    if (bShouldReconnect)
    {
        ScheduleReconnect();
    }
}

void FSceneSyncPresenceClient::OnWebSocketMessage(const FString& Message)
{
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Message);
    TSharedPtr<FJsonObject> Msg;
    if (!FJsonSerializer::Deserialize(Reader, Msg) || !Msg.IsValid())
    {
        return;
    }

    FString Type;
    if (!Msg->TryGetStringField(TEXT("type"), Type))
    {
        return;
    }

    if (Type == TEXT("welcome"))
    {
        HandleWelcome(Msg);
    }
    else if (Type == TEXT("peers"))
    {
        HandlePeers(Msg);
    }
    else if (Type == TEXT("handoff"))
    {
        HandleHandoff(Msg);
    }
    else if (Type == TEXT("ping"))
    {
        SendRaw(TEXT("{\"type\":\"pong\"}"));
    }
}

void FSceneSyncPresenceClient::SendHello()
{
    // "Unreal Engine 5" (version not easily available at this point)
    FString DeviceStr = TEXT("Unreal Engine 5");

    TSharedPtr<FJsonObject> Msg = MakeShareable(new FJsonObject);
    Msg->SetStringField(TEXT("type"), TEXT("hello"));
    Msg->SetStringField(TEXT("nickname"), SavedNickname);
    Msg->SetStringField(TEXT("device"), DeviceStr);

    FString Out;
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
    FJsonSerializer::Serialize(Msg.ToSharedRef(), Writer);
    SendRaw(Out);
}

void FSceneSyncPresenceClient::HandleWelcome(const TSharedPtr<FJsonObject>& Msg)
{
    Msg->TryGetStringField(TEXT("id"), ClientId);
    Msg->TryGetStringField(TEXT("room"), CurrentRoom);
    UE_LOG(LogSceneSyncPresence, Log, TEXT("Welcome: id=%s room=%s"), *ClientId, *CurrentRoom);
    OnConnected.Broadcast();
}

void FSceneSyncPresenceClient::HandlePeers(const TSharedPtr<FJsonObject>& Msg)
{
    const TArray<TSharedPtr<FJsonValue>>* PeersArr;
    if (!Msg->TryGetArrayField(TEXT("peers"), PeersArr))
    {
        return;
    }

    Peers.Empty();
    for (auto& PeerVal : *PeersArr)
    {
        const TSharedPtr<FJsonObject>* PeerObj;
        if (!PeerVal->TryGetObject(PeerObj))
        {
            continue;
        }
        FSceneSyncPeerInfo Info;
        (*PeerObj)->TryGetStringField(TEXT("id"), Info.Id);
        (*PeerObj)->TryGetStringField(TEXT("nickname"), Info.Nickname);
        (*PeerObj)->TryGetStringField(TEXT("device"), Info.Device);
        (*PeerObj)->TryGetNumberField(TEXT("lastSeen"), Info.LastSeen);
        Peers.Add(Info);
    }
    UE_LOG(LogSceneSyncPresence, Log, TEXT("Peers updated: %d peers"), Peers.Num());
    OnPeersUpdated.Broadcast(Peers);
}

void FSceneSyncPresenceClient::HandleHandoff(const TSharedPtr<FJsonObject>& Msg)
{
    const TSharedPtr<FJsonObject>* PayloadObj;
    if (!Msg->TryGetObjectField(TEXT("payload"), PayloadObj))
    {
        return;
    }

    // presence-server sends from as an object {id, nickname, device}.
    // Extract the id and store it as _fromId in the payload for subsystem handlers.
    TSharedPtr<FJsonObject> Payload = MakeShareable(new FJsonObject(**PayloadObj));
    const TSharedPtr<FJsonObject>* FromObj;
    if (Msg->TryGetObjectField(TEXT("from"), FromObj))
    {
        FString FromId;
        (*FromObj)->TryGetStringField(TEXT("id"), FromId);
        Payload->SetStringField(TEXT("_fromId"), FromId);
    }
    OnHandoffReceived.Broadcast(Payload);
}

void FSceneSyncPresenceClient::ScheduleReconnect()
{
    // Use a one-shot ticker for reconnect (no world available here)
    FTSTicker::GetCoreTicker().AddTicker(
        FTickerDelegate::CreateLambda([this](float) -> bool
        {
            if (bShouldReconnect)
            {
                UE_LOG(LogSceneSyncPresence, Log, TEXT("Reconnecting..."));
                Connect(SavedPresenceUrl, CurrentRoom, SavedNickname);
            }
            return false; // one-shot
        }),
        ReconnectDelay
    );
}
