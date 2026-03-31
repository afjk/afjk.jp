import Link from "next/link";
import { works } from "@/data/works";

export function WorksSection() {
  return (
    <section id="works">
      <header className="section-header">
        <p className="eyebrow">Works</p>
        <h2>作品 / プロジェクト</h2>
        <p className="muted">ハードウェアの試作から Unity / Next.js のソフトウェアまで。</p>
      </header>

      <div className="works-grid">
        {works.map((work) => (
          <article key={work.id} className={`work-card work-${work.type}`}>
            <div className="work-type">{work.typeLabel}</div>
            <h3>{work.title}</h3>
            <p>{work.description}</p>
            {work.stat && <span className="work-stat">{work.stat}</span>}
            <div className="work-links">
              {work.links.map((link) => (
                <Link key={link.url} href={link.url} target="_blank">
                  {link.label}
                </Link>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
