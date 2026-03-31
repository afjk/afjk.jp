import { fallbackTweets, TweetEmbed } from "@/data/twitter";

const TWITTER_USERNAME = process.env.TWITTER_USERNAME ?? "afjk01";
const NITTER_HOST = (process.env.NITTER_HOST ?? "https://nitter.net").replace(/\/+$/, "");
const TWEET_COUNT = Number(process.env.TWITTER_EMBED_COUNT ?? 3);
const TWITTER_EMBED_REVALIDATE = Number(process.env.TWITTER_EMBED_REVALIDATE ?? 600);

async function fetchTweetUrlsFromNitter(): Promise<string[] | null> {
  try {
    const rssUrl = `${NITTER_HOST}/${TWITTER_USERNAME}/rss`;
    const res = await fetch(rssUrl, {
      next: { revalidate: TWITTER_EMBED_REVALIDATE }
    });
    if (!res.ok) {
      console.warn("Nitter RSS error", res.status);
      return null;
    }
    const xml = await res.text();
    const matches = [...xml.matchAll(/<link>(https:\/\/nitter\.net\/[^<]+)<\/link>/g)].map(
      (m) => m[1]
    );
    if (!matches.length) {
      return null;
    }
    const tweetLinks = matches
      .filter((link) => link.includes("/status/"))
      .slice(0, TWEET_COUNT)
      .map((link) => link.replace("https://nitter.net", "https://twitter.com"));
    return tweetLinks.length ? tweetLinks : null;
  } catch (error) {
    console.warn("fetchTweetUrlsFromNitter error", error);
    return null;
  }
}

async function fetchOEmbedHtml(tweetUrl: string): Promise<string | null> {
  const url = new URL("https://publish.twitter.com/oembed");
  url.searchParams.set("url", tweetUrl);
  url.searchParams.set("omit_script", "1");
  url.searchParams.set("theme", "dark");
  url.searchParams.set("align", "center");

  const res = await fetch(url, { next: { revalidate: TWITTER_EMBED_REVALIDATE } });
  if (!res.ok) {
    console.warn("Twitter oEmbed error", await res.text());
    return null;
  }
  const data = await res.json();
  return typeof data.html === "string" ? data.html : null;
}

export async function getTweetEmbeds(): Promise<TweetEmbed[]> {
  try {
    const tweetUrls = await fetchTweetUrlsFromNitter();
    if (!tweetUrls || tweetUrls.length === 0) {
      return fallbackTweets;
    }

    const htmls = await Promise.all(tweetUrls.map((url) => fetchOEmbedHtml(url)));
    const embeds: TweetEmbed[] = [];
    htmls.forEach((html, index) => {
      if (!html) return;
      const url = tweetUrls[index];
      const id = url.split("/").pop()?.split("?")[0] ?? `tweet-${index}`;
      embeds.push({
        id,
        url,
        html
      });
    });
    return embeds.length ? embeds : fallbackTweets;
  } catch (error) {
    console.error("getTweetEmbeds error", error);
    return fallbackTweets;
  }
}
