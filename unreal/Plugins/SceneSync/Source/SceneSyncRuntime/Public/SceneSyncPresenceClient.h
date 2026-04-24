#pragma once

#include "CoreMinimal.h"
#include "SceneSyncTypes.h"
#include "IWebSocket.h"
#include "Dom/JsonObject.h"
#include "TimerManager.h"

DECLARE_MULTICAST_DELEGATE(FOnSceneSyncConnected);
DECLARE_MULTICAST_DELEGATE(FOnSceneSyncDisconnected);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnSceneSyncPeersUpdated, const TArray<FSceneSyncPeerInfo>&);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnSceneSyncHandoffReceived, TSharedPtr<FJsonObject>);

class SCENESYNCRUNTIME_API FSceneSyncPresenceClient
{
public:
    FSceneSyncPresenceClient();
    ~FSceneSyncPresenceClient();

    void Connect(const FString& PresenceUrl, const FString& Room, const FString& Nickname);
    void Disconnect();
    bool IsConnected() const;

    void Broadcast(const FString& PayloadJson);
    void SendHandoff(const FString& TargetId, const FString& PayloadJson);

    FString GetId() const { return ClientId; }
    FString GetRoom() const { return CurrentRoom; }
    const TArray<FSceneSyncPeerInfo>& GetPeers() const { return Peers; }

    FOnSceneSyncConnected OnConnected;
    FOnSceneSyncDisconnected OnDisconnected;
    FOnSceneSyncPeersUpdated OnPeersUpdated;
    FOnSceneSyncHandoffReceived OnHandoffReceived;

    bool bShouldReconnect = true;

private:
    void OnWebSocketConnected();
    void OnWebSocketClosed(int32 StatusCode, const FString& Reason, bool bWasClean);
    void OnWebSocketMessage(const FString& Message);
    void OnWebSocketError(const FString& Error);

    void SendHello();
    void HandleWelcome(const TSharedPtr<FJsonObject>& Msg);
    void HandlePeers(const TSharedPtr<FJsonObject>& Msg);
    void HandleHandoff(const TSharedPtr<FJsonObject>& Msg);
    void SendRaw(const FString& Json);

    void ScheduleReconnect();

    TSharedPtr<IWebSocket> WebSocket;
    FString ClientId;
    FString CurrentRoom;
    FString SavedPresenceUrl;
    FString SavedNickname;
    TArray<FSceneSyncPeerInfo> Peers;
    bool bConnected = false;

    FTimerHandle ReconnectTimerHandle;
};
