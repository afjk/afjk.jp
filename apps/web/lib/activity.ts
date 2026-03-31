export type ActivityEvent = {
  id: string;
  source: "twitter" | "github" | "blog" | "session";
  title: string;
  url?: string;
  timestamp: string;
  meta?: string;
};

const demoActivity: ActivityEvent[] = [
  {
    id: "tweet-1",
    source: "twitter",
    title: "Vision Pro 用モジュラーアタッチメントのV2を試作しました。",
    url: "https://twitter.com/afjk01",
    timestamp: new Date().toISOString(),
    meta: "Thread ・ 発信中"
  },
  {
    id: "gh-1",
    source: "github",
    title: "afjk/homelab を更新 (Grafana Agent を追加)。",
    url: "https://github.com/afjk",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString()
  },
  {
    id: "blog-1",
    source: "blog",
    title: "STYLY CTO としての 2024Q1 のふりかえりを公開。",
    url: "https://note.com/afjk",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    meta: "Reading time: 6 min"
  }
];

export async function getRecentActivity(): Promise<ActivityEvent[]> {
  // API 統合まではダミーデータを返す。後続タスクで Worker + Prisma を接続。
  return demoActivity;
}
