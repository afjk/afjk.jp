export class WorksSection {
  constructor({ gridSelector, data }) {
    this.grid = document.querySelector(gridSelector);
    this.data = data;
  }

  render(lang = 'ja') {
    if (!this.grid) return;
    this.grid.innerHTML = this.data.map(work => this.renderCard(work, lang)).join('');
  }

  renderCard(work, lang) {
    const links = (work.links || []).map(link => (
      `<a href="${link.url}" target="_blank" rel="noopener" class="ext-link">
        ${link.label}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 10L10 2M10 2H4M10 2v6"/></svg>
      </a>`
    )).join('');

    const stat = work.stat ? `<p class="work-stat">${work.stat}</p>` : '';

    return `
      <article class="work-card">
        <div class="work-card-top">
          <span class="tag ${work.type}">${work.typeLabel}</span>
        </div>
        <h3>${work.title[lang]}</h3>
        <p>${work.desc[lang]}</p>
        ${stat}
        <div class="work-links">${links}</div>
      </article>
    `.trim();
  }
}
