# Scene Sync Runtime Schedule

Scene Sync Runtime の 1 frame / 1 tick 内の概念上の実行順序を定義するドキュメント。

## 目的

- Clock / Loomlet / Physics / Animation / Audio の実行順序を明文化する
- 将来的なPhase分割・Plugin追加の設計基準にする
- Editor / Player / Export Viewer 間の意図的な順序差分を記録する

## 非目標

- 完全なECS実装
- rollback / replay の完全設計
- collision impulse / normal / point など詳細 collision payload の実装
- Loomlet phase分割の実装（将来の課題）
- Plugin Managerの大規模導入

---

## 概念上の実行順序

1 frame / 1 tick は概念上、以下の順序で進む。

```
1. Clock update
2. Input / scheduled command collection
3. Tick boundary command apply
4. Loomlet pre-physics phase
5. Physics fixed step
6. Collision / physics events collection
7. Loomlet post-physics phase
8. Animation / Audio sampling
9. Apply runtime outputs to view
10. Record / sync / diagnostics
```

---

## Current implementation mapping

### Clock update

- Export Viewer: `sceneClock.tick(now)` がフレーム先頭で呼ばれ、`clockState` を返す
- Editor Shell: `sceneClockStateForTick` が update ループで計算される
- Physics / Animation / Audio はこの `clockState` を参照して動作する

### Input / scheduled command collection

- 現時点では明示的なコマンドキューはない
- Editor / Player のUI操作が都度 `physicsRuntime.markDirty()` などを呼ぶ形で実装されている

### Tick boundary command apply

- `physicsRuntime.rebuild()` がこのフェーズに対応する（dirty フラグで制御）
- 毎フレームの `update()` 内で dirty チェックが行われ、必要なら rebuild する

### Loomlet pre-physics phase

- 未実装
- 現時点では Loomlet は単一 phase で評価される
- **将来の課題**: `prePhysics` phase を追加する

### Physics fixed step

- `physicsRuntime.update(clockState)` → 内部で `world.stepTo(targetTick)` を実行
- fixed timestep: デフォルト `1/60` 秒
- ClockState の `t` から `targetTick = floor(worldAge / timestep)` を計算して固定刻みで進める
- Step 上限（step-limit）を超えた場合はシミュレーションを停止する
- 現在は `SceneSyncPhysicsPlugin.update(clockState, scheduleContext)` 経由で呼び出す（後述）

### Collision / physics events collection

- PhysicsPlugin が physics fixed step 後に collision event を `scheduleContext.events` に積む
- v0 では `physics.collision.enter` / `physics.collision.exit` のみ
- event schema は `docs/runtime-events.md` を参照
- Loomlet post-physics phase はこの event を消費できる設計にする

### Loomlet post-physics phase

- Export Viewer では `SceneSyncLoomletPlugin.update(clockState, scheduleContext)` 経由で評価する
- 現在は既存の `loomAdapter.tick(clockState, now)` を薄く包んでいる
- `scheduleContext.phase = 'postPhysics'` として渡す
- Export Viewer では `scheduleContext.events` が Loomlet evaluation context の `events` として渡る
- `scheduleContext.collisionEvents` も adapter 境界で渡る
- collision enter/exit を Behavior Graph input として扱える
- Object Behavior Graph では関連する collision event のみを受け取る
- Scene Behavior Graph ではすべての Runtime Event を受け取る
- `audioSource.playOneShot` effect により、collision reaction sound を表現できる
- **将来の課題**: `prePhysics` / `postPhysics` に分割する

### Animation / Audio sampling

- Export Viewer: `animationRuntime.sampleAt(time)` が Physics より先に呼ばれている
  - 現状の実装では Physics と Animation の順序が逆転している（下記「意図的な差分」参照）
- `objectAudioController.tick(now, clockState)` が毎フレーム実行される

### Apply runtime outputs to view

- `physicsRuntime.update()` 内の `applyWorldToObjects()` が Three.js Object の Transform を更新する
- Animation runtime の `sampleAt()` も同様に Object の Transform を直接更新する

### Record / sync / diagnostics

- `scheduleContext.diagnostics` に記録する設計（将来の課題）
- 現時点は `createSceneSyncScheduleContext()` で生成した context を渡す

---

## 意図的な差分（Editor / Player / Export Viewer）

| フェーズ | Export Viewer | Editor Shell | 備考 |
|---|---|---|---|
| Clock update | フレーム先頭で `sceneClock.tick(now)` | `sceneClockStateForTick` を計算 | どちらも Clock が基準 |
| Physics step | `clockState.transportActive` でアクティブ判定 | `clockState.active` でアクティブ判定 | isClockActive の実装が異なる |
| Animation | Physics より先に評価（現実装） | 概念順序と同様 | 将来的に整合させる |
| Loomlet | Physics の後に `SceneSyncLoomletPlugin.update()` 経由 | 別の実装 | prePhysics/postPhysics 分割が将来の課題 |
| Audio | `objectAudioController.tick()` | 独自実装 | Clock に従う点は共通 |

これらの差分は現時点では意図した差分として記録する。
段階的にこのドキュメントの概念順序に整合させていく。

---

## scheduleContext

Runtime の各フェーズ間でデータを受け渡す軽量な context オブジェクト。

```js
import { createSceneSyncScheduleContext } from './runtime/schedule-context.js';

const scheduleContext = createSceneSyncScheduleContext({
  now,
  frameId: ++runtimeFrameId,
  clockState,
});
// scheduleContext.events         - 全 Runtime Event
// scheduleContext.collisionEvents - collision event の便利配列
// scheduleContext.diagnostics    - runtime 診断情報
```

`emitScheduleEvent(scheduleContext, event)` でイベントを積む。
type が `physics.collision.*` の場合は `collisionEvents` にも自動で積まれる。

実装: `html/assets/js/scenesync/runtime/schedule-context.js`

---

## 参照

- [scene-sync-physics.md](./scene-sync-physics.md) - Physics仕様詳細
- [scene-sync-runtime-time-model.md](./scene-sync-runtime-time-model.md) - Time Model詳細
- [runtime-plugins.md](./runtime-plugins.md) - Plugin設計
- [runtime-events.md](./runtime-events.md) - Runtime Event / Collision Event スキーマ
