import { getTweetEmbeds } from "@/lib/twitter";
import { TwitterEmbed } from "@/components/twitter-embed";

export async function TwitterSection() {
  const tweets = await getTweetEmbeds();

  return (
    <section id="posts">
      <header className="section-header">
        <p className="eyebrow">Twitter</p>
        <h2>最新ポスト</h2>
        <p className="muted">
          Nitter RSS → Twitter oEmbed で無料連携。失敗時は静的サンプルを表示します。
        </p>
      </header>
      <div className="tweets-grid">
        {tweets.map((tweet) => (
          <TwitterEmbed key={tweet.id} embed={tweet} />
        ))}
      </div>
    </section>
  );
}
