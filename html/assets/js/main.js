import { WORKS } from './worksData.js';
import { WorksSection } from './worksSection.js';
import { LanguageToggle } from './languageToggle.js';
import { StatsFetcher } from './statsFetcher.js';

document.addEventListener('DOMContentLoaded', () => {
  const worksSection = new WorksSection({
    gridSelector: '#works-grid',
    data: WORKS,
  });

  const languageToggle = new LanguageToggle({
    buttonsSelector: '[data-lang-toggle]',
    onChange: lang => worksSection.render(lang),
  });

  // Ensure initial render even if LanguageToggle early exits
  worksSection.render(languageToggle.value);

  const stats = new StatsFetcher({
    endpoint: 'https://afjk.jp/presence/stats',
    selectors: {
      total: '#stat-total',
      p2p: '#stat-p2p',
      relay: '#stat-relay',
      torrent: '#stat-torrent',
      bytes: '#stat-bytes',
      stream: '#stat-stream',
    }
  });
  stats.run();
});
