export type PlatformLink = {
  label: string;
  url: string;
};

export const profile = {
  name: "Akihiro Fujii",
  handle: "@afjk01",
  role: "XRエンジニア / STYLY CTO",
  heroHeading: {
    lead: "XR体験と、",
    accent: "モノ",
    tail: "を作っています。"
  },
  heroDescription:
    "UnityでXR/MR体験を開発し、Apple Vision Pro向け周辺機器を設計・販売。コードと3Dプリンターで、アイデアを動くものにしています。",
  ctas: [
    { label: "Worksを見る", href: "#works", type: "primary" as const },
    { label: "@afjk01", href: "https://x.com/afjk01", type: "ghost" as const }
  ],
  platforms: [
    { label: "BOOTH", url: "https://afjk.booth.pm/" },
    { label: "Etsy", url: "https://www.etsy.com/jp/shop/AFJKLab" },
    { label: "MakerWorld", url: "https://makerworld.com/ja/@afjk01/upload" },
    { label: "GitHub", url: "https://github.com/afjk" }
  ],
  contact: {
    headline: "Let's talk",
    description: "最新のXRプロジェクトやプロトタイピング相談など、お気軽にどうぞ。",
    buttons: [
      {
        label: "DM on X (@afjk01)",
        href: "https://x.com/afjk01",
        type: "primary" as const
      }
    ]
  }
};
