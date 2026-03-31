import Link from "next/link";
import { profile } from "@/data/profile";

export function HeroSection() {
  return (
    <section className="hero">
      <div className="hero-grid" aria-hidden="true" />
      <div className="hero-content">
        <p className="eyebrow">{profile.role}</p>
        <h1 className="hero-title">
          {profile.heroHeading.lead}
          <em>{profile.heroHeading.accent}</em>
          {profile.heroHeading.tail}
        </h1>
        <p className="hero-desc">{profile.heroDescription}</p>
        <div className="cta-row">
          {profile.ctas.map((cta) => (
            <Link
              key={cta.href}
              href={cta.href}
              className={`btn ${cta.type === "primary" ? "primary" : "ghost"}`}
            >
              {cta.label}
            </Link>
          ))}
        </div>

        <div className="platforms">
          <span>販売・公開先 →</span>
          {profile.platforms.map((platform) => (
            <Link key={platform.url} href={platform.url} className="ext-link" target="_blank">
              {platform.label}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
