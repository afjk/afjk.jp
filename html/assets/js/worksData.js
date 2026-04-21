export const WORKS = [
  {
    id: 'avp-antisleep',
    type: 'product',
    typeLabel: 'Product',
    title: {
      ja: 'Apple Vision Pro アンチスリープキャップ',
      en: 'Apple Vision Pro Anti-Sleep Cap'
    },
    desc: {
      ja: '着脱時の自動スリープを防止。高精度3Dスキャンデータをもとに設計し、IPD変動に追従。ライトシール有無・メガネ着用を問わず対応。',
      en: 'Prevents auto-sleep on removal. Designed from high-precision 3D scan data, follows IPD changes. Compatible with/without Light Seal and glasses.'
    },
    stat: '',
    links: [
      { label: 'BOOTH', url: 'https://afjk.booth.pm/' },
      { label: 'Etsy',  url: 'https://www.etsy.com/jp/shop/AFJKLab' },
      { label: 'MakerWorld', url: 'https://makerworld.com/ja/@afjk01/upload' },
    ]
  },
  {
    id: 'avp-zeiss',
    type: 'product',
    typeLabel: 'Product',
    title: {
      ja: 'Apple Vision Pro ZEISSインサート用ミニマルケース',
      en: 'Minimal Case for Apple Vision Pro ZEISS Inserts'
    },
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
    id: 'mr-templates',
    type: 'oss',
    typeLabel: 'OSS',
    title: {
      ja: 'MR Unity Templates',
      en: 'MR Unity Templates'
    },
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
    id: 'mazemaker',
    type: 'oss',
    typeLabel: 'OSS',
    title: { ja: 'MazeMaker', en: 'MazeMaker' },
    desc: {
      ja: 'Unity 向け迷路自動生成ライブラリ。様々なアルゴリズムで迷路を生成できる。',
      en: 'Automatic maze generation library for Unity. Supports various generation algorithms.'
    },
    stat: '★ 20',
    links: [
      { label: 'GitHub', url: 'https://github.com/afjk/MazeMaker' },
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
    id: 'pipe',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'afjk File Transfer', en: 'afjk File Transfer' },
    desc: {
      ja: 'ブラウザだけで完結するファイル転送ツール。同じネットワークにいる相手はタップ一つで送信開始。URLを共有すれば遠くの相手にも送れます。クラウド不要。',
      en: 'A browser-based file transfer tool. Tap a nearby device to send instantly, or share a URL to reach anyone. No cloud, no install.'
    },
    stat: '',
    links: [
      { label: 'Open', url: '/pipe/' },
    ]
  },
  {
    id: 'scenesync',
    type: 'tool',
    typeLabel: 'Tool',
    title: { ja: 'Scene Sync', en: 'Scene Sync' },
    desc: {
      ja: 'ブラウザと Unity の間で 3D シーンをリアルタイム共有。ルームに参加して glB をドロップするだけで、全員の画面に同じオブジェクトが現れ、移動・回転・スケールが同期します。',
      en: 'Real-time 3D scene sharing between browsers and Unity. Join a room, drop a glB, and everyone sees the same objects synced for move/rotate/scale.'
    },
    stat: '',
    links: [
      { label: 'Open', url: '/scenesync/' },
      { label: 'Unity Package', url: 'https://github.com/afjk/afjk.jp/tree/main/unity/com.afjk.scene-sync' },
    ]
  },
];
