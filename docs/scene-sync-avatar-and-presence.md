# Scene Sync Avatar / Presence Spec

Scene Sync の avatar、peer presence、basic hand interaction の仕様をまとめる。

---

## Presence

Scene Sync の room には複数 peer が接続する。

peer 情報の例:

```json
{
  "id": "peer-id",
  "nickname": "macOS",
  "device": "browser",
  "joinedAt": 1770000000000
}
```

Web UI では参加者一覧を表示する。

---

## Avatar

各 peer は avatar transform を broadcast できる。

```json
{
  "kind": "avatar",
  "position": [0, 1.6, 0],
  "rotation": [0, 0, 0, 1]
}
```

用途:

- 他の参加者がどこにいるかを見る。
- LBE / MR 制作時に現地で位置合わせを共有する。
- camera / gaze / controller の簡易共有。

---

## Device types

想定 device:

- Web desktop
- Mobile browser
- WebXR headset
- Unity Editor
- Unity Runtime / Player
- AI / external tool

AI / external tool は通常 avatar を持たないが、linked user の操作として scene mutation を送れる。

---

## Selection presence

選択中 object の共有は、制作支援として重要。

方針:

- local selection を取得できる。
- AI / external tool から selection を読める。
- 将来的には他 peer の selection outline を表示してもよい。

---

## Hand / grab interaction

初期段階では、hand interaction は軽量な event / transform 操作として扱う。

将来的な event 例:

```json
{
  "kind": "scene-event",
  "type": "grab-start",
  "objectId": "cube-1",
  "peerId": "peer-id",
  "hostTime": 1770000000000
}
```

競合解決は environment event と final state の収束として扱う。

---

## Related docs

- [Scene Sync Spec Index](./scene-sync-spec.md)
- [API / Protocol](./scene-sync-api-protocol.md)
- [Runtime Time Model](./scene-sync-runtime-time-model.md)
