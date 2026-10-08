import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { WORKS } from './worksData.js';
import { WorksSection } from './worksSection.js';

test('works have unique ids, supported categories, and Japanese and English copy', () => {
  assert.equal(new Set(WORKS.map(work => work.id)).size, WORKS.length);
  for (const work of WORKS) {
    assert.match(work.id, /^[a-z0-9-]+$/);
    assert.ok(['product', 'tool', 'oss'].includes(work.type));
    for (const lang of ['ja', 'en']) {
      assert.ok(work.title[lang]?.trim(), `${work.id}: ${lang} title`);
      assert.ok(work.desc[lang]?.trim(), `${work.id}: ${lang} description`);
      assert.doesNotMatch(work.title[lang] + work.desc[lang], /[<>]/);
    }
  }
});

test('work links are HTTPS or existing local pages', () => {
  for (const work of WORKS) {
    assert.ok(work.links.length > 0);
    for (const link of work.links) {
      assert.ok(link.label.trim());
      assert.doesNotMatch(link.url, /[<>"']/);
      if (link.url.startsWith('/')) {
        assert.ok(existsSync(new URL(`../../${link.url.slice(1)}index.html`, import.meta.url)), link.url);
      } else {
        assert.equal(new URL(link.url).protocol, 'https:');
      }
    }
  }
});

test('curated additions link to their verified public repositories', () => {
  const repos = {
    'sog-xr-viewer': 'insta360-sog-xr-viewer',
    'splat-spots': 'splat-spots',
    'rapier-unity': 'rapier-unity',
    'mr-godot-samples': 'MR-Godot-Template',
    'owon-scope': 'owon_hds25s',
    'koto-patch': 'koto-patch',
    'local-device-finder': 'LocalDeviceFinder',
  };
  for (const [id, repo] of Object.entries(repos)) {
    const work = WORKS.find(item => item.id === id);
    assert.ok(work?.links.some(link => link.url === `https://github.com/afjk/${repo}`), id);
  }
});

test('render every card in either language without undefined copy or missing links', () => {
  const section = Object.create(WorksSection.prototype);
  section.data = WORKS;
  section.grid = { innerHTML: '' };
  // Repeated language changes must replace cards, never duplicate them.
  for (const lang of ['ja', 'en', 'ja', 'en']) {
    section.render(lang);
    assert.equal((section.grid.innerHTML.match(/<article /g) || []).length, WORKS.length);
    assert.doesNotMatch(section.grid.innerHTML, /undefined|NaN/);
    for (const work of WORKS) {
      assert.ok(section.grid.innerHTML.includes(work.title[lang]));
      assert.ok(section.grid.innerHTML.includes(work.desc[lang]));
      for (const link of work.links) {
        assert.ok(section.grid.innerHTML.includes(`href="${link.url}" target="_blank" rel="noopener"`));
      }
    }
  }
});

test('experimental and hardware limitations are present in both languages', () => {
  const find = id => WORKS.find(work => work.id === id);
  assert.match(find('loomlet').desc.ja, /実験段階/);
  assert.match(find('loomlet').desc.en, /Experimental/);
  assert.match(find('rapier-unity').desc.ja, /非公式/);
  assert.match(find('rapier-unity').desc.en, /unofficial/);
  assert.match(find('owon-scope').desc.ja, /未校正/);
  assert.match(find('owon-scope').desc.en, /uncalibrated/);
  assert.ok(!find('mazemaker').stat);
  assert.doesNotMatch(find('pipe').desc.en, /no cloud/i);
});

test('new focus areas remain visible in both language modes', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  for (const label of ['Godot', 'WebXR', '3D Gaussian Splatting', 'TypeScript', 'Rust / Tauri']) {
    assert.ok(html.includes(`<span class="skill-chip">${label}</span>`));
  }
});

test('selected posts use the four original URLs without invented excerpts or timeline claims', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const posts = html.match(/<section id="posts">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(posts);
  assert.match(posts, /ピックアップ/);
  assert.match(posts, /Selected posts/);
  assert.doesNotMatch(posts, /twitter-timeline|最近のポスト|Recent Posts/);
  const quotes = [...posts.matchAll(/<blockquote([^>]*)>([\s\S]*?)<\/blockquote>/g)];
  assert.equal(quotes.length, 4);
  const ids = ['1992045374941610023', '2025139388393685498', '1984967767293067764', '1973603383127974370'];
  quotes.forEach(([_, attributes, content], i) => {
    assert.match(attributes, /class="twitter-tweet"/);
    assert.match(attributes, /data-dnt="true"/);
    assert.ok(content.includes(`https://x.com/afjk01/status/${ids[i]}`));
    assert.doesNotMatch(content, /<p|<time/);
    assert.ok(posts.includes(`class="selected-post-link ext-link" href="https://x.com/afjk01/status/${ids[i]}"`));
  });
  assert.equal((html.match(/src="https:\/\/platform.twitter.com\/widgets.js"/g) || []).length, 1);
});

test('selected posts stay responsive and keep independent bilingual fallback links', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../css/main.css', import.meta.url), 'utf8');
  assert.ok(css.includes('minmax(min(300px, 100%), 1fr)'));
  assert.ok(css.includes('.selected-post { min-width: 0; }'));
  const fallback = html.match(/<div class="posts-more">([\s\S]*?)<\/div>/)?.[1];
  assert.match(fallback, /href="https:\/\/x.com\/afjk01"/);
  assert.match(fallback, /data-ja/);
  assert.match(fallback, /data-en/);
  assert.match(html, /自動更新ではありません/);
  assert.match(html, /not automatically updated/);
});
