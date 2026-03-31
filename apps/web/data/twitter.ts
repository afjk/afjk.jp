export type TweetEmbed = {
  id: string;
  html: string;
  url: string;
  createdAt?: string;
};

// fallback HTML copied from publish.twitter.com output (script stripped)
export const fallbackTweets: TweetEmbed[] = [
  {
    id: "1762807340000000000",
    url: "https://twitter.com/afjk01/status/1762807340000000000",
    createdAt: "2024-02-29T09:00:00+09:00",
    html: `<blockquote class="twitter-tweet"><p lang="ja" dir="ltr">Vision Pro 向けアンチスリープキャップ V2 をテスト中。精度を上げた3Dスキャンのおかげで調整箇所が減った。<br><br>・ライトシールあり/なし両対応<br>・メガネ可<br>・装着時の圧を抑えても確実にセンサーブロック</p>&mdash; afjk｜XR Engineer (@afjk01) <a href="https://twitter.com/afjk01/status/1762807340000000000">February 29, 2024</a></blockquote>`
  },
  {
    id: "1759001200000000000",
    url: "https://twitter.com/afjk01/status/1759001200000000000",
    createdAt: "2024-02-20T12:00:00+09:00",
    html: `<blockquote class="twitter-tweet"><p lang="ja" dir="ltr">Unity + OpenXR で Quest / Vision Pro 間の共通テンプレートを仕立て直した。<br>・XR Interaction Toolkit 2.5<br>・Meta XR SDK 1.2<br>・VisionOS Plugin 1.1<br><br>手元のプロジェクトから共通コンポーネントを抜き出して整理中。</p>&mdash; afjk｜XR Engineer (@afjk01) <a href="https://twitter.com/afjk01/status/1759001200000000000">February 20, 2024</a></blockquote>`
  },
  {
    id: "1754505550000000000",
    url: "https://twitter.com/afjk01/status/1754505550000000000",
    createdAt: "2024-02-08T21:30:00+09:00",
    html: `<blockquote class="twitter-tweet"><p lang="ja" dir="ltr">AFJK Lab で作った Vision Pro アクセサリを Etsy に公開しました。海外発送の手続きがようやく整ったので徐々に追加します⚒️</p>&mdash; afjk｜XR Engineer (@afjk01) <a href="https://twitter.com/afjk01/status/1754505550000000000">February 8, 2024</a></blockquote>`
  }
];
