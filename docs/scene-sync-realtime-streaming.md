# Scene Sync Realtime Streaming Notes

Scene Sync で将来的に扱う可能性がある live streaming / recording / VJ 演出のメモ。

---

## Motivation

Scene Sync は一時的な遊び場・制作空間として使う。

そのため、体験そのものは ephemeral でも、記録や配信として残したいケースがある。

用途:

- VJ / MV 的な演出
- 共同制作の記録
- LBE / MR 制作現場の共有
- AI 操作デモ
- SNS 投稿用の短い映像

---

## Streaming strategy

最初は自前 streaming server を作らず、既存サービスとの連携を優先する。

候補:

- Twitch
- YouTube Live
- Discord screen share
- OBS
- browser screen capture

Scene Sync 側は、配信向け camera / presentation mode を整える方が効果が大きい。

---

## Recording

最初は画面録画でよい。

将来的な候補:

- browser `MediaRecorder`
- canvas capture stream
- WebRTC WHIP / WHEP
- mediamtx 連携

---

## Camera work

配信・録画で重要なのは camera work。

必要そうな機能:

- focus object
- orbit camera
- path camera
- saved camera pose
- AI / external tool から camera 操作
- smooth transition

---

## Audio

演出用途では音楽が必要になる。

扱い方:

- URL-based audio load
- local audio file load
- GLB carrier に含める案
- 再生同期
- 権利処理は共有者 / 配信者側の責任

---

## Related docs

- [Scene Sync Spec Index](./scene-sync-spec.md)
- [Animation](./scene-sync-animation.md)
- [Web UI / UX](./scene-sync-web-ux.md)
