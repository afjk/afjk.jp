export type WorkType = "product" | "oss" | "tool" | "prototype";

export type WorkLink = { label: string; url: string };

export type Work = {
  id: string;
  type: WorkType;
  typeLabel: string;
  title: string;
  description: string;
  stat?: string | null;
  links: WorkLink[];
};

export const works: Work[] = [
  {
    id: "avp-antisleep",
    type: "product",
    typeLabel: "Product",
    title: "Apple Vision Pro アンチスリープキャップ",
    description:
      "着脱時の自動スリープを防止。高精度3DスキャンデータをもとにIPD変動に追従し、ライトシール有無・メガネ着用を問わず対応。",
    links: [
      { label: "BOOTH", url: "https://afjk.booth.pm/" },
      { label: "Etsy", url: "https://www.etsy.com/jp/shop/AFJKLab" },
      { label: "MakerWorld", url: "https://makerworld.com/ja/@afjk01/upload" }
    ]
  },
  {
    id: "avp-zeiss",
    type: "product",
    typeLabel: "Product",
    title: "Apple Vision Pro ZEISSインサート用ミニマルケース",
    description:
      "ZEISSインサートを保護・収納するコンパクトなケース。必要最小限の形状で、持ち運びを快適に。",
    links: [{ label: "MakerWorld", url: "https://makerworld.com/ja/@afjk01/upload" }]
  },
  {
    id: "mr-templates",
    type: "oss",
    typeLabel: "OSS",
    title: "MR Unity Templates",
    description:
      "PICO4 / Meta Quest / Apple Vision Pro / XREAL / VIVE といった主要 XR プラットフォーム向け Unity MR テンプレート集。",
    links: [{ label: "GitHub", url: "https://github.com/afjk/MR-Unity-Template" }]
  },
  {
    id: "mazemaker",
    type: "oss",
    typeLabel: "OSS",
    title: "MazeMaker",
    description:
      "Unity 向けの迷路自動生成ライブラリ。様々なアルゴリズムで迷路を生成でき、ゲームや展示向けに活用。",
    stat: "★ 20",
    links: [{ label: "GitHub", url: "https://github.com/afjk/MazeMaker" }]
  },
  {
    id: "tinyhttpserver",
    type: "tool",
    typeLabel: "Tool",
    title: "TinyHttpServerForUnity",
    description:
      "Unity ランタイム上で動作する軽量 HTTP サーバー。デバッグや外部サービス連携のトンネルとして使用可能。",
    links: [{ label: "GitHub", url: "https://github.com/afjk/TinyHttpServerForUnity" }]
  },
  {
    id: "adb-wifi-installer",
    type: "tool",
    typeLabel: "Tool",
    title: "ADB WiFi Installer",
    description:
      "WiFi 経由で Android デバイスに APK を配信できる Tauri v2 製デスクトップアプリ。ネットワーク上のデバイスを検出しドラッグ＆ドロップで転送。",
    links: [{ label: "GitHub", url: "https://github.com/afjk/adb-wifi-installer" }]
  }
];
