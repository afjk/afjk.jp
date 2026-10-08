export const WORKS = [
  {
    id: 'avp-antisleep',
    type: 'product',
    typeLabel: 'Product',
    title: { ja: 'Apple Vision Pro アンチスリープキャップ', en: 'Apple Vision Pro Anti-Sleep Cap' },
    desc: {
      ja: '着脱時の自動スリープを防止。高精度3Dスキャンデータをもとに設計し、IPD変動に追従。ライトシール有無・メガネ着用を問わず対応。',
      en: 'Prevents auto-sleep on removal. Designed from high-precision 3D scan data, follows IPD changes. Compatible with/without Light Seal and glasses.'
    },
    stat: '',
    links: [
      { label: 'BOOTH', url: 'https://afjk.booth.pm/' },
      { label: 'Etsy', url: 'https://www.etsy.com/jp/shop/AFJKLab' },
      { label: 'MakerWorld', url: 'https://makerworld.com/ja/@afjk01/upload' },
    ]
  },
  {
    id: 'avp-zeiss',
    type: 'product',
    typeLabel: 'Product',
    title: { ja: 'Apple Vision Pro ZEISSインサート用ミニマルケース', en: 'Minimal Case for Apple Vision Pro ZEISS Inserts' },
    desc: {
      ja: 'ZEISSインサートを保護・収納するコンパクトなケース。必要最小限の形状で、持ち運びを快適に。',
      en: 'Compact case to protect and store ZEISS inserts. Minimal design for comfortable portability.'
    },
    stat: '',
    links: [
      { label: 'MakerWorld', url: 'https://makerworld.com/ja/@afjk01/upload' },
    ]
  },
  {
    id: 'scenesync',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'Scene Sync', en: 'Scene Sync' },
    desc: {
      ja: 'ブラウザ・Unity・Godot の間で 3D シーンをリアルタイム共有。ルームに参加してモデルを追加し、位置・回転・スケールの編集を同期。Unity / Godot 向け XR クライアントも公開しています。',
      en: 'Share 3D scenes in real time across browsers, Unity, and Godot. Join a room, add models, and sync position, rotation, and scale edits. XR clients for Unity and Godot are also available.'
    },
    stat: '',
    links: [
      { label: 'Open', url: '/scenesync/' },
      { label: 'Unity Package', url: 'https://github.com/afjk/afjk.jp/tree/main/unity/com.afjk.scene-sync' },
      { label: 'Unity XR', url: 'https://github.com/afjk/Scene-Sync-Unity' },
      { label: 'Godot XR', url: 'https://github.com/afjk/Scene-Sync-Godot' },
    ]
  },
  {
    id: 'loomlet',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'Loomlet', en: 'Loomlet' },
    desc: {
      ja: 'インタラクティブなシーンのふるまいを記述する小さなリアクティブ DSL とノードグラフツール。Web ノードエディタ、CLI、VS Code 拡張を提供。実験段階のため仕様は変更されることがあります。',
      en: 'A small reactive DSL and node graph toolkit for interactive scenes, with a web node editor, CLI, and VS Code extension. Experimental: APIs and syntax may change.'
    },
    stat: '',
    links: [
      { label: 'Node Editor', url: 'https://afjk.github.io/loomlet/node-editor/' },
      { label: 'GitHub', url: 'https://github.com/afjk/loomlet' },
      { label: 'npm', url: 'https://www.npmjs.com/package/@afjk/loomlet' },
    ]
  },
  {
    id: 'sog-xr-viewer',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'Insta360 SOG XR Viewer', en: 'Insta360 SOG XR Viewer' },
    desc: {
      ja: '3D Gaussian Splat をブラウザと WebXR 対応ヘッドセットで見るビューア。ローカル SOG ファイルや公開キャプチャを読み込めます。Insta360 非公式プロジェクト。',
      en: 'View 3D Gaussian Splats in the browser and on WebXR headsets. Load local SOG files and supported public captures. An unofficial Insta360 project.'
    },
    stat: null,
    links: [
      { label: 'Open', url: 'https://afjk.github.io/insta360-sog-xr-viewer/' },
      { label: 'GitHub', url: 'https://github.com/afjk/insta360-sog-xr-viewer' },
    ]
  },
  {
    id: 'splat-spots',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'Splat Spots', en: 'Splat Spots' },
    desc: {
      ja: '有志が投稿した Insta360 Spatial Capture の公開リンクを集めたディレクトリ。空間を探して XR ビューアで開けます。キャプチャの自動収集・再配布は行わない非公式サイト。',
      en: 'A community-curated directory of publicly shared Insta360 Spatial Captures, linked to an XR viewer. Unofficial; no automatic capture discovery or capture rehosting.'
    },
    stat: null,
    links: [
      { label: 'Open', url: 'https://afjk.github.io/splat-spots/' },
      { label: 'GitHub', url: 'https://github.com/afjk/splat-spots' },
    ]
  },
  {
    id: 'rapier-unity',
    type: 'oss',
    typeLabel: 'OSS',
    title: { ja: 'Rapier for Unity', en: 'Rapier for Unity' },
    desc: {
      ja: 'Rapier 物理エンジンを Unity から扱うための C# API とコンポーネント。複数の物理ワールド、固定ステップ、スナップショットに対応。初期開発段階の非公式統合です。',
      en: 'C# APIs and components for using Rapier physics in Unity, with multiple worlds, fixed stepping, and snapshots. An unofficial integration in early development.'
    },
    stat: null,
    links: [
      { label: 'GitHub', url: 'https://github.com/afjk/rapier-unity' },
    ]
  },
  {
    id: 'mr-templates',
    type: 'oss',
    typeLabel: 'OSS',
    title: { ja: 'MR Unity Templates', en: 'MR Unity Templates' },
    desc: {
      ja: '主要 XR プラットフォーム向け Unity MR テンプレート集。PICO4 / Meta Quest / Apple Vision Pro / XREAL / VIVE に対応。',
      en: 'Unity MR template collection for major XR platforms. Supports PICO4, Meta Quest, Apple Vision Pro, XREAL, and VIVE.'
    },
    stat: null,
    links: [
      { label: 'GitHub', url: 'https://github.com/afjk/MR-Unity-Template' },
    ]
  },
  {
    id: 'mr-godot-samples',
    type: 'oss',
    typeLabel: 'OSS',
    title: { ja: 'MR Godot Samples', en: 'MR Godot Samples' },
    desc: {
      ja: 'Godot / OpenXR 向けの MR サンプル集。パススルー、ハンドトラッキング、掴み操作、UI などをテーマ別に収録。Meta Quest、PICO、VIVE、Android XR 向けの構成を用意。',
      en: 'Focused MR samples for Godot and OpenXR: passthrough, hand tracking, grabbing, UI, and more. Includes configurations for Meta Quest, PICO, VIVE, and Android XR.'
    },
    stat: null,
    links: [
      { label: 'GitHub', url: 'https://github.com/afjk/MR-Godot-Template' },
    ]
  },
  {
    id: 'owon-scope',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'OWON Scope', en: 'OWON Scope' },
    desc: {
      ja: 'OWON HDS25S の USB 波形取得・表示・記録を行うデスクトップアプリ。macOS / Apple Silicon で実機確認。メーカー非公式で、波形軸は未校正の raw 値です。',
      en: 'A desktop app for USB waveform capture, display, and recording with the OWON HDS25S. Hardware-tested on macOS / Apple Silicon. Unofficial; waveform axes use uncalibrated raw values.'
    },
    stat: null,
    links: [
      { label: 'GitHub', url: 'https://github.com/afjk/owon_hds25s' },
    ]
  },
  {
    id: 'koto-patch',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'KotoPatch', en: 'KotoPatch' },
    desc: {
      ja: 'Web ページの文章の一部を日本語・英語間で翻訳する Chrome 拡張。Chrome 内蔵 Translator API を既定とし、翻訳率の調整や原文の確認ができます。対応するデスクトップ版 Chrome が必要です。',
      en: 'A Chrome extension that translates a chosen proportion of page text between Japanese and English, with original-text lookup. Uses the built-in Translator API by default; requires a supported desktop Chrome.'
    },
    stat: null,
    links: [
      { label: 'GitHub', url: 'https://github.com/afjk/koto-patch' },
    ]
  },
  {
    id: 'pipe',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'afjk File Transfer', en: 'afjk File Transfer' },
    desc: {
      ja: 'ブラウザでファイル・テキストを転送し、カメラ映像や画面を共有。同じネットワークの端末や、ルーム URL でつながった相手へ送れます。WebRTC P2P と中継に対応。',
      en: 'Transfer files and text, or share a camera or screen, in the browser. Connect to nearby devices or share a room URL. Supports WebRTC P2P and relayed transfers.'
    },
    stat: '',
    links: [
      { label: 'Open', url: '/pipe/' },
    ]
  },
  {
    id: 'adb-wifi-installer',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'ADB WiFi Installer', en: 'ADB WiFi Installer' },
    desc: {
      ja: 'WiFi 経由で Android デバイスへ APK をインストールできるデスクトップアプリ。ネットワーク上のデバイスを自動検出し、ドラッグ＆ドロップで APK を転送・管理できる。Tauri v2（Rust + React）製。macOS / Windows 対応。',
      en: 'Desktop app for installing APKs to Android devices over WiFi. Auto-discovers devices on the network, drag & drop APK install, file explorer, Logcat viewer. Built with Tauri v2 (Rust + React). macOS / Windows.'
    },
    stat: '',
    links: [
      { label: 'GitHub', url: 'https://github.com/afjk/adb-wifi-installer' },
    ]
  },
  {
    id: 'tinyhttpserver',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'TinyHttpServerForUnity', en: 'TinyHttpServerForUnity' },
    desc: {
      ja: 'Unity ランタイム上で動作する軽量 HTTP サーバー。デバッグや外部連携に使える。',
      en: 'Lightweight HTTP server running in Unity runtime. Useful for debugging and external integrations.'
    },
    stat: null,
    links: [
      { label: 'GitHub', url: 'https://github.com/afjk/TinyHttpServerForUnity' },
    ]
  },
  {
    id: 'runtimelogger',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'UnityRuntimeLogger', en: 'UnityRuntimeLogger' },
    desc: {
      ja: 'Unity のログをランタイムで画面表示するツール。デバイス実機でのデバッグを効率化。',
      en: 'A tool to display Unity logs on-screen at runtime. Streamlines debugging on physical devices.'
    },
    stat: null,
    links: [
      { label: 'GitHub', url: 'https://github.com/afjk/UnityRuntimeLogger' },
    ]
  },
  {
    id: 'local-device-finder',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'Local Device Finder', en: 'Local Device Finder' },
    desc: {
      ja: 'UDP のブロードキャスト / マルチキャストで同一ネットワークの端末を検出する C# ライブラリ。Unity の Editor と Runtime で利用でき、応答内容をカスタマイズできます。',
      en: 'A C# library for device discovery over UDP broadcast or multicast on a local network. Works in Unity Editor and Runtime, with customizable responses.'
    },
    stat: null,
    links: [
      { label: 'GitHub', url: 'https://github.com/afjk/LocalDeviceFinder' },
    ]
  },
  {
    id: 'mazemaker',
    type: 'oss',
    typeLabel: 'OSS',
    title: { ja: 'MazeMaker', en: 'MazeMaker' },
    desc: {
      ja: '指定したオブジェクトの形状に沿って立体迷路を自動生成する Unity ツール。障害物を避けながら迷路を生成できます。',
      en: 'A Unity tool that generates 3D mazes inside a chosen object shape, routing around obstacles.'
    },
    stat: null,
    links: [
      { label: 'GitHub', url: 'https://github.com/afjk/MazeMaker' },
    ]
  },
];
