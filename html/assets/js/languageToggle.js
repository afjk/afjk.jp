export class LanguageToggle {
  constructor({ buttonsSelector, defaultLang = 'ja', onChange } = {}) {
    this.buttons = typeof buttonsSelector === 'string'
      ? document.querySelectorAll(buttonsSelector)
      : buttonsSelector;
    this.buttons = Array.from(this.buttons || []);
    this.onChange = onChange;
    this.lang = this.resolveInitialLang(defaultLang);
    this.apply(this.lang);
    this.bind();
  }

  resolveInitialLang(defaultLang) {
    const saved = localStorage.getItem('lang');
    if (saved === 'ja' || saved === 'en') {
      return saved;
    }
    const browser = navigator.language && navigator.language.startsWith('ja') ? 'ja' : 'en';
    return browser || defaultLang;
  }

  bind() {
    this.buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        const lang = btn.dataset.lang;
        if (!lang || lang === this.lang) return;
        this.apply(lang);
      });
    });
  }

  apply(lang) {
    this.lang = lang;
    document.documentElement.lang = lang;
    localStorage.setItem('lang', lang);

    document.querySelectorAll('[data-ja]').forEach(el => {
      el.style.display = lang === 'ja' ? '' : 'none';
    });
    document.querySelectorAll('[data-en]').forEach(el => {
      el.style.display = lang === 'en' ? '' : 'none';
    });

    this.buttons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });

    if (typeof this.onChange === 'function') {
      this.onChange(lang);
    }
  }

  get value() {
    return this.lang;
  }
}
