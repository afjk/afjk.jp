# Scene Sync Safe Mode / Diagnostic Flags

このドキュメントは、Scene Sync の Safe Mode と診断用 URL フラグについてまとめます。

## Safe Mode

Safe Mode は、通常の方法で room を開けない場合の復旧用モードです。

大きな GLB モデルや、IndexedDB に保存された room snapshot の自動復元によってページが開けない場合に使用します。

Safe Mode では以下を行います。

- room snapshot の自動復元を無効にする
- GLB の自動ロードを無効にする
- GLB object を軽量な placeholder として表示する

これにより、重いモデルが原因でページが開けない場合でも、room に入り直して問題の object を選択・削除できます。

Safe Mode は room や model を削除しません。
また、GLB object を恒久的に placeholder に変換するものでもありません。
あくまで、そのページを軽い復旧モードで開くための URL フラグです。

### URL

```text
/scenesync/?safe=1
/scenesync/?room=your-room&safe=1
```

room URL がある場合は、既存の URL に `safe=1` を追加します。

例:

```text
/scenesync/?room=demo-room&safe=1
```

## 診断用 URL フラグ

以下は主に開発・調査用の URL フラグです。

| Flag | 内容 |
| --- | --- |
| `safe=1` | 復旧用モード。`noRestore=1` と `noGlbLoad=1` を有効にする。 |
| `noRestore=1` | IndexedDB に保存された room snapshot の自動復元を無効にする。 |
| `noGlbLoad=1` | GLB のロードを無効にし、軽量 placeholder として表示する。 |
| `noAssetCache=1` | IndexedDB asset cache の読み込み・書き込みを両方無効にする。 |
| `noAssetCacheRead=1` | IndexedDB asset cache からの読み込みを無効にする。 |
| `noAssetCacheWrite=1` | IndexedDB asset cache への書き込みを無効にする。 |
| `probe=1` | crash probe を有効にし、危険な処理フェーズを `localStorage` と console に記録する。 |

## Crash Probe

`probe=1` は、クラッシュやリロードが発生した場合に、直前にどの処理フェーズまで進んでいたかを確認するための診断フラグです。

例:

```text
/scenesync/?room=your-room&probe=1
```

有効化すると、GLB ロード、asset cache 読み込み・書き込み、scene attach などの前後で状態を記録します。

確認方法:

```js
localStorage.getItem('sceneSync.crashProbe')
```

console にも `[SceneSync crash-probe]` のログが出ます。

## 大きなモデルでページが開けない場合の確認手順

1. Safe Mode で room を開く。

```text
/scenesync/?room=your-room&safe=1
```

2. ページが開けたら、問題の大きな model object を削除する。

3. 原因を詳しく切り分けたい場合は、以下のフラグを個別に試す。

```text
noRestore=1
noGlbLoad=1
noAssetCache=1
probe=1
```

4. `probe=1` を使った場合は、console と以下を確認する。

```js
localStorage.getItem('sceneSync.crashProbe')
```

## 注意

Safe Mode は、Scene Sync の通常動作を恒久的に変更するものではありません。

- room は削除されません
- GLB asset は削除されません
- object は恒久的に placeholder へ変換されません
- 通常 URL で開き直せば、通常のロード処理に戻ります

Safe Mode は、重い scene や問題のある snapshot から復旧するための入口です。
