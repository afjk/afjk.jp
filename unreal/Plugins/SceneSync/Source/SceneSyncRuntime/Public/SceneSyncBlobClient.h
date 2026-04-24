#pragma once

#include "CoreMinimal.h"

DECLARE_DELEGATE_TwoParams(FOnBlobUploaded, bool /*bSuccess*/, const FString& /*Path*/);
DECLARE_DELEGATE_TwoParams(FOnBlobDownloaded, bool /*bSuccess*/, TArray<uint8> /*Data*/);

class SCENESYNCRUNTIME_API FSceneSyncBlobClient
{
public:
    void SetBlobBaseUrl(const FString& Url) { BlobBaseUrl = Url; }
    const FString& GetBlobBaseUrl() const { return BlobBaseUrl; }

    // Derive blob base URL from a presence WebSocket URL
    // e.g. "wss://afjk.jp/presence" -> "https://afjk.jp/presence/blob"
    static FString DeriveFromPresenceUrl(const FString& PresenceUrl);

    void UploadGlb(const TArray<uint8>& GlbData, const FString& Path, FOnBlobUploaded OnComplete);
    void DownloadGlb(const FString& Path, FOnBlobDownloaded OnComplete);

    static FString GenerateRandomPath();

private:
    FString BlobBaseUrl;
};
