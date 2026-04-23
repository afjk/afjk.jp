# Scene Sync

Unity Editor / Unity Runtime と Web ブラウザ間で 3D シーンをリアルタイム共有するプラグイン。

afjk.jp/pipe の presence-server と blob store を利用して通信する。

## インストール

`Packages/manifest.json` に以下を追加:

```json
{
  "scopedRegistries": [
    {
      "name": "afjk",
      "url": "https://upm.afjk.jp",
      "scopes": ["com.afjk"]
    }
  ],
  "dependencies": {
    "com.afjk.scene-sync": "0.1.0"
  }
}
```

### Git URL

Unity Editor の **Window > Package Manager > + > Add package from git URL** に以下を入力:

```
https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync
```

特定バージョンを指定する場合:

```
https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync#v0.1.0
```

`Packages/manifest.json` に直接記述する場合:

```json
{
  "dependencies": {
    "com.afjk.scene-sync": "https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync"
  }
}
```

依存パッケージ（`com.unity.cloud.gltfast@6.0.0`）は自動インストールされない場合があるため、別途追加してください。

## インストール

### UPM スコープドレジストリ（推奨）

`Packages/manifest.json` に以下を追加:

```json
{
  "scopedRegistries": [
    {
      "name": "afjk",
      "url": "https://upm.afjk.jp",
      "scopes": ["com.afjk"]
    }
  ],
  "dependencies": {
    "com.afjk.scene-sync": "0.1.0"
  }
}
```

### Git URL

Unity Editor の **Window > Package Manager > + > Add package from git URL** に以下を入力:

```
https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync
```

特定バージョンを指定する場合:

```
https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync#v0.1.0
```

`Packages/manifest.json` に直接記述する場合:

```json
{
  "dependencies": {
    "com.afjk.scene-sync": "https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync"
  }
}
```

依存パッケージ（`com.unity.cloud.gltfast@6.0.0`）は自動インストールされない場合があるため、別途追加してください。

---

## 使い方

### Editor 拡張

1. `Window > Scene Sync` を開く
2. Presence URL（デフォルト: `wss://afjk.jp/presence`）とルームコードを入力
3. `Connect` ボタンを押す
4. ブラウザで `https://afjk.jp/scenesync/?room=<同じルームコード>` を開く

### Runtime（MonoBehaviour）

1. GameObject に `SceneSyncManager` コンポーネントをアタッチ
2. Inspector で以下を設定:
   - `Presence Url`: `wss://afjk.jp/presence`（デフォルト）
   - `Room`: ルームコード
   - `Nickname`: 表示名
   - `Sync Root`: 同期対象の Transform ルート（省略時はシーン直下）
   - `Auto Connect`: 起動時に自動接続する場合はチェック
3. ブラウザで `https://afjk.jp/scenesync/?room=<同じルームコード>` を開く

## 技術仕様

詳細は [docs/scene-sync-spec.md](../../docs/scene-sync-spec.md) を参照。
