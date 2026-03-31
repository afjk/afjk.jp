import Link from "next/link";
import { profile } from "@/data/profile";

export function ContactSection() {
  return (
    <section id="contact">
      <div className="contact-card">
        <p className="eyebrow">Contact</p>
        <h2>{profile.contact.headline}</h2>
        <p className="muted">{profile.contact.description}</p>
        <div className="cta-row" style={{ justifyContent: "center" }}>
          {profile.contact.buttons.map((cta) => (
            <Link
              key={cta.href}
              className={`btn ${cta.type === "primary" ? "primary" : "ghost"}`}
              href={cta.href}
              target="_blank"
            >
              {cta.label}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
