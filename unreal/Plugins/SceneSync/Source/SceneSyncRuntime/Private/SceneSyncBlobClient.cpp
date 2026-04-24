#include "SceneSyncBlobClient.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Math/UnrealMathUtility.h"

DEFINE_LOG_CATEGORY_STATIC(LogSceneSyncBlob, Log, All);

FString FSceneSyncBlobClient::DeriveFromPresenceUrl(const FString& PresenceUrl)
{
    FString Url = PresenceUrl;
    Url = Url.Replace(TEXT("wss://"), TEXT("https://"));
    Url = Url.Replace(TEXT("ws://"), TEXT("http://"));
    Url = Url.TrimEnd();
    if (Url.EndsWith(TEXT("/")))
    {
        Url = Url.LeftChop(1);
    }
    Url += TEXT("/blob");
    return Url;
}

void FSceneSyncBlobClient::UploadGlb(const TArray<uint8>& GlbData, const FString& Path, FOnBlobUploaded OnComplete)
{
    FString Url = FString::Printf(TEXT("%s/%s"), *BlobBaseUrl, *Path);
    UE_LOG(LogSceneSyncBlob, Log, TEXT("Uploading glB to %s (%d bytes)"), *Url, GlbData.Num());

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(Url);
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("model/gltf-binary"));
    Request->SetContent(GlbData);

    Request->OnProcessRequestComplete().BindLambda(
        [Path, OnComplete](FHttpRequestPtr Req, FHttpResponsePtr Resp, bool bSuccess)
        {
            bool bOk = bSuccess && Resp.IsValid() && (Resp->GetResponseCode() == 200 || Resp->GetResponseCode() == 201);
            if (!bOk)
            {
                int32 Code = Resp.IsValid() ? Resp->GetResponseCode() : 0;
                UE_LOG(LogSceneSyncBlob, Warning, TEXT("Upload failed (HTTP %d) path=%s"), Code, *Path);
            }
            else
            {
                UE_LOG(LogSceneSyncBlob, Log, TEXT("Upload success: %s"), *Path);
            }
            OnComplete.ExecuteIfBound(bOk, Path);
        });

    Request->ProcessRequest();
}

void FSceneSyncBlobClient::DownloadGlb(const FString& Path, FOnBlobDownloaded OnComplete)
{
    FString Url = FString::Printf(TEXT("%s/%s"), *BlobBaseUrl, *Path);
    UE_LOG(LogSceneSyncBlob, Log, TEXT("Downloading glB from %s"), *Url);

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(Url);
    Request->SetVerb(TEXT("GET"));

    Request->OnProcessRequestComplete().BindLambda(
        [OnComplete](FHttpRequestPtr Req, FHttpResponsePtr Resp, bool bSuccess)
        {
            if (!bSuccess || !Resp.IsValid() || Resp->GetResponseCode() != 200)
            {
                int32 Code = Resp.IsValid() ? Resp->GetResponseCode() : 0;
                UE_LOG(LogSceneSyncBlob, Warning, TEXT("Download failed (HTTP %d)"), Code);
                OnComplete.ExecuteIfBound(false, TArray<uint8>());
                return;
            }
            UE_LOG(LogSceneSyncBlob, Log, TEXT("Download success: %d bytes"), Resp->GetContent().Num());
            OnComplete.ExecuteIfBound(true, Resp->GetContent());
        });

    Request->ProcessRequest();
}

FString FSceneSyncBlobClient::GenerateRandomPath()
{
    const FString Chars = TEXT("abcdefghijklmnopqrstuvwxyz0123456789");
    FString Result;
    Result.Reserve(8);
    for (int32 i = 0; i < 8; ++i)
    {
        Result.AppendChar(Chars[FMath::RandRange(0, Chars.Len() - 1)]);
    }
    return Result;
}
