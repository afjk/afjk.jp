# Scene Sync Loom / Behavior Graph Protocol

Scene Sync と Loomlet graph の連携仕様をまとめる。

---

## 基本方針

Scene Sync は Loomlet DSL parser を持たない。

Scene Sync が受け取るのは、すでに compile 済みの JSON graph である。

```text
Loomlet DSL
  -> Loomlet compiler / external tool
  -> JSON graph
  -> Scene Sync scene-graph-* mutation
```

これにより、Scene Sync 本体は軽量に保ちつつ、Loomlet 側の DSL / compiler / package system を独立して進化させられる。

---

## Graph scope

Scene Sync では graph を scope 付きで扱う。

### Scene scope graph

room / scene 全体に作用する graph。

用途:

- 環境変化
- 複数 object の coordinated behavior
- global clock / event handling

### Object scope graph

特定 object に作用する graph。

用途:

- object の transform animation
- color / material change
- GLB animation control
- local interaction response

---

## `scene-graph-set`

Graph を設定する。

```json
{
  "kind": "scene-graph-set",
  "scope": "object",
  "objectId": "cube-1",
  "graph": {
    "version": "loomlet.graph.v1",
    "nodes": [],
    "edges": []
  }
}
```

Scene scope の場合:

```json
{
  "kind": "scene-graph-set",
  "scope": "scene",
  "graph": {
    "version": "loomlet.graph.v1",
    "nodes": [],
    "edges": []
  }
}
```

---

## `scene-graph-clear`

Graph を削除する。

```json
{
  "kind": "scene-graph-clear",
  "scope": "object",
  "objectId": "cube-1"
}
```

---

## Immediate graph と ongoing behavior

Scene Sync では、graph の使い方を分けて考える。

### Immediate / apply-once graph

一度だけ評価して scene mutation を作る graph。

用途:

- 選択 object を整列する
- 円形配置する
- ランダム回転を適用する
- scene delta を一括生成する

### Ongoing / animated behavior graph

時間 `t` や event を入力として継続評価する graph。

用途:

- Lissajous animation
- 音反応
- interaction response
- GLB animation speed control

---

## Time input

Ongoing behavior graph は Scene Sync の runtime time model を使う。

- selected object: `t = 0`
- unselected object: `t = now - runtimeStartTime`
- 将来: `serverNow` ベース

詳細は [Runtime Time Model](./scene-sync-runtime-time-model.md) を参照。

---

## Event input

クリック、タッチ、grab などの event は graph environment に入れる。

```json
{
  "events": [
    {
      "type": "object-click",
      "objectId": "button-1",
      "time": 1.23
    }
  ]
}
```

イベントは local callback ではなく、graph evaluation の入力として扱う。

---

## Package / extension

Loomlet 側では package による node library 拡張を想定する。

Scene Sync 側の方針:

- package の解決・登録は Loomlet compiler / external tool 側で行う。
- Scene Sync は compile 済み graph を受け取る。
- Scene Sync runtime が知らない node は、安全に無視 / error にする。
- host extension として必要な node だけを Scene Sync に登録する。

---

## Related docs

- [Scene Sync Spec Index](./scene-sync-spec.md)
- [Runtime Time Model](./scene-sync-runtime-time-model.md)
- [Animation](./scene-sync-animation.md)
