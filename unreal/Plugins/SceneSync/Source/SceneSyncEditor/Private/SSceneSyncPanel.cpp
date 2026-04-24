#include "SceneSyncEditorModule.h"
#include "SceneSyncEditorSubsystem.h"
#include "SceneSyncTypes.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Views/SListView.h"
#include "Framework/Docking/TabManager.h"
#include "WorkspaceMenuStructure.h"
#include "WorkspaceMenuStructureModule.h"
#include "LevelEditor.h"
#include "Editor.h"
#include "Selection.h"
#include "ToolMenus.h"
#include "Modules/ModuleManager.h"
#include "Framework/Application/SlateApplication.h"

DEFINE_LOG_CATEGORY_STATIC(LogSceneSyncEditor, Log, All);

// ============================================================
// Slate panel widget
// ============================================================

class SSceneSyncPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SSceneSyncPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

private:
    FReply OnConnectClicked();
    FReply OnDisconnectClicked();
    FReply OnSyncMeshesClicked();

    EVisibility GetConnectedVisibility() const;
    EVisibility GetDisconnectedVisibility() const;
    FText GetStatusText() const;

    USceneSyncEditorSubsystem* GetSubsystem() const;

    TSharedPtr<SEditableTextBox> PresenceUrlBox;
    TSharedPtr<SEditableTextBox> RoomBox;
    TSharedPtr<SEditableTextBox> NicknameBox;
};

void SSceneSyncPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SScrollBox)
        + SScrollBox::Slot().Padding(8)
        [
            SNew(SVerticalBox)

            // Title
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
            [
                SNew(STextBlock)
                .Text(FText::FromString(TEXT("Scene Sync")))
                .Font(FCoreStyle::GetDefaultFontStyle("Bold", 14))
            ]

            // Presence URL
            + SVerticalBox::Slot().AutoHeight().Padding(0, 2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 6, 0)
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Presence URL:"))) ]
                + SHorizontalBox::Slot().FillWidth(1.f)
                [ SAssignNew(PresenceUrlBox, SEditableTextBox)
                  .Text(FText::FromString(TEXT("wss://afjk.jp/presence"))) ]
            ]

            // Room
            + SVerticalBox::Slot().AutoHeight().Padding(0, 2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 6, 0)
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Room:"))) ]
                + SHorizontalBox::Slot().FillWidth(1.f)
                [ SAssignNew(RoomBox, SEditableTextBox)
                  .Text(FText::FromString(TEXT("ue-test"))) ]
            ]

            // Nickname
            + SVerticalBox::Slot().AutoHeight().Padding(0, 2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 6, 0)
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Nickname:"))) ]
                + SHorizontalBox::Slot().FillWidth(1.f)
                [ SAssignNew(NicknameBox, SEditableTextBox)
                  .Text(FText::FromString(TEXT("Unreal"))) ]
            ]

            // Connect / Disconnect buttons
            + SVerticalBox::Slot().AutoHeight().Padding(0, 8, 0, 4)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 4, 0)
                [
                    SNew(SButton)
                    .Text(FText::FromString(TEXT("Connect")))
                    .OnClicked(this, &SSceneSyncPanel::OnConnectClicked)
                ]
                + SHorizontalBox::Slot().AutoWidth()
                [
                    SNew(SButton)
                    .Text(FText::FromString(TEXT("Disconnect")))
                    .OnClicked(this, &SSceneSyncPanel::OnDisconnectClicked)
                ]
            ]

            // Status
            + SVerticalBox::Slot().AutoHeight().Padding(0, 4)
            [
                SNew(STextBlock)
                .Text(this, &SSceneSyncPanel::GetStatusText)
            ]

            // Sync Meshes
            + SVerticalBox::Slot().AutoHeight().Padding(0, 8, 0, 4)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("Sync Meshes")))
                .OnClicked(this, &SSceneSyncPanel::OnSyncMeshesClicked)
            ]

            // Separator
            + SVerticalBox::Slot().AutoHeight().Padding(0, 8)
            [ SNew(SSeparator) ]

            // Web URL hint
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(STextBlock)
                .Text(FText::FromString(TEXT("Web viewer: https://afjk.jp/scenesync/")))
                .AutoWrapText(true)
            ]
        ]
    ];
}

FReply SSceneSyncPanel::OnConnectClicked()
{
    USceneSyncEditorSubsystem* SS = GetSubsystem();
    if (!SS) return FReply::Handled();

    FString Url  = PresenceUrlBox->GetText().ToString();
    FString Room = RoomBox->GetText().ToString();
    FString Nick = NicknameBox->GetText().ToString();
    SS->Connect(Url, Room, Nick);
    return FReply::Handled();
}

FReply SSceneSyncPanel::OnDisconnectClicked()
{
    if (USceneSyncEditorSubsystem* SS = GetSubsystem())
    {
        SS->Disconnect();
    }
    return FReply::Handled();
}

FReply SSceneSyncPanel::OnSyncMeshesClicked()
{
    return FReply::Handled();
}

FText SSceneSyncPanel::GetStatusText() const
{
    USceneSyncEditorSubsystem* SS = GetSubsystem();
    if (!SS || !SS->IsConnected())
    {
        return FText::FromString(TEXT("Status: Disconnected"));
    }
    const TArray<FSceneSyncPeerInfo>& Peers = SS->GetPeers();
    FString Text = FString::Printf(TEXT("Status: Connected (%d peers)"), Peers.Num());
    for (const FSceneSyncPeerInfo& P : Peers)
    {
        Text += FString::Printf(TEXT("\n  %s (%s)"), *P.Nickname, *P.Device);
    }
    return FText::FromString(Text);
}

USceneSyncEditorSubsystem* SSceneSyncPanel::GetSubsystem() const
{
    if (!GEditor) return nullptr;
    return GEditor->GetEditorSubsystem<USceneSyncEditorSubsystem>();
}

// ============================================================
// Editor module — tab registration
// ============================================================

static const FName SceneSyncTabId = TEXT("SceneSyncPanel");

void FSceneSyncEditorModule::StartupModule()
{
    UE_LOG(LogSceneSyncEditor, Log, TEXT("SceneSyncEditor: StartupModule"));

    FGlobalTabmanager::Get()->RegisterNomadTabSpawner(
        SceneSyncTabId,
        FOnSpawnTab::CreateRaw(this, &FSceneSyncEditorModule::OnSpawnTab))
        .SetDisplayName(FText::FromString(TEXT("Scene Sync")))
        .SetMenuType(ETabSpawnerMenuType::Hidden);

    // Add to Window menu when menus are ready
    if (UToolMenus::IsToolMenuUIEnabled())
    {
        RegisterMenuEntry();
    }
    else
    {
        UToolMenus::RegisterStartupCallback(
            FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FSceneSyncEditorModule::RegisterMenuEntry));
    }

    // Bind editor selection changes to subsystem SelectObject
    if (GEditor)
    {
        GEditor->GetSelectedActors()->SelectionChangedEvent.AddRaw(
            this, &FSceneSyncEditorModule::OnEditorSelectionChanged);
    }
}

void FSceneSyncEditorModule::ShutdownModule()
{
    UE_LOG(LogSceneSyncEditor, Log, TEXT("SceneSyncEditor: ShutdownModule"));

    FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(SceneSyncTabId);

    if (GEditor)
    {
        GEditor->GetSelectedActors()->SelectionChangedEvent.RemoveAll(this);
    }
}

TSharedRef<SDockTab> FSceneSyncEditorModule::OnSpawnTab(const FSpawnTabArgs& Args)
{
    return SNew(SDockTab)
        .TabRole(ETabRole::NomadTab)
        [
            SNew(SSceneSyncPanel)
        ];
}

void FSceneSyncEditorModule::RegisterMenuEntry()
{
    UToolMenu* WindowMenu = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Window"));
    FToolMenuSection& Section = WindowMenu->FindOrAddSection(TEXT("WindowLayout"));
    Section.AddMenuEntry(
        TEXT("SceneSyncPanel"),
        FText::FromString(TEXT("Scene Sync")),
        FText::FromString(TEXT("Open the Scene Sync panel")),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateLambda([]()
        {
            FGlobalTabmanager::Get()->TryInvokeTab(FTabId(TEXT("SceneSyncPanel")));
        }))
    );
}

void FSceneSyncEditorModule::OnEditorSelectionChanged(UObject* /*NewSelection*/)
{
}
