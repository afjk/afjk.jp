import { ActivityFeed } from "@/components/activity-feed";
import { HeroSection } from "@/components/hero-section";
import { WorksSection } from "@/components/works-section";
import { SkillsSection } from "@/components/skills-section";
import { ContactSection } from "@/components/contact-section";
import { TwitterSection } from "@/components/twitter-section";
import { getRecentActivity } from "@/lib/activity";

export default async function Home() {
  const activity = await getRecentActivity();

  return (
    <main className="page-stack">
      <HeroSection />

      <section className="grid" style={{ gap: "1rem" }}>
        <header>
          <p className="eyebrow">Activity Stream</p>
          <h2>最新の動き</h2>
          <p className="muted">
            実際には Worker + Prisma でストリームを構築予定。現在は UI
            プレビューとしてダミーデータを表示しています。
          </p>
        </header>
        <ActivityFeed events={activity} />
      </section>

      <WorksSection />
      <TwitterSection />
      <SkillsSection />
      <ContactSection />
    </main>
  );
}
