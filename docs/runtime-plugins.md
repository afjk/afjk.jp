# Scene Sync Runtime Plugins

Scene Sync Runtime Plugin の設計方針と責務境界を定義するドキュメント。

## 目的

- Physics / Loomlet / Audio / Animation / Interaction / Replay を内部設計の境界として分離する
- 「外部拡張API」ではなく「内部モジュール境界」として使う
- 将来的に Plugin を安全に追加・削除・テストできる土台を作る

## 非目標

- Plugin Manager の大規模実装
- 動的な Plugin 登録・削除
- Plugin 間の依存解決システム
- サードパーティ向け拡張API

---

## Plugin 候補

| Plugin名 | 状態 | 説明 |
|---|---|---|
| `SceneSyncPhysicsPlugin` | **実装済み**（wrapper） | Rapier物理シミュレーション |
| `SceneSyncLoomletPlugin` | **実装済み**（wrapper） | Behavior Graph（Loomlet）評価 |
| `SceneSyncAudioPlugin` | 将来の課題 | 空間オーディオ・BGM管理 |
| `SceneSyncAnimationPlugin` | 将来の課題 | Animation sampling |
| `SceneSyncInteractionPlugin` | 将来の課題 | XR / pointer interaction |
| `SceneSyncReplayPlugin` | 将来の課題 | 録画・再生・rollback |

---

## Plugin Interface

```js
/**
 * @typedef {Object} SceneSyncRuntimePlugin
 * @property {string} name - プラグイン名（'physics' / 'loomlet' / 'audio' 等）
 * @property {function(SceneSyncRuntimeContext): void} [init] - 初期化
 * @property {function(unknown): void} [onSceneLoaded] - シーンロード後
 * @property {function(unknown): void} [onObjectAdded] - オブジェクト追加時
 * @property {function(unknown, unknown): void} [onObjectChanged] - オブジェクト変更時
 * @property {function(string): void} [onObjectRemoved] - オブジェクト削除時
 * @property {function(SceneClockState, SceneSyncScheduleContext): void} [update] - フレーム更新
 * @property {function(): void} [dispose] - 破棄
 */

/**
 * @typedef {Object} SceneSyncRuntimeContext
 * @property {unknown} [scene] - Three.js Scene 等
 * @property {unknown} [renderer] - Three.js Renderer 等
 * @property {unknown} [camera] - Three.js Camera 等
 * @property {unknown} [clock] - SceneClock インスタンス
 */

/**
 * @typedef {Object} SceneSyncScheduleContext
 * @property {number} now - フレーム開始時刻（ms）
 * @property {number} frameId - フレームID（単調増加）
 * @property {Object|null} clockState - Clock state
 * @property {string} [phase] - 'postPhysics' 等
 * @property {Array} events - 全 Runtime Event（collision も含む）
 * @property {Array} collisionEvents - collision event の便利配列
 * @property {Array} diagnostics - Runtime 診断情報
 */
```

すべてのメソッドはオプショナル（`?`）。Plugin が実装しないメソッドは呼ばれてもエラーにならない。

---

## Plugin Runner

複数 Plugin を順番に実行する軽量ヘルパー。

```js
const runner = createRuntimePluginRunner([
  physicsPlugin,
  // 将来: loomletPlugin, audioPlugin, ...
]);

runner.init(context);      // 全Plugin の init を順番に呼ぶ
runner.update(clockState, scheduleContext);  // 全Plugin の update を順番に呼ぶ
runner.dispose();           // 全Plugin の dispose を逆順に呼ぶ
```

実装: `html/assets/js/scenesync/runtime/runtime-plugin-runner.js`

---

## SceneSyncPhysicsPlugin

### 責務

- Physics component / scene physics settings を読む
- Rapier world を生成・更新・破棄する
- ClockState に基づいて fixed step を進める
- 結果 Transform を Three.js Object へ反映する
- Physics fixed step 後に collision event v0 を `scheduleContext` に出す

### やらないこと

- Clock を進める
- UI を直接所有する
- Loomlet graph を評価する
- Audio を鳴らす
- Network 同期ポリシーを決める

### API

```js
const physicsPlugin = createSceneSyncPhysicsPlugin({
  physicsRuntime,  // 既存の createScenePhysicsRuntime() の戻り値
});

physicsPlugin.init(context);
physicsPlugin.update(clockState, scheduleContext);
physicsPlugin.hasBodies();   // Physics body が存在するか
physicsPlugin.getRuntime();  // 内部の physicsRuntime を返す（直接アクセスが必要な場合）
physicsPlugin.dispose();
```

実装: `html/assets/js/scenesync/plugins/scene-sync-physics-plugin.js`

### 接続状況

| 場所 | 状態 |
|---|---|
| Export Viewer (`create-viewer-core.js`) | Plugin 経由に移行済み |
| Editor Shell (`scene.js`) | 直接呼び出しのまま（将来の課題） |

Editor Shell はまだいくつかの箇所で Physics を直接参照している。
Physics Plugin wrapper が安定した後、段階的に移行する。

---

## SceneSyncLoomletPlugin

### 責務

- Loomlet / Behavior Graph adapter を保持する
- ClockState に基づいて behavior graph を評価する
- `scheduleContext.events` / `scheduleContext.collisionEvents` を受け取る
- 将来、collision event を Behavior Graph の input として扱う
- 将来、`prePhysics` / `postPhysics` phase に分割する入口になる

### やらないこと

- Clock を進める
- Physics step を進める
- Audio system を直接所有する
- Animation sampling を行う
- Network 同期ポリシーを決める

### 現在の扱い

Export Viewer では、既存の `loomAdapter.tick(clockState, now)` を `SceneSyncLoomletPlugin.update(clockState, scheduleContext)` 経由に移行している。
現時点では単一 phase のみで、実際の呼び出し位置は既存どおり Physics 後 / Audio 前。
将来 `prePhysics` / `postPhysics` に分割する。

### API

```js
const loomletPlugin = createSceneSyncLoomletPlugin({
  loomAdapter,  // 既存の createExportBehaviorRuntime() の戻り値
});

loomletPlugin.init(context);
loomletPlugin.update(clockState, scheduleContext);
loomletPlugin.getAdapter();  // 内部の loomAdapter を返す（直接アクセスが必要な場合）
loomletPlugin.dispose();
```

実装: `html/assets/js/scenesync/plugins/scene-sync-loomlet-plugin.js`

### 接続状況

| 場所 | 状態 |
|---|---|
| Export Viewer (`create-viewer-core.js`) | Plugin 経由に移行済み |
| Editor Shell | 直接呼び出しのまま（将来の課題） |

---

## AudioSource operation from Loomlet

Loomlet は Scene Sync 本体の Audio 実装を直接所有しない。
Host が提供する AudioSource operation API を呼ぶ。

v0 では以下を目標にする。

```js
audioSource.play(objectId, name?)
audioSource.pause(objectId, name?)
audioSource.stop(objectId, name?)
audioSource.seek(objectId, seconds, name?)
audioSource.playOneShot(objectId, name?, options?)
```

Host API は `objectAudioController.applyEffect()` をラップして提供する。
Loomlet adapter の `setScheduleContext()` 経由で scheduleContext も渡す。

`scene.setAudio` は削除しない。非推奨（deprecated）扱いにする。
`audioSource.*` を推奨に移行する。

---

## 将来の Plugin 追加ガイドライン

新しい Plugin を追加する際は以下に従う。

1. `html/assets/js/scenesync/plugins/` 以下に `scene-sync-{name}-plugin.js` を追加する
2. Plugin Interface を実装する（全メソッドオプショナル）
3. `update(clockState, scheduleContext)` でフレーム更新する
4. `scheduleContext` を通じて Plugin 間データを受け渡す（イベント等）
5. このドキュメントの「Plugin 候補」テーブルを更新する

---

## 参照

- [runtime-schedule.md](./runtime-schedule.md) - Runtime 実行順序
- [runtime-events.md](./runtime-events.md) - Runtime Event / Collision Event スキーマ
- [scene-sync-physics.md](./scene-sync-physics.md) - Physics仕様詳細
