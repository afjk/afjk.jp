# Scene Sync Runtime Events

Runtime Event の定義とスキーマ。Plugin 間で 1 frame 内に受け渡す軽量イベント。

## 基本形

```json
{
  "type": "physics.collision.enter",
  "source": "physics",
  "phase": "postPhysics",
  "time": 1.25,
  "tick": 75,
  "frameId": 120,
  "objectIdA": "object-a",
  "objectIdB": "object-b",
  "pairKey": "object-a|object-b",
  "payload": {}
}
```

## Collision Event v0

### 型定義

```ts
type CollisionEventType =
  | 'physics.collision.enter'
  | 'physics.collision.exit';
```

### Event fields

| field | required | description |
|---|---|---|
| `type` | required | `'physics.collision.enter'` または `'physics.collision.exit'` |
| `source` | required | `'physics'` 固定 |
| `phase` | required | 通常 `'postPhysics'` |
| `time` | required | `clockState.t` が有効なら使う |
| `tick` | optional | Physics tick。有効なら含める |
| `frameId` | optional | scheduleContext の frameId |
| `objectIdA` | required | 衝突関与オブジェクトのID（canonical順） |
| `objectIdB` | required | 衝突関与オブジェクトのID（canonical順） |
| `pairKey` | required | `objectIdA|objectIdB`（両IDが判明している場合） |
| `payload` | optional | 将来の拡張用 |

### v0 では含まない項目

- `point`（衝突点座標）
- `normal`（衝突法線）
- `impulse`（衝突インパルス）
- contact manifold の詳細
- relative velocity
- material 情報
- sensor / trigger フィルタリング
- network replication フラグ
- replay determinism 保証

これらは将来の拡張として `payload` に追加できる形にする。

## pairKey の方針

`objectIdA` / `objectIdB` は canonical order（辞書順ソート）にする。

```js
const [objectIdA, objectIdB] = [a, b].sort();
const pairKey = `${objectIdA}|${objectIdB}`;
```

**理由:**
- イベント順序を安定させる
- 重複排除しやすくする
- replay / test がやりやすい

## scheduleContext での受け渡し

```js
scheduleContext.events        // 全 Runtime Event（collision も含む）
scheduleContext.collisionEvents  // collision event の便利配列（events のサブセット）
```

`emitScheduleEvent()` は type が `physics.collision.*` の場合に `collisionEvents` にも自動で積む。

## 参照

- [runtime-schedule.md](./runtime-schedule.md) - Runtime 実行順序
- [runtime-plugins.md](./runtime-plugins.md) - Plugin 設計
- `html/assets/js/scenesync/runtime/runtime-events.js` - Event helpers
- `html/assets/js/scenesync/runtime/schedule-context.js` - scheduleContext helpers
