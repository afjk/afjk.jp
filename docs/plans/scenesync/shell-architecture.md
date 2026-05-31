# Scene Sync Shell Architecture

## 目的

Scene Sync の UI を、固定された 3D editor ではなく、用途ごとに差し替えられる Shell として設計する。

Scene Sync Core は、Scene 状態、同期、履歴、Export、AI / MCP API を提供する。Shell はその上に乗る用途別の操作レイヤーであり、同じ Scene をまったく異なる UI、入力、カメラ、HUD、設定パネルで操作できるようにする。

この設計の目的は、Scene Sync を重い統合ツールにせず、用途ごとの軽量な空間アプリとして発展させやすくすることにある。

## Shell とは

Shell とは、Scene Sync Core の上に乗る、用途別の操作環境である。

Shell は次の要素をまとめて定義する。

- UI layout
- input mapping
- camera behavior
- selection behavior
- HUD
- available tools
- settings panels
- shortcuts / commands

Shell は見た目の theme や panel 表示切替だけではない。操作方法そのものを切り替える単位である。

OS における desktop shell や terminal shell のように、同じ Core に対して複数の操作入口を持てるようにする。

## 基本構造

```text
Scene Sync Core
  - scene state
  - object model
  - sync
  - history
  - export
  - AI / MCP API

Command API
  - Core を操作する共通命令

Shell
  - 用途ごとの操作環境
  - UI layout / input / camera / HUD / tools / panels を定義

Panel Registry
  - object type / feature / shell に応じた個別設定 UI

Interaction Mode
  - Shell 内の入力・カメラ・選択・操作体系
```

Shell は Core を直接変更するのではなく、共通の Command API を通じて Scene を操作する。

これにより、Editor Shell、Viewer Shell、Game Shell、VJ Shell などが、同じ Scene と同じ Core を共有しながら、まったく異なる操作体験を提供できる。

## 想定する Shell

### Editor Shell

通常の編集用 Shell。

- object の追加・移動・削除
- transform 編集
- media / GLB / text / audio / particle の追加
- detailed inspector
- AI / MCP 操作との併用

### Viewer Shell

鑑賞・展示用 Shell。

- editing UI は最小化または非表示
- WebXR 開始
- navigation
- description 表示
- audio control
- focus / reset view

### Game Shell

FPS / third-person game 的な操作 Shell。

- first-person / third-person camera
- WASD / gamepad / pointer interaction
- crosshair / reticle
- interact prompt
- 近づく、触る、話す、叩くなどの体験操作

### VJ Shell

演出をライブ操作する Shell。

- effect bank
- particle trigger
- color / intensity sliders
- audio reactive controls
- camera cuts
- BPM / beat sync
- video / audio / particle の即時切替

### Rhythm Shell

音ゲー UI 的な Shell。

- beat grid
- timing lanes
- notes / cues
- animation / audio / particle のタイミング制御
- combo / score 的な HUD は必要に応じて追加

### Character Shell

VRM / MMD / character 表現向け Shell。

- expression
- pose
- animation
- audio / voice
- look at
- interaction behavior
- aura / particle effect

### AI Shell

AI 操作を前提にした Shell。

- natural language input
- major parameter controls
- preset selection
- command history
- suggested actions
- AI が扱いやすい semantic controls

## Panel / 個別設定

Panel は、選択中の object や feature を調整するための UI である。

Shell と Panel は分けて考える。

```text
Shell
= その空間をどう操作するか

Panel
= 選択中の対象をどう調整するか
```

Panel は固定 Inspector ではなく、object type、component、current shell に応じて差し替え可能にする。

例:

- Transform Panel
- Material Panel
- Audio Panel
- Animation Panel
- Particle Effect Panel
- Character Panel
- Loomlet Behavior Panel
- Export Panel

同じ object type でも Shell によって表示する Panel や詳細度を変える。

例: ParticleEffect

```text
Editor Shell:
  emitter / motion / rendering などの詳細設定を表示する

VJ Shell:
  intensity / color / trigger / beat sync を中心に表示する

Viewer Shell:
  基本的に設定 UI は表示しない

AI Shell:
  自然言語入力と主要パラメータを中心に表示する
```

## Interaction Mode

Interaction Mode は、Shell の中での入力・カメラ・選択・操作体系を表す。

Shell は UI 全体のまとまりであり、Interaction Mode はその中の操作規則である。

例:

- orbit edit
- first person
- third person
- fixed stage camera
- VJ pad control
- beat lane input
- AI assisted command input

Shell は複数の Interaction Mode を持ってもよい。

## Command API

Shell は共通の Command API を通じて Core を操作する。

例:

```text
addObject
updateObject
deleteObject
selectObject
focusObject
addParticleEffect
triggerEffect
playAnimation
setExpression
playAudio
setCameraMode
exportScene
```

Command API を安定させることで、新しい Shell を追加しても Core や既存 Shell への影響を小さくできる。

AI / MCP も同じ Command API を使う。

## AI との関係

Shell 設計は AI 操作と相性が良い。

AI は Scene を直接操作するだけではなく、適切な Shell を選ぶ、Shell に応じた操作を提案する、Panel の主要パラメータを調整する、という役割を持てる。

例:

```text
この空間を VJ Shell にして
このキャラを third-person 操作できるようにして
音ゲーっぽい UI にして
展示用のシンプルな Viewer Shell にして
```

AI が扱うパラメータは、できるだけ semantic なものにする。

例:

```text
intensity
density
mood
colorTheme
area
motion
```

低レベルな実装パラメータは、Shell / Panel / runtime 側で展開する。

## Particle Effect との関係

Particle Effect は Shell / Panel 設計の良い例である。

Particle Effect 自体は Scene Object として扱う。

- Editor Shell では詳細な particle definition を編集する
- VJ Shell では preset trigger や intensity 操作を中心にする
- Character Shell では aura / reaction / hit effect として扱う
- AI Shell では sparkle / firefly / snow / dust などの semantic preset から操作する

Unity ParticleSystem の完全互換を目指すのではなく、Scene Sync Particle Effect への近似変換・semantic conversion として扱う。

## 非目標

- Scene Sync を重い統合 platform にしない
- すべての用途を単一の固定 UI に詰め込まない
- Unity Editor 互換や Unity ParticleSystem 完全互換を目指さない
- 外部 plugin system を最初から大きく作りすぎない

まずは内部設計として Shell / Panel / Command API の境界を整理し、必要になった段階で拡張境界を外部化する。

## 参考にする概念

- OS shell: 同じ Core に対して複数の操作入口を持つ
- Blender Workspace: 作業ごとの UI layout / editor 構成
- Unreal Editor Mode: mode ごとに tool set と操作体系が変わる
- TouchDesigner: operator / parameter / palette / realtime control
- Resolume / Ableton Live: performance UI、clip / deck / layer 的な即時操作

## 実装の進め方

最初から完全な plugin system にはしない。

まずは次の順で進める。

1. Core 操作用の Command API を整理する
2. UI を Shell / Panel / Interaction Mode の概念に分ける
3. 既存 UI を Editor Shell として位置づける
4. Viewer Shell / Character Shell / VJ Shell など、小さな内蔵 Shell を追加する
5. Panel Registry を導入し、object type / shell ごとに表示内容を切り替える
6. Export Viewer でも Shell を選べるようにする
7. AI / MCP が Shell と semantic controls を扱えるようにする

## まとめ

Scene Sync の UI は、固定された editor ではなく、Shell として設計する。

Shell は、Scene Sync Core の上に乗る用途別の操作環境であり、UI layout、input mapping、camera behavior、HUD、tools、settings panels をまとめて切り替える。

これにより、同じ Scene を Editor、Viewer、Game、VJ、Rhythm、Character、AI などのまったく異なる操作体験で扱えるようにする。
