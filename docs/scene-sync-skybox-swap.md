# Web の360背景切替

Web の背景画像選択は、新しい背景の GLB とテクスチャを読み込み終えるまで直前の背景を表示する。成功した時点で新背景の表示と旧背景の削除を行う。読み込みに失敗した場合は直前の背景を残し、失敗を通知する。

- ファイルの変換・アップロード前に切替要求を識別する。後から選んだ画像を優先し、古い処理の完了による上書きを防ぐ。新しい要求が失敗しても、取り消した古い要求は再開しない。
- シーンクリア、退出、再接続、背景削除は未完了の切替を取り消す。
- 既存の `scene-batch`（背景の `scene-remove` と `scene-add`）を受信するクライアントも同じ手順で読み込む。Undo/Redo の背景切替も対象。通信形式と Presence サーバーは変更しない。
- クライアントごとの読み込み完了時に切り替える。表示フレームの同時切替、スライドショー、Unity/Godot/Unreal の描画処理は対象外。
- 新背景は strict load で読み込むため、キャッシュの代替表示や読み込み失敗時の仮オブジェクトには切り替わらない。

## 検証

```sh
npm run test:skybox-swap
WEB_PORT=19210 PRESENCE_PORT=19211 AFJK_DEV_DATA_DIR=/tmp/afjk-skybox-dev npm run dev:web
AFJK_WEB_ORIGIN=http://127.0.0.1:19210 AFJK_PRESENCE_URL=ws://127.0.0.1:19211 npm run test:e2e:skybox-swap
```

ブラウザテストは localhost 限定。Chromium のサンドボックスと TLS 検証を維持し、2つの独立したブラウザコンテキストを使う。テスト用2:1画像を生成して実際のファイル選択を行い、ローカルの画像ダウンロードだけを遅延・失敗させる。結果とスクリーンショットの出力先は `AFJK_SKYBOX_OUTPUT`（既定 `logs/skybox-swap-browser-smoke`）。モバイル表示のエミュレーションは実機 Safari / HMD の検証を代替しない。
