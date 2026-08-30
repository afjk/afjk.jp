# SceneSync 3DGS エンジン統合（Unity / Godot）

Issue: #539
Refs: #534, #535

## 方針

SceneSync の 3DGS 交換形式は **`GLB + KHR_gaussian_splatting`** に統一する（#531 / #534）。
Unity 版 / Godot 版 SceneSync では、`.sog` / `.spz` / `.lcc2` / `.splat` / `.ksplat` の
parser を**エンジンごとに実装しない**。SceneSync Web が正規化した GLB を受け取り、
各エンジンの Gaussian Splat renderer へそのまま渡す。

```text
PLY / SPZ / SOG / LCC2 / LCC / SPLAT / KSPLAT
                    ↓
              SceneSync Web            ← @playcanvas/splat-transform
                    ↓
       KHR_gaussian_splatting GLB      ← SceneSync の交換形式
              ↙             ↘
           Unity            Godot
         Editor/Runtime   Editor/Runtime
```

### SuperSplatの権利メタデータ

SuperSplat共有URLから生成したGLBは、表示用の帰属表記をglTF標準の
`asset.copyright`へ、機械可読な取得元・ライセンス・作者情報を
`asset.extras.scenesync.gaussianSplatSource`へ保存する。resolverが返した値は
Scene Sync側でもURL、長さ、scene IDの一致を検証してから格納する。

```json
{
  "asset": {
    "copyright": "\"Lion\" by Renaud (...)\nSource: ...\nLicensed under CC BY 4.0 (...)",
    "extras": {
      "scenesync": {
        "gaussianSplatSource": {
          "provider": "supersplat",
          "sceneId": "56155c3f",
          "pageUrl": "https://superspl.at/scene/56155c3f",
          "license": { "code": "CC-BY-4.0", "label": "CC BY 4.0", "url": "..." },
          "attribution": { "status": "complete", "text": "...", "creators": [] }
        }
      }
    }
  }
}
```

このGLBを単体で再読み込みした場合も、検証済みの
`gaussianSplatSource`をScene Syncオブジェクトのmetadataへ復元する。

## 3層構成

Unity / Godot とも同じ3層で組んである。エンジン差はいちばん下だけ。

| 層 | 役割 | Unity | Godot |
| --- | --- | --- | --- |
| 検出 | GLB の JSON chunk を読み、`KHR_gaussian_splatting` を判定 | `SceneSyncGaussianSplatGlb` | `SceneSyncGaussianSplatGlb` |
| 振り分け | backend があれば渡す。無ければプレビューへ落とす | `SceneSyncGaussianSplatBackend` | `SceneSyncGaussianSplatBackend` |
| 描画 | 実際の splat 描画 | `UnitySplats 1.2.0` adapter | pinned `godot-gsplat` adapter |

判定規則は Web 実装 `html/assets/js/scenesync/loaders/khr-gaussian-splatting.js` と
同じにそろえてある。3実装が同じ GLB について同じ結論を出すことが前提。

- `mode` は `POINTS (0)` でなければ error
- 必須 attribute 欠けは error
  （`POSITION` / `ROTATION` / `SCALE` / `OPACITY` / `SH_DEGREE_0_COEF_0`）
- `extensionsUsed` に宣言が無ければ error
- 未知の `kernel` / `colorSpace` / `projection` / `sortingMethod` は warning（描画は試みる）
- `projection` / `sortingMethod` の省略は既定値扱い（warning にしない）

## Backend の契約

SceneSync 本体は 3DGS の parser も renderer も持たない。描画は差し替え可能な backend に委ねる。

### Unity

```csharp
public interface ISceneSyncGaussianSplatBackend
{
    string Name { get; }
    bool CanRender(SceneSyncGaussianSplatGlbInfo info);
    GameObject CreateSplatObject(byte[] glb, SceneSyncGaussianSplatGlbInfo info);
}

SceneSyncGaussianSplatBackend.Register(new MySplatBackend());
```

### Godot

```gdscript
# get_backend_name() / can_render(info) / create_splat_node(data, info) を持つ Object
SceneSyncGaussianSplatBackend.register_backend(MySplatBackend.new())
```

backend 実装側の約束:

- 返すのは親を持たないノード。配置は SceneSync 側が行う
- **座標は Unity なら glTFast と同じ規則（X 反転）で Unity 空間へ変換して返す。**
  通常 GLB と同じ `ImportedGlbRoot` の下に置かれるため、ここがずれると Mesh GLB と
  Gaussian Splat GLB で位置が食い違う
- ノードの破棄で native リソースも解放されるようにする（Unity は `OnDestroy`、
  Godot は `_exit_tree` / `NOTIFICATION_PREDELETE` 等）。SceneSync の delete /
  reconnect / asset reload はノードを破棄することで dispose を行う

## 標準の実 renderer backend

### UnitySplats

SceneSync package は UnitySplats を hard dependency にせず、公開 API を reflection で検出する。
Unity 6 以降で `Tools > Scene Sync > Install UnitySplats Renderer...` を実行すると、次を
Git revision 固定で Package Manager へ追加する。

- `Unity.WebP 0.3.22`
- `UnitySplats 1.2.0` / commit `6c0258189a2b124af1282fa9236fd9b6637f1a1a`

導入後は `GsplatRuntimeLoader.Load(..., GsplatFileFormat.Glb, CompressionMode.Spark,
SourceCoordinates.Unspecified, null)` を使い、GLB から実 `GsplatAsset` / `GsplatRenderer` を
生成する。SH degree 0–3 は asset のまま保持する。GameObject の破棄時は renderer の asset
参照を外してから生成 asset を破棄し、GPU buffer も UnitySplats の public lifecycle で解放する。

### godot-gsplat

Godot は 4.5+ の Mobile または Forward+ renderer を使う。Compatibility renderer では
実 backend を選ばず点群 preview へ戻す。依存は repository へ vendor せず、次で host 用
release GDExtension を再現可能に構築する。

```bash
npm run install:godot-gsplat
```

upstream は commit `dfc8df4893f0f6e26c847590ff1669fa8404da6d`、Cargo dependency は
committed lockfile で固定する。Godot RenderingDevice が std430 struct の 16-byte alignment を
検証するため、84-byte sort push constant に 12-byte tail padding を加える小さな compatibility
patch も hash 付きで適用する。これが無い場合、Godot 4.6.3 では 940,549 splat を decode
できても sort dispatch が拒否され、単一楕円に見える。

desktop の自動設定は source 全点を保持したまま active set を 500,000 に制限し、SH3 を
維持する。XR は upstream の adaptive XR profile を使う。明示的に変更する場合は project
setting `scene_sync/gaussian_splat/render_profile` に Low=1 / Middle=2 / High=3 / XR=4 を指定する。
High は全 splat を描画するため、大規模な室内 capture では GPU stall を起こし得る。

## 点群プレビュー（backend 未登録時）

backend が未登録でも「読み込んだものが見えない」状態にはしない。
`POSITION` と `COLOR_0`（無ければ `SH_DEGREE_0_COEF_0` + `OPACITY`）だけを読み出し、
点群として描画するプレビューを SceneSync 内に持っている。依存はゼロ。

- Unity: `SceneSyncGaussianSplatPreview` → `MeshTopology.Points` の `Mesh`
- Godot: `SceneSyncGaussianSplatPreview` → `Mesh.PRIMITIVE_POINTS` の `ArrayMesh`

制限:

- 楕円 kernel も view-dependent SH も再現しない。位置と SH0 の色だけ
- 300,000 点を超える splat は間引く（`MAX_PREVIEW_POINTS`）
- sparse accessor / 外部 buffer / 圧縮 bufferView（Draco・meshopt）は読まない
- Unity の点の見た目はレンダーパイプライン依存。
  `SceneSyncGaussianSplatPreview.MaterialFactory` で material を差し替えられる

**プレビューは配置とスケール確認のためのもので、最終的な描画品質ではない。**
実データの見えを確認する用途では backend を登録する。

## Editor での読み込み

「Editor で確認するために一度 Runtime を起動する」状態にはしない、という要件に合わせている。

### Unity

`GameObject > Scene Sync > Import Gaussian Splat GLB...` から GLB を選ぶと、
`SceneSyncGaussianSplatSource` を持つ GameObject がシーンに追加される。

- `[ExecuteAlways]` なので、シーンを開いた時点で Scene View に表示される
- position / rotation / scale / active は通常の GameObject として編集・保存できる
- 生成された視覚オブジェクトは `HideFlags.DontSave` 付きでシーンには保存されず、
  参照（`glbAsset` か `glbPath`）から毎回組み立て直す
- 通常 Mesh GLB と同一シーンに混在できる

GLB の渡し方は2通り:

| フィールド | 用途 | 注意 |
| --- | --- | --- |
| `glbAsset` (`TextAsset`) | プロジェクト内に置く場合 | 拡張子を `.glb.bytes` にする。`.glb` のままだと glTFast の importer が処理して `KHR_gaussian_splatting` が落ちる |
| `glbPath` (`string`) | プロジェクト外を直接指す場合 | 絶対パス、または `StreamingAssets` からの相対パス |

### Godot

`Project > Tools > Scene Sync: Gaussian Splat GLB を読み込む...` から GLB を選ぶと、
`SceneSyncGaussianSplatNode3D` が編集中のシーンへ追加される（Undo / Redo 対応）。
`Add Node` ダイアログから直接追加してもよい。

- `@tool` なので、シーンを開いた時点で 3D viewport に表示される
- Transform / visible は通常の `Node3D` として編集・保存できる
- 視覚ノードは owner を持たないため `.tscn` には保存されず、`glb_path` から再構築する
- 通常 Mesh GLB と同一シーンに混在できる

Godot プロジェクト内（`res://`）に GLB を置く場合は、Import dock で
**Keep File (exported as is)** を選ぶ。Godot 標準の glTF importer は
`KHR_gaussian_splatting` を解釈できないため、そのままではエクスポート後に読めなくなる。

## Runtime（SceneSync 接続時）

既存の GLB 同期・asset cache・SceneDocument 経路をそのまま使う。
GLB バイト列が手に入った時点で `KHR_gaussian_splatting` を判定し、
検出した場合だけ Gaussian Splat 経路へ分岐する。

| | 分岐点 |
| --- | --- |
| Unity | `SceneSyncManager.DownloadAndCreateObject()` と `LoadGlbFromBytes()`（blob 失効からの復元） |
| Godot | `SceneSyncGltfHelper.import_glb()`（`scene_sync_manager` / `scene_sync_wire_asset_visual` の共通入口） |

分岐後も Scene Sync オブジェクトとしての扱いは通常 GLB と同じ:

- 同じ `ImportedGlbRoot` 構造の下に置く（Unity）／同じ `ImportedGlb` コンテナに入れる（Godot）
- position / rotation / scale / visibility は通常どおり同期する
- delete / reconnect / asset reload ではノードごと破棄する
- Loomlet graph / physics metadata / wire metadata の適用も通常 GLB と同じ

読み込みに失敗した場合は、通常 GLB と同じ fallback へ落とす
（Unity は fallback primitive、Godot は `null` を返して呼び出し側の fallback に任せる）。

## 通常 Mesh との混在

Web 側の制約と同じく、**同一 mesh 内**での Gaussian primitive と通常 primitive の混在は
想定しない。同一 GLB 内で mesh を分けている場合は:

- Unity: splat primitive のみ描画し、混在していることを warning で知らせる
- Godot: splat を描画したうえで、通常 mesh 側も `GLTFDocument` で読み込んで同じ親に付ける
  （`GLTFDocument` が失敗しても splat 側は残す）

シーン全体としての「Mesh GLB と Gaussian Splat GLB の混在」は、別オブジェクトとして
配置すれば Editor / Runtime のどちらでも成立する。

## テスト

```bash
# Web（判定規則の基準）
npm run test:3dgs-khr

# Godot
npm run install:godot-gsplat
SCENESYNC_REQUIRE_GODOT_GSPLAT=1 godot/tests/run_all.sh
```

Unity は EditMode テスト `unity/com.afjk.scene-sync/Tests/Editor/SceneSyncGaussianSplatGlbTests.cs`
と `SceneSyncUnitySplatsBackendTests.cs`（Unity Test Runner から実行）。実 capture を使う場合は
`SCENESYNC_GAUSSIAN_GLB_FIXTURE=/absolute/path/to/capture.glb` を設定する。

3実装のテストは同じ期待値を見ている:

- 最小 fixture の splat 数・kernel・colorSpace
- 宣言漏れ / 非 POINTS mode / 必須 attribute 欠けが error になること
- 未知 kernel が warning どまりであること
- `COLOR_0` があればそちらを優先し、無ければ SH0 + OPACITY から色を作ること
- backend 登録時は backend、未登録・拒否・null 返却時はプレビューへ落ちること

Godot と Web は `html/scenesync/experiments/fixtures/` の GLB を共有している
（エンジンごとに fixture を複製しない）。Unity のテストはパッケージ内で完結させるため、
同じ構成の GLB をテスト内で組み立てる。

`tmp/1_3DGS2.sog` を repository 外の一時 GLB に変換した実データ確認では、225,736,504 bytes、
940,549 splat、SH degree 3 を UnitySplats と godot-gsplat の両方で decode した。Godot 4.6.3
Metal の実画面では 500,000 active splat / SH3 の Gaussian ellipse 描画を確認した。

## ライセンス方針

採用候補は permissive license を優先する。

### UnitySplats

本体 MIT。Third Party Notices 上の主要依存（gsplat-unity / PlayCanvas Engine 由来 /
UnityGaussianSplatting 由来 / GPUSorting / Spark / Niantic SPZ / ZstdSharp / Unity.WebP は MIT、
libwebp は BSD-3-Clause）にも GPL / AGPL 系の強い copyleft は確認されていない。

### godot-gsplat

本体 MIT。依存する `godot` crate（godot-rust / gdext）は MPL-2.0。
MPL-2.0 は file-level copyleft なので、通常の依存利用で Scene-Sync-Godot 全体へ
copyleft が伝播するものではない。

- godot-rust 本体は原則 fork / 改変せず upstream をそのまま利用する
- やむを得ず MPL 対象ファイルを改変して配布する場合は、その改変ファイルについて
  ソース提供義務を満たす
- Scene-Sync-Godot 独自コードと MPL 対象コードの境界を維持する

### 現状

renderer binary / package は afjk.jp repository には同梱しない。Unity は利用 project の UPM、
Godot は明示 installer が生成する ignored directory へ入る。どちらも upstream の license /
Third Party Notices を保持し、固定 version / commit は `THIRD_PARTY_LICENSES.md` に記録する。

## 残作業

実 backend、Editor / Runtime routing、実 capture の decode / desktop 描画までは完了している。
以下は対象実機が必要なため未了。

- [ ] Quest / PICO 等 XR 環境での Stereo 描画確認
- [ ] 大規模 capture（数百万 splat）でのメモリ / フレームレート確認
- [ ] 同一 GLB を Web / Unity / Godot で並べた見えの比較
- [ ] Godot の Android / Quest 用 GDExtension cross-build と export 検証

## 対象外

- Unity / Godot 側で `.sog` / `.spz` / `.lcc2` 等を直接 decode する実装
- 3DGS 形式ごとの独自同期プロトコル
- `KHR_gaussian_splatting` 以外の独自中間形式
- VR 向け decimate / SH 削減などの最適化（別 Issue）
