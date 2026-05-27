# Scene Sync

Unity Editor / Unity Runtime と Web ブラウザ間で 3D シーンをリアルタイム共有するプラグイン。

afjk.jp/pipe の presence-server と blob store を利用して通信する。

## インストール

### UPM スコープドレジストリ（推奨）

`Packages/manifest.json` に以下を追加:

```json
{
  "scopedRegistries": [
    {
      "name": "afjk UPM Registry",
      "url": "https://upm.afjk.jp",
      "scopes": ["com.afjk"]
    }
  ],
  "dependencies": {
    "com.afjk.scene-sync": "0.3.0"
  }
}
```

Scene Sync は `com.afjk.loomlet-runtime@0.3.0` に依存しています。`upm.afjk.jp` の scoped registry が設定されていれば、Scene Sync のインストール時に Loomlet Runtime も自動で解決されます。

`com.afjk.loomlet-runtime@0.3.0` が `upm.afjk.jp` に publish 済みである必要があります。Scene Sync 側の依存 version は package release ごとに固定します。

### Git URL

Unity Editor の **Window > Package Manager > + > Add package from git URL** に以下を入力:

```
https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync
```

特定バージョンを指定する場合:

```
https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync#v0.3.0
```

`Packages/manifest.json` に直接記述する場合:

```json
{
  "dependencies": {
    "com.afjk.scene-sync": "https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync"
  }
}
```

Git URL でインストールする場合も、`com.afjk.loomlet-runtime@0.3.0` と `com.unity.cloud.gltfast@6.0.0` は package dependency として解決されます。解決されない場合は、`upm.afjk.jp` scoped registry と Unity package registry の設定を確認してください。

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

### Animated GLB Export

**UnityGLTF はオプショナル依存です。**

- Scene Sync は UnityGLTF を自動インストールしません
- Editor で animation を含む GLB エクスポートが必要な場合のみインストールしてください
- Runtime / Player builds は常に glTFast を使用します（UnityGLTF 不要）

#### インストール（オプション）

##### manifest.json による方法

```json
{
  "dependencies": {
    "org.khronos.unitygltf": "https://github.com/KhronosGroup/UnityGLTF.git"
  }
}
```

バージョンを固定する場合:

```json
{
  "dependencies": {
    "org.khronos.unitygltf": "https://github.com/KhronosGroup/UnityGLTF.git#release/2.14.1"
  }
}
```

##### Package Manager UI による方法

1. **Window > Package Manager** を開く
2. **+** ボタン > **Add package from git URL** を選択
3. 以下を入力:
   ```
   https://github.com/KhronosGroup/UnityGLTF.git
   ```

#### 有効化

以下の Define を Project Settings > Player > Scripting Define Symbols に追加:

```
SCENESYNC_USE_UNITYGLTF
```

#### Export Backend 選択

Window > Scene Sync の Export Settings で backend を選択:

- **Auto**（デフォルト）: Animation を検出して自動選択
  - Animation あり + UnityGLTF 利用可 → UnityGLTF
  - Animation なし or UnityGLTF 未インストール → glTFast
- **glTFast**: 常に glTFast を使用（Animation 非対応）
- **UnityGltf**: 常に UnityGLTF を使用（Editor のみ）

## 技術仕様

詳細は [docs/scene-sync-spec.md](../../docs/scene-sync-spec.md) を参照。
