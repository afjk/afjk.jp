# Scene Sync

Unity Editor / Unity Runtime と Web ブラウザ間で 3D シーンをリアルタイム共有するプラグイン。

afjk.jp/pipe の presence-server と blob store を利用して通信します。

## 対応環境

- Unity 2021.3 以降
- Editor publish / Runtime import の基本 GLB 処理には `com.unity.cloud.gltfast@6.0.0` を使用
- Loomlet graph runtime として `com.afjk.loomlet-runtime@0.3.0` に依存
- Animation 付き GLB export には任意で UnityGLTF を使用

## インストール

### UPM スコープドレジストリ（推奨）

`Packages/manifest.json` に scoped registry と dependency を追加します。

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
    "com.afjk.scene-sync": "0.21.0"
  }
}
```

`upm.afjk.jp` の scoped registry が設定されていれば、`com.afjk.loomlet-runtime@0.3.0` も Scene Sync の依存として解決されます。

### Git URL

Unity Editor の **Window > Package Manager > + > Add package from git URL** に以下を入力します。

```text
https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync
```

特定バージョンを指定する場合:

```text
https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync#v0.21.0
```

`Packages/manifest.json` に直接記述する場合:

```json
{
  "dependencies": {
    "com.afjk.scene-sync": "https://github.com/afjk/afjk.jp.git?path=unity/com.afjk.scene-sync#v0.21.0"
  }
}
```

Git URL でインストールする場合も、`com.afjk.loomlet-runtime@0.3.0` と `com.unity.cloud.gltfast@6.0.0` は package dependency として解決されます。解決されない場合は、`upm.afjk.jp` scoped registry と Unity package registry の設定を確認してください。

## Unity Editor で使う

### 基本フロー

1. Unity Editor で **Window > Scene Sync** を開く
2. `Create Scene Sync Setup` が表示されたら押す
   - `SceneSyncManager`
   - `SceneSync Temporary`
   がシーンに作成されます
   - `com.afjk.scene-sync-rapier` が入っている場合は、`SceneSyncManager` に
     `SceneSyncPhysicsMetadata` と `SceneSyncRapierBridge` も追加されます。
     scene physics が未設定なら、デフォルトの重力 / timestep も設定されます
3. `Room` にルームコードを入力する
4. `Connect` を押す
5. ブラウザで `https://afjk.jp/scenesync/?room=<同じルームコード>` を開く
6. Unity の Hierarchy で共有したい GameObject を選択する
7. `Publish Selected` を押す
8. 以後は Scene Sync root を移動 / 回転 / scale すると、接続先に transform が同期されます

`Publish Selected` は、選択 GameObject を Unity 管理オブジェクトとして登録し、必要な `SceneSyncIdentity` を付与してから GLB を upload / broadcast します。通常は先に `Add Selected to Managed` を押す必要はありません。

### Window の主なセクション

#### Connection

接続状態、Room、`Connect` / `Disconnect` を操作します。

通常は `Room` だけを入力すれば十分です。`Presence URL`、`Blob URL`、`Nickname` は `Connection Settings` foldout にあります。

#### Primary Actions

通常操作で使うボタンです。

- `Publish Selected`
  - 選択中の publish 可能な Unity GameObject を Scene Sync に公開します
- `Publish Managed Objects`
  - Managed Objects に含まれる Unity GameObject をまとめて publish します
- `Add Selected to Managed`
  - 選択中の Unity GameObject を Managed Objects に追加します
  - publish 前に管理対象だけを整えたい場合に使います

`Publish Selected` と `Publish Managed Objects` は接続中のみ有効です。

#### Selection

現在の選択が publish / manage 可能かを表示します。

- MeshFilter または SkinnedMeshRenderer を含む Unity GameObject は publish 可能
- mesh を持たない GameObject は Managed Objects には追加できますが、そのままでは publish できません
- remote temporary object は Unity 側の原本ではないため、manage / publish できません
- `SceneSyncManager` 自身は manage / publish できません

#### Managed Summary

Managed Objects の概要を表示します。

- Managed 数
- publish 済み数
- `SceneSyncIdentity` 付与済み数
- error 状態の有無

詳細な ObjectField リストは `Details & Advanced > Managed Object Details` にあります。

#### Details & Advanced

通常は折りたたんだままで使えます。

- `Managed Object Details`
  - `Include Manager Children`
  - Managed Objects の ObjectField リスト
- `Export Settings`
  - GLB export backend
  - UnityGLTF status
  - transparent name hints
  - max GLB upload size
- `Setup`
  - `SceneSyncManager` / `SceneSync Temporary` の作成・選択
- `Troubleshooting`
  - `Repair Remote Object Picking`
  - `Show Scene Sync Gizmos`
- `Quick Guide`
  - Editor window 内の短い操作ガイド

### リモートオブジェクトの扱い

ブラウザや他の Scene Sync クライアントから来た GLB は `SceneSync Temporary` 配下に temporary object として作成されます。

- Unity 由来の GameObject は Unity プロジェクト側の原本です
- Remote temporary object は Scene Sync から受信した一時オブジェクトです
- Remote temporary object は手動 disconnect 時に削除されます
- Remote GLB は子メッシュではなく Scene Sync root を移動してください
- `Repair Remote Object Picking` は、インポート済み GLB の子メッシュが選択可能になってしまった時だけ使う修復用です

## Runtime（MonoBehaviour）で使う

1. GameObject に `SceneSyncManager` コンポーネントをアタッチ
2. Inspector で以下を設定:
   - `Presence Url`: `wss://afjk.jp/presence`（デフォルト）
   - `Room`: ルームコード
   - `Nickname`: 表示名
   - `Sync Root`: 同期対象の Transform ルート（省略時はシーン直下）
   - `Auto Connect`: 起動時に自動接続する場合はチェック
3. ブラウザで `https://afjk.jp/scenesync/?room=<同じルームコード>` を開く

Editor は制作ツールとして Unity GameObject を原本扱いします。一方、Runtime / Player は一時的な Scene Sync 参加者として扱います。Runtime で受信したオブジェクトは temporary object として生成され、Scene Sync 上で削除された場合はローカルでも削除されます。

### Runtime playback clock

`SceneSyncManager.PlaybackClockMode` は `Local`、`SharedPlaybackFollow`、
`SharedPlaybackControl`、`RoomTime` を提供します。Presence の
`welcome.serverTime` と受信した `scene-clock.roomNow` は受信時の local
monotonic clock に anchor されるため、端末 wall clock がずれていても
Shared Playback の経過時間には影響しません。

XR viewer など controller にならない client では次のように設定します。

```csharp
manager.PlaybackClockFollowPolicy = SceneSyncPlaybackClockFollowPolicy.FollowerOnly;
manager.AllowPlaybackClockControl = false;
```

`FollowerOnly` と `AutoFollowOrLocal` は、有効な remote controller がいる間だけ
自動的に `SharedPlaybackFollow` を effective mode として使います。controller の
release、disconnect、lease expiry 後は最後の Shared ActiveTime を local clock へ
rebaseし、1倍速で連続して進みます。`FollowerOnly` は controller 取得payloadを
送信しません。既存の `Manual` + `Local` は従来どおり各componentのlocal playbackを
維持します。

transport API は `PausePlaybackClock()`、`ResumePlaybackClock()`、
`SeekPlaybackClock()`、`ResetPlaybackClock()`、`SetPlaybackClockRate()`、
`ReleaseSharedPlaybackControl()` です。Follow中とRoom Timeではpause/seek/rateを
拒否します。`GetPlaybackClockSample(objectId)` はAnimation、Loomlet、physics adapter
が共有するeffective `ActiveTime` / `ObjectAge`、pause、rate、controller、revisionを
返します。

## Animated GLB Export

UnityGLTF は optional dependency です。

- Scene Sync は UnityGLTF を自動インストールしません
- Editor で animation を含む GLB export が必要な場合のみインストールしてください
- Runtime / Player builds は常に glTFast を使用します（UnityGLTF 不要）

### UnityGLTF のインストール（オプション）

UnityGLTF は git package のため、default branch ではなく release tag 固定を推奨します。

```json
{
  "dependencies": {
    "org.khronos.unitygltf": "https://github.com/KhronosGroup/UnityGLTF.git#release/2.19.5"
  }
}
```

Package Manager UI から入れる場合:

1. **Window > Package Manager** を開く
2. **+** ボタン > **Add package from git URL** を選択
3. 以下を入力:

```text
https://github.com/KhronosGroup/UnityGLTF.git#release/2.19.5
```

既存 project で UnityGLTF の PackageCache 由来の `.meta` 警告が出る場合は、Unity Editor を閉じてから `Library/PackageCache/org.khronos.unitygltf@*` を削除し、Unity に再取得させてください。

### UnityGLTF の有効化

`Window > Scene Sync > Details & Advanced > Export Settings` の UnityGLTF セクションで状態を確認できます。

## Rapier Physics（オプション）

Scene Sync 本体は Rapier に hard dependency しません。Web 側の Rapier
物理シーンを Unity 側でも動かす場合は、別 package
`com.afjk.scene-sync-rapier` を追加します。

開発中は `com.afjk.rapier` が registry 未登録のため、サンプル project では
Rapier package を Git URL で明示的に追加してください。

```json
{
  "dependencies": {
    "com.afjk.scene-sync-rapier": "file:/Users/afjk/github/SceneSyncWork/afjk.jp/unity/com.afjk.scene-sync-rapier",
    "com.afjk.rapier": "https://github.com/afjk/rapier-unity.git?path=Packages/com.afjk.rapier#v0.3.0"
  }
}
```

`SceneSyncRapierBridge` を `SceneSyncManager` と同じ GameObject に追加すると、
Scene Sync の `physics` JSON を Rapier world に変換し、dynamic body の pose を
Unity `Transform` に反映します。

- `Install UnityGLTF`
  - UnityGLTF package を追加します
- `Enable UnityGLTF Support`
  - `SCENESYNC_USE_UNITYGLTF` define を追加します
- `Check UnityGLTF Status Again`
  - Package / Define / Exporter 状態を再確認します

手動で define を設定する場合は、Project Settings > Player > Scripting Define Symbols に以下を追加します。

```text
SCENESYNC_USE_UNITYGLTF
```

### Export Backend

`Details & Advanced > Export Settings` で backend を選択できます。

- `Auto`（デフォルト）
  - Animation あり + UnityGLTF 利用可: UnityGLTF
  - Animation なし or UnityGLTF 未インストール: glTFast
- `glTFast`
  - 常に glTFast を使用
  - animation は export されません
- `UnityGltf`
  - 常に UnityGLTF を使用
  - Editor のみ

UnityGLTF による publish 時は、名前付き clip を呼ぶ Animation Event を検出し、export 中だけ一時的な AnimatorOverrideController で焼き込み済み clip に差し替えます。元の AnimatorController や AnimationClip asset は変更しません。

## Export Support

Editor の補助メニューとして **Tools > Scene Sync > Support** を利用できます。

- `Apply Transparent Name Hints To Selection`
  - 選択中の Material または GameObject 配下の Material を走査します
  - Material 名または Shader 名に `transparent` / `trans` / `alpha` / `cheek` / `glass` などのヒントがある場合、透明 Material として扱われるように設定します
- `Report Animation Events In Selection`
  - 選択中の AnimationClip、Prefab、GameObject 配下の AnimationClip を走査します
  - Animation Event が含まれている場合、GLB にそのまま保持されない可能性を Console に警告します
- `Bake Event-Named Clip Curves To New Clips`
  - Animation Event の `stringParameter` または `functionName` が別の AnimationClip 名と一致する場合、その clip の curve を event 時刻へコピーした publish 用 clip を作成します
  - 選択中の GameObject 配下の Animation / Animator / serialized field から AnimationClip 候補を集めます
  - 任意の MonoBehaviour callback の実行結果までは推測できないため、curve として表現されている blend shape / material / transform などが対象です

透明補正は汎用的な名前ヒントだけを使います。表情や状態変化が任意の MonoBehaviour callback に依存している場合、その callback の実行結果までは自動推測できません。AnimationCurve として表現されている blend shape / material / transform などが自動 bake の対象です。

## Gaussian Splat（KHR_gaussian_splatting GLB）

SceneSync の 3DGS 交換形式は `KHR_gaussian_splatting` を含む GLB です。Unity 側に
`.sog` / `.spz` / `.lcc2` などの parser は持たず、SceneSync Web が正規化した GLB を
そのまま受け取ります。

### Editor で配置する

`GameObject > Scene Sync > Import Gaussian Splat GLB...` から GLB を選ぶと、
`SceneSyncGaussianSplatSource` を持つ GameObject がシーンに追加されます。
`[ExecuteAlways]` なので、シーンを開いた時点で Scene View に表示されます。Play モードへ
入る必要はありません。position / rotation / scale / active は通常の GameObject と同じです。

GLB の渡し方は2通りです。

| フィールド | 用途 |
| --- | --- |
| `Glb Asset` (`TextAsset`) | プロジェクト内に置く場合。拡張子を `.glb.bytes` にしてください。`.glb` のままだと glTFast の importer が処理して `KHR_gaussian_splatting` が落ちます |
| `Glb Path` (`string`) | プロジェクト外を直接指す場合。絶対パス、または `StreamingAssets` からの相対パス |

### Runtime

SceneSync 経由で受け取った GLB は、既存の GLB 同期・asset cache 経路のまま扱われます。
`KHR_gaussian_splatting` を検出した場合だけ Gaussian Splat 経路へ分岐し、transform /
visibility / delete などは通常 GLB と同じように同期されます。

### Renderer backend

Unity 6 以降では `Tools > Scene Sync > Install UnitySplats Renderer...` を実行してください。
SceneSync が次の Git package を固定 version で追加し、script reload 後に実 renderer を
自動登録して既存 preview を作り直します。

- `Unity.WebP 0.3.22`
- `UnitySplats 1.2.0`（commit `6c0258189a2b124af1282fa9236fd9b6637f1a1a`）

実 backend は GLB を UnitySplats の `GsplatRuntimeLoader` へ渡し、実 `GsplatAsset` と
`GsplatRenderer` を生成します。SH0–SH3、Gaussian ellipse、opacity を保持します。delete / reload
では生成 asset と GPU resource を renderer の lifecycle に沿って解放します。

UnitySplats は Git package の推移依存として解決できないため consuming project 側へ追加します。
SceneSync package 自体は hard dependency を持たず、未導入や Unity 2021–2023 では依存ゼロの
点群 preview（`MeshTopology.Points`）へ戻ります。**preview は配置とスケール確認用で、実 Gaussian
描画ではありません。**

独自 backend への差し替えも従来どおり可能です。

```csharp
SceneSyncGaussianSplatBackend.Register(new MySplatBackend());
```

backend は `ISceneSyncGaussianSplatBackend` を実装し、座標を glTFast と同じ規則
（X 反転）で Unity 空間へ変換して返します。詳細は
[3DGS エンジン統合](../../docs/scene-sync-3dgs-engine-integration.md) を参照してください。

## 技術仕様

- [Scene Sync Spec](../../docs/scene-sync-spec.md)
- [Unity オーサリングモデル](../../docs/scene-sync-unity-authoring.md)
- [座標系と visualBasis](../../docs/scene-sync-coordinate-system.md)
- [Asset / Blob / Cache](../../docs/scene-sync-assets-and-cache.md)
- [3DGS エンジン統合](../../docs/scene-sync-3dgs-engine-integration.md)
