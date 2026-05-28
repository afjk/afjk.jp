# Scene Sync Runtime Time Model

Scene Sync では、アニメーション・Loomlet オブジェクトグラフ・将来のスクリプト等の動的挙動を、時間 `t` の関数として扱う。

```txt
GLB animation:
  pose = animationClip.sample(t)

Loomlet object graph:
  output = graph.evaluate(t)
```

この仕様は、動的なオブジェクトを編集しやすくしつつ、将来的な server time / Loomlet 制御へ自然に拡張するための共通モデルである。

---

## 基本ルール

選択中のオブジェクトは編集モードとみなす。

編集しやすさを保つため、選択中のオブジェクトは常に以下の時間で評価する。

```txt
t = 0
```

未選択のオブジェクトは、選択解除された時点を時間原点として `t` が進む。

```txt
selected object:
  t = 0

unselected object:
  t = now - runtimeStartTime
```

これは「停止」ではなく、「有効な時間入力を `0` にする」仕様である。

---

## 選択と実行の関係

- オブジェクトを選択した場合:
  - runtime 自体は無効化しない
  - GLB animation / Loomlet graph も無効化しない
  - 有効な runtime time だけを `0` として扱う
- オブジェクトを選択解除した場合:
  - runtime time origin を現在時刻にリセットする
  - その直後の `t` は `0`
  - 以後、未選択の間は `t` が進む
- 再度選択した場合:
  - そのクライアントでは再び `t = 0` として評価する
- 再度選択解除した場合:
  - runtime time origin を再度リセットし、`t = 0` から実行を再開する

---

## GLB animation

GLB に animation clip が含まれる場合、Web クライアントは `AnimationMixer` を作成してよい。

ただし、アニメーション時間の正本は `AnimationMixer.update(delta)` ではなく Scene Sync の runtime time とする。

```txt
clipTime = runtimeTime % clip.duration
```

選択中は `runtimeTime = 0` なので、GLB は初期姿勢で安定する。  
選択解除後は `runtimeTime` が `0` から進み、アニメーションが先頭から再生される。

---

## Loomlet object graph

Loomlet オブジェクトグラフも同じ runtime time を入力として評価する。

```txt
selected:
  graph.evaluate(t = 0)

unselected:
  graph.evaluate(t = now - runtimeStartTime)
```

Loomlet 側で独自に selection freeze を実装しない。  
Scene Sync が解決済みの runtime time を Loomlet に渡す。

---

## Payload policy

`scene-state` / `scene-delta` では、必要に応じて軽量な runtime / animation state を含めてよい。

```json
{
  "runtime": {
    "enabled": true,
    "speed": 1
  },
  "animation": {
    "enabled": true,
    "clip": 0,
    "mode": "loop",
    "speed": 1
  }
}
```

`AnimationClip` 本体は Scene Sync payload に含めない。  
clip 実体は各クライアントが GLB から読み込む。

---

## Future: server time

将来的には `now` をローカル時刻ではなく、同期済み server time に置き換える。

```txt
selected:
  t = 0

unselected:
  t = ((serverNow - runtime.startServerTime) / 1000) * speed
```

選択解除時に `runtime.startServerTime = serverNow` を設定することで、途中参加クライアントでも GLB animation / Loomlet graph を同じ時間で評価できる。

### Clock sync

最初は軽量な ping / pong による offset 推定でよい。

```txt
client sends time-sync-request at local time t0
server responds with serverNow
client receives at local time t1
RTT = t1 - t0
estimatedOffset = serverNow + RTT / 2 - t1
estimatedServerNow = localNow + estimatedOffset
```

この推定を数秒〜10秒程度の間隔で更新する。

### Event time

Touch / click / grab / trigger などの event は、発生時刻を environment に入れる。

```json
{
  "kind": "scene-event",
  "eventId": "evt-001",
  "type": "object-click",
  "objectId": "button-1",
  "serverTime": 1770000000000,
  "peerId": "..."
}
```

イベントは単なる即時 callback ではなく、時刻付きの environment fact として扱えるようにする。

### OnStart

`OnStart` は scene load / graph start 時に発火する local event として扱う。

- Scene Sync では `OnStart` を同期 event として broadcast しない。
- 各 client の scene load timing はずれるため、同期が必要な処理は server time / explicit event を使う。
- `OnStart` は local 初期化や preview 用に使う。

---

## Implementation notes

- selection は edit mode として扱う
- selected dynamic object は `t = 0` で評価する
- runtime / animation / Loomlet graph を `enabled = false` にしない
- GLB animation は `mixer.update(delta)` だけに依存しない
- GLB animation と Loomlet object graph は同じ runtime time model を使う
- 将来の particles / physics / scripts / sounds も同じ `f(t)` モデルに乗せる
- 同期が必要な animation / behavior は、将来的に server time 基準で評価する

---

## Scene Clock: Host-Controlled Global Time

従来のモデルに加えて、MVP では **Scene Clock** という Host 所有のグローバル時刻制御システムが導入されました。

### 使い分け

**Object Runtime Time** (このドキュメント):
- Per-object の選択状態に基づく時刻
- selected object: `t = 0`
- normal object: 経過時間ベース
- 用途: object ごとの animation / behavior

**Scene Clock** (新規):
- グローバルな Host 所有時刻
- pause / seek / reset / rate control 可能
- local-only: room history に記録しない
- 用途: シーン全体の再生制御、デモ・オーサリング

### Loomlet への時刻供給

Loomlet object graph は、実際に評価される時刻として以下を受け取る：

```text
time.t = object runtime time (選択中は 0)
time.delta = object runtime の delta
time.isPaused = Scene Clock の pause 状態
time.mode = Scene Clock のモード ('server-follow' | 'local')
time.rate = Scene Clock の再生速度
time.serverNow = 常に現在の server time
```

### 重要: 時刻の独立性

- Object Runtime Time の `t = 0` 凍結はそのまま保持される
- 選択中 object は Scene Clock が動いていても `t = 0` で評価される
- Scene Clock の pause / seek は local-only で、他クライアントに影響しない

詳細は [Scene Sync Scene Clock](./scene-sync-scene-clock.md) を参照。

---

## 関連ドキュメント

- [Scene Sync Spec Index](./scene-sync-spec.md)
- [Animation](./scene-sync-animation.md)
- [Loom graph protocol](./scene-sync-loom-protocol.md)
- [Scene Sync Scene Clock](./scene-sync-scene-clock.md) - Host-controlled global time system
