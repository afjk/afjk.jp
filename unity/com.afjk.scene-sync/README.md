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
    "com.afjk.scene-sync": "0.19.5"
  }
}
```

Scene Sync は `com.afjk.loomlet-runtime@0.3.0` に依存しています。`upm.afjk.jp` の scoped registry が設定されていれば、Scene Sync のインストール時に Loomlet Runtime も自動で解決されます。

`com.afjk.loomlet-runtime@0.3.0` が `upm.afjk.jp` に publish 済みである必要があります。Scene Sync 側の依存 version は package release ごとに固定します。

Unity 受信側は `scene-graph-set` / `scene-graph-clear` と `scene-state.loomGraphs` を受け取り、対象 GameObject に `SceneSyncLoomletBehaviour` を bind します。Object scope の graph は同じ object への再送で置き換わり、clear または replace 時に `sceneOffsetPosition` の base position を復元します。Unity 側は Loomlet DSL を parse せず、compile 済み Graph JSON だけを評価します。

### Git URL

Unity Editor の **Window > Package Manager > + > Add package from git URL** に以下を入力:

```
https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync
```

特定バージョンを指定する場合:

```
https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync#v0.19.5
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

UnityGLTF は git package のため、default branch ではなく release tag 固定を推奨します。

```json
{
  "dependencies": {
    "org.khronos.unitygltf": "https://github.com/KhronosGroup/UnityGLTF.git#release/2.19.5"
  }
}
```

既存 project で UnityGLTF の PackageCache 由来の `.meta` 警告が出る場合は、Unity Editor を閉じてから
`Library/PackageCache/org.khronos.unitygltf@*` を削除し、Unity に再取得させてください。

##### Package Manager UI による方法

1. **Window > Package Manager** を開く
2. **+** ボタン > **Add package from git URL** を選択
3. 以下を入力:
   ```
   https://github.com/KhronosGroup/UnityGLTF.git#release/2.19.5
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

### Export Support

Editor の補助メニューとして **Tools > Scene Sync > Support** を利用できます。

- **Apply Transparent Name Hints To Selection**
  - 選択中の Material または GameObject 配下の Material を走査します
  - Material 名または Shader 名に `transparent` / `trans` / `alpha` / `cheek` / `glass` などのヒントがある場合、透明 Material として扱われるように設定します
- **Report Animation Events In Selection**
  - 選択中の AnimationClip、Prefab、GameObject 配下の AnimationClip を走査します
  - Animation Event が含まれている場合、GLB にそのまま保持されない可能性を Console に警告します

透明補正は汎用的な名前ヒントだけを使います。表情や状態変化が Animation Event / MonoBehaviour callback に依存している場合は、GLB publish 前に transform / material / blend shape の animation curve として bake してください。

## 技術仕様

詳細は [docs/scene-sync-spec.md](../../docs/scene-sync-spec.md) を参照。
