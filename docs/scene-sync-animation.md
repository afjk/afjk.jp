# Scene Sync Animation Spec

Scene Sync における GLB animation と、将来的な time control / Loomlet graph 連携の方針をまとめる。

---

## Scope

最初に扱う animation は GLB に含まれる animation clip である。

将来的には以下も視野に入れる。

- pause / resume
- seek / time 指定
- playback speed
- loop / once
- selected object への一括 animation 操作
- Scene Sync host-provided time に合わせた再生
- Loomlet graph からの animation control

---

## GLB animation detection

Unity から publish する場合、animation を含む GameObject は UnityGLTF exporter を使う。

方針:

- animation がある場合は UnityGLTF exporter を選ぶ。
- animation がない場合は既存 exporter を使ってよい。
- Web client では GLTFLoader で animation clips を登録する。
- object ごとに animation mixer / clip list を持つ。

---

## Animation metadata

GLB を読み込んだ object には、利用可能な animation clip の情報を保持する。

例:

```json
{
  "objectId": "micro-orc",
  "animations": [
    { "name": "Idle", "duration": 1.2 },
    { "name": "Walk", "duration": 0.9 }
  ]
}
```

この metadata は UI / AI / external tools が clip を選ぶために使う。

---

## Playback operations

将来的な payload 例:

```json
{
  "kind": "scene-animation",
  "objectId": "micro-orc",
  "action": "play",
  "clip": "Walk",
  "loop": true,
  "speed": 1.0
}
```

```json
{
  "kind": "scene-animation",
  "objectId": "micro-orc",
  "action": "pause"
}
```

```json
{
  "kind": "scene-animation",
  "objectId": "micro-orc",
  "action": "seek",
  "time": 1.5
}
```

---

## Time synchronization

Animation を複数 client で完全に同期したい場合、local `Date.now()` ではなく Scene Sync の同期時刻を使う。

関連:

- [Runtime Time Model](./scene-sync-runtime-time-model.md)

方針:

- host が用途に合う時刻を提供する。
- client は host-provided time に基づいて animation time を計算する。
- animation state は「今 clip X を hostTime T から再生している」と表現できるようにする。

---

## Loomlet graph integration

Loomlet graph は、継続的な behavior / procedural animation の記述に使える。

例:

- object を Lissajous curve で動かす。
- 音やイベントに応じて transform を変える。
- GLB animation の playback speed を graph から変える。

Scene Sync 側は Loomlet DSL parser を持たず、JSON graph を受け取る。

関連:

- [Loom graph protocol](./scene-sync-loom-protocol.md)

---

## Related docs

- [Scene Sync Spec Index](./scene-sync-spec.md)
- [Runtime Time Model](./scene-sync-runtime-time-model.md)
- [Loom graph protocol](./scene-sync-loom-protocol.md)
