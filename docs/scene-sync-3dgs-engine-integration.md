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

## 3層構成

Unity / Godot とも同じ3層で組んである。エンジン差はいちばん下だけ。

| 層 | 役割 | Unity | Godot |
| --- | --- | --- | --- |
| 検出 | GLB の JSON chunk を読み、`KHR_gaussian_splatting` を判定 | `SceneSyncGaussianSplatGlb` | `SceneSyncGaussianSplatGlb` |
| 振り分け | backend があれば渡す。無ければプレビューへ落とす | `SceneSyncGaussianSplatBackend` | `SceneSyncGaussianSplatBackend` |
| 描画 | 実際の splat 描画 | backend（`UnitySplats` 想定） | backend（`godot-gsplat` 想定） |

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
godot/tests/run_all.sh          # "Gaussian Splat GLB Tests" を含む
```

Unity は EditMode テスト `unity/com.afjk.scene-sync/Tests/Editor/SceneSyncGaussianSplatGlbTests.cs`
（Unity Test Runner から実行）。

3実装のテストは同じ期待値を見ている:

- 最小 fixture の splat 数・kernel・colorSpace
- 宣言漏れ / 非 POINTS mode / 必須 attribute 欠けが error になること
- 未知 kernel が warning どまりであること
- `COLOR_0` があればそちらを優先し、無ければ SH0 + OPACITY から色を作ること
- backend 登録時は backend、未登録・拒否・null 返却時はプレビューへ落ちること

Godot と Web は `html/scenesync/experiments/fixtures/` の GLB を共有している
（エンジンごとに fixture を複製しない）。Unity のテストはパッケージ内で完結させるため、
同じ構成の GLB をテスト内で組み立てる。

## ライセンス方針

採用候補は permissive license を優先する。

### UnitySplats（Unity 候補）

本体 MIT。Third Party Notices 上の主要依存（gsplat-unity / PlayCanvas Engine 由来 /
UnityGaussianSplatting 由来 / GPUSorting / Spark / Niantic SPZ / ZstdSharp / Unity.WebP は MIT、
libwebp は BSD-3-Clause）にも GPL / AGPL 系の強い copyleft は確認されていない。

### godot-gsplat（Godot 候補）

本体 MIT。依存する `godot` crate（godot-rust / gdext）は MPL-2.0。
MPL-2.0 は file-level copyleft なので、通常の依存利用で Scene-Sync-Godot 全体へ
copyleft が伝播するものではない。

- godot-rust 本体は原則 fork / 改変せず upstream をそのまま利用する
- やむを得ず MPL 対象ファイルを改変して配布する場合は、その改変ファイルについて
  ソース提供義務を満たす
- Scene-Sync-Godot 独自コードと MPL 対象コードの境界を維持する

### 現状

**この時点では、どちらの renderer も配布物に同梱していない。**
SceneSync 側は backend の登録口だけを持ち、依存は増やしていない。
実際に bundle / package へ含める段階で、以下を行う。

- [ ] 同梱するコンポーネントの copyright / license notice を保持する
- [ ] `THIRD_PARTY_LICENSES.md` へ節を追加する（Unity / Godot それぞれ）
- [ ] dependency 追加時に GPL / AGPL 等の強い copyleft が混入していないか再確認する

## 残作業

この段階で入っているのは、検出・振り分け・Editor 配置・Runtime 同期・プレビューまで。
以下は実機とライブラリが必要なため未了。

- [ ] `UnitySplats` を backend として実装し、Unity Editor / Runtime で実データを描画する
- [ ] `godot-gsplat` を backend として実装し、Godot Editor / Runtime で実データを描画する
- [ ] Quest / PICO 等 XR 環境での Stereo 描画確認
- [ ] 大規模 capture（数百万 splat）でのメモリ / フレームレート確認
- [ ] 同一 GLB を Web / Unity / Godot で並べた見えの比較
- [ ] 配布物への Third Party Notices 集約

## 対象外

- Unity / Godot 側で `.sog` / `.spz` / `.lcc2` 等を直接 decode する実装
- 3DGS 形式ごとの独自同期プロトコル
- `KHR_gaussian_splatting` 以外の独自中間形式
- VR 向け decimate / SH 削減などの最適化（別 Issue）
