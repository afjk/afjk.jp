# Scene Sync BGM

Scene Sync の BGM 機能について、現在の実装範囲と今後の予定を整理する。

Scene Sync は、保存場所ではなく一時的な共有空間として設計している。BGM もこの考え方に沿って、音声ファイルそのものを扱う機能ではなく、ルーム内の一時的なシーン状態として音声 URL を共有し、各クライアントがその URL から再生する機能として扱う。

## 現在の実装

現在の BGM 実装は、最小実装として次の範囲に限定している。

- 音声ファイル URL を drag & drop / paste で受け取る
- `.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac` などの直接音声 URL を `audio` として分類する
- 音声 URL を `scene-bgm` payload として共有する
- BGM はシーンに 1 つだけ存在する
- 新しい BGM を設定すると、既存の BGM は置き換えられる
- 各クライアントは BGM を受け取ったタイミングで先頭からローカル再生する
- BGM はデフォルトで loop 再生する
- ブラウザの autoplay 制限で再生できない場合は、ユーザー操作による有効化 UI を表示する
- 音声ファイル本体は fetch / upload / cache / mirror / backup しない

現在の payload 形状は次の通り。

```js
{
  kind: "scene-bgm",
  bgm: {
    version: 1,
    url: "https://example.com/bgm.mp3",
    name: "bgm.mp3",
    loop: true,
    volume: 1,
    playback: {
      mode: "local-loop"
    }
  }
}
```

BGM を消す場合は、次の payload を使う。

```js
{
  kind: "scene-bgm",
  bgm: null
}
```

## 現在実装しないこと

最小実装では、次の機能はあえて実装しない。

- サーバー時間による同期再生
- ホスト操作による「今から開始」制御
- pause / resume の同期
- 再生位置の同期
- Undo / Redo 対応
- オブジェクト単位の音声設定
- 3D 空間音響 / positional audio
- Loomlet からの BGM 操作
- glTF export / import への BGM 拡張
- 波形表示やプレイヤー UI
- 音声ファイルのアップロード

## UI 方針

BGM は、Skybox と同じくシーン全体に作用する環境要素として扱う。

ただし、UI は大きくしすぎない。通常のユーザーに見せる説明は、基本的には「音声ファイルの URL を入れると BGM として再生できる」程度に留める。

現時点で必要な UI は次の最小要素だけにする。

- 音声 URL の drag & drop / paste
- autoplay がブロックされた時だけ表示される「音声を有効化」ボタン
- BGM が設定されている時だけ表示される削除ボタン

BGM 削除ボタンは `scene-bgm` / `bgm: null` を broadcast して、各クライアントの BGM を停止・解除する。削除は Undo / Redo の対象にはまだしない。

## 同期の考え方

現在は、BGM の再生位置を同期しない。

各クライアントは、BGM 情報を受け取ったタイミングでローカルに先頭から loop 再生する。これは最小実装としての挙動であり、アニメーションや Loomlet と厳密に同期する用途にはまだ使わない。

将来的には、BGM とアニメーションを同じ時間軸に乗せるため、サーバー時間を基準にした Scene Clock を導入する。

将来の synced playback では、例えば次のような形を想定する。

```js
{
  kind: "scene-bgm",
  bgm: {
    version: 1,
    url: "https://example.com/bgm.mp3",
    name: "bgm.mp3",
    loop: true,
    volume: 1,
    playback: {
      mode: "synced",
      startTime: 1779000000.0,
      offset: 0
    }
  }
}
```

この場合、各クライアントは次のように再生位置を計算する。

```js
audioTime = offset + (hostNow - startTime)
```

ただし、ブラウザの autoplay 制限は引き続き存在するため、音が実際に鳴り始めるタイミングとシーン時間は分けて扱う。ユーザーが音声を有効化した時点で、現在のシーン時間に対応した位置から再生する。

## Loomlet との関係

BGM はまず scene-level resource として扱う。

将来的には Loomlet から次のような操作をできるようにしたい。

```loomlet
on Start => scene.bgm.play()
```

```loomlet
on KeyDown("Space") => scene.bgm.toggle()
```

```loomlet
volume = 0.5
scene.bgm.volume = volume
```

また、BGM とアニメーションを同期するために、Loomlet から `scene.time` や `scene.bgm.time` を参照できるようにする案がある。

最初は `scene.time` を Scene Clock の共通入力として扱い、BGM もアニメーションも同じ時間軸を見る形が自然。

## Object Audio との関係

BGM は scene-level audio として扱う。

一方で、将来の object-level audio は別物として扱う。

- BGM: シーン全体に 1 つだけ設定する背景音
- Object Audio: 特定のオブジェクトに付与する音声 component / extension

Object Audio は、`asset.type = audio` の独立オブジェクトというより、既存オブジェクトに付く component に近い。

これはアニメーション拡張に近い位置付けになる可能性が高い。

将来の payload 例:

```js
{
  kind: "scene-delta",
  objectId: "speaker-1",
  audio: {
    url: "https://example.com/se.mp3",
    mode: "positional",
    loop: true,
    volume: 1,
    playing: true
  }
}
```

ただし、object-level audio はまだ実装しない。

## glTF export / import

BGM の glTF export / import はまだ実装しない。

将来的には、Scene Sync 独自 extension として URL 参照のみを書き出す可能性がある。

音声バイナリは glTF に埋め込まない。

想定例:

```json
{
  "extensionsUsed": ["AFJK_audio"],
  "extensions": {
    "AFJK_audio": {
      "version": 1,
      "bgm": {
        "uri": "https://example.com/bgm.mp3",
        "mimeType": "audio/mpeg",
        "loop": true,
        "volume": 1
      }
    }
  }
}
```

対応していない viewer でも glTF 自体は読めるようにしたいため、基本的には `extensionsRequired` ではなく `extensionsUsed` に留める方針。

## 実装上の注意

- BGM は scene object ではない
- `scene-add` ではなく `scene-bgm` として扱う
- URL importer context には `applySceneBgm` と `broadcastSceneBgm` を含める
- `broadcastSceneAdd` へ fallback しない
- presence-server は `scene-bgm` の shape validation だけを行い、URL を取得・検査しない
- BGM の runtime state と serialized state を分ける
- `HTMLAudioElement` は serialize しない
- BGM なしは `null` で表現する

## 今後の優先順位

現時点の優先順位は次の通り。

1. BGM 削除 UI
2. Inspector / Dev JSON への BGM 表示
3. Undo / Redo 対応
4. サーバー時間同期 / Scene Clock
5. Loomlet からの BGM 操作
6. glTF export / import
7. Object Audio
8. Positional Audio
9. Audio Reactive / FFT / 波形解析

必要になるまで、同期や高度な再生制御は入れない。まずは「URLを落とすとBGMが鳴る」という軽い体験を保つ。
