# SceneSync Unreal Engine Plugin

ブラウザ・Unity・Unreal Engine 間で 3D シーンをリアルタイム共有するプラグインです。

## 動作環境

- Unreal Engine 5.4 以上（開発・検証は UE 5.7）
- macOS / Windows

## 導入方法

### 1. プラグインのコピー

UE プロジェクトの `Plugins/` フォルダに `SceneSync` を配置します。

```
YourProject/
└── Plugins/
    ├── SceneSync/          ← このリポジトリの unreal/Plugins/SceneSync をコピー
    └── glTFRuntime/        ← glB モデルを受信する場合は必須（下記参照）
```

### 2. glTFRuntime の導入（glB モデル受信を使う場合）

[glTFRuntime](https://github.com/rdeioris/glTFRuntime) を Plugins フォルダに配置します。

```bash
cd YourProject/Plugins
git clone https://github.com/rdeioris/glTFRuntime.git
```

### 3. プロジェクトファイルの更新

`YourProject.uproject` の `Plugins` セクションにプラグインを追加します。

```json
{
  "Plugins": [
    { "Name": "SceneSync", "Enabled": true },
    { "Name": "glTFRuntime", "Enabled": true }
  ]
}
```

### 4. ビルド

UE エディタを開くと「プラグインが見つかりました。再ビルドしますか？」と表示されるので **Yes** を選択します。

またはコマンドラインからビルドします。

```bash
# Mac
/Users/Shared/Epic\ Games/UE_5.x/Engine/Build/BatchFiles/Mac/Build.sh \
  UnrealEditor Mac Development \
  -Project="/path/to/YourProject.uproject"
```

## 使用方法

### パネルを開く

メニューバー → **Window → Scene Sync**

PIE（Play In Editor）なしでエディタ上からそのまま接続できます。

### 接続

| 項目 | 説明 |
|------|------|
| **Presence URL** | 接続先サーバーの WebSocket URL（例: `wss://afjk.jp/presence`） |
| **Room** | ルーム名。ブラウザ側と同じ名前を指定する |
| **Nickname** | エディタ側の表示名 |
| **Connect** | 接続開始 |
| **Disconnect** | 切断 |

### 接続後の動作

- 同じルームにいる他クライアント（ブラウザ / Unity）のシーン状態を自動受信し、レベル上にアクターが出現します
- `asset.type: primitive` のオブジェクトは UE のプリミティブメッシュで表示されます
- `meshPath` が指定されたオブジェクトは glB をダウンロードして glTFRuntime でインポートします
- 他クライアントがオブジェクトを移動すると `scene-delta` を受信してリアルタイムに追従します

### 座標系

| | Three.js / glTF | Unreal Engine |
|---|---|---|
| 上方向 | Y | Z |
| 単位 | メートル | センチメートル |
| 座標変換 | X → UE -X、Y → UE Z、-Z → UE -Y |

## サーバー

| 環境 | URL |
|------|-----|
| 本番 | `wss://afjk.jp/presence` |
| ステージング | `wss://staging.afjk.jp/presence` |
| ローカル | `ws://localhost:8787` |

ローカルサーバーの起動方法は [`apps/presence-server`](../apps/presence-server) を参照してください。

## プラグイン構成

```
Plugins/SceneSync/
├── SceneSync.uplugin
└── Source/
    ├── SceneSyncRuntime/       # Runtime モジュール（接続・シーン管理）
    │   ├── SceneSyncSubsystem         # UGameInstanceSubsystem（PIE / ゲーム用）
    │   ├── SceneSyncPresenceClient    # WebSocket クライアント
    │   ├── SceneSyncBlobClient        # glB アップロード / ダウンロード
    │   └── SceneSyncProtocol          # メッセージ変換・座標系変換
    └── SceneSyncEditor/        # Editor モジュール（エディタ UI）
        ├── SceneSyncEditorSubsystem   # UEditorSubsystem（エディタ常時接続用）
        └── SSceneSyncPanel            # Slate パネル UI
```
