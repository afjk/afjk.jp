import { skillGroups } from "@/data/skills";

export function SkillsSection() {
  return (
    <section id="skills">
      <header className="section-header">
        <p className="eyebrow">Skills</p>
        <h2>関わってきた領域</h2>
      </header>
      <div className="skills-groups">
        {skillGroups.map((group) => (
          <div key={group.title} className="skill-group">
            <h3>{group.title}</h3>
            <div className="skill-tags">
              {group.items.map((item) => (
                <span key={item} className="skill-chip">
                  {item}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
