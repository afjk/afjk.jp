// One shared notification area below the shell's top controls. Both informational
// messages and actionable notices remain visible; no queue or priority guessing.
const HEADER_SURFACES = '#settings-panel, #peers-panel, #status, .studio-mode-pill, #scene-sync-shell-mode-switcher, #xr-toggle-btn, #xr-calibrate-btn';
let region = null;

export function getNotificationRegion() {
  if (region) return region;
  region = document.createElement('div');
  region.id = 'scene-notifications';
  region.hidden = true;
  document.body.append(region);
  let frame = null;
  const observed = new Set();
  const resize = new ResizeObserver(schedule);
  resize.observe(region);

  function update() {
    frame = null;
    const active = [...region.children].some(el => !el.hidden && (el.id !== 'toast' || el.classList.contains('show')));
    if (region.hidden === active) region.hidden = !active;
    if (document.body.classList.contains('scene-sync-notice-active') !== active) {
      document.body.classList.toggle('scene-sync-notice-active', active);
    }
    if (!active) {
      const changed = document.body.style.getPropertyValue('--scene-notice-bottom');
      document.body.style.removeProperty('--scene-notice-bottom');
      document.body.style.removeProperty('--scene-notice-menu-offset');
      if (changed) document.dispatchEvent(new Event('scene-sync-notice-layout'));
      return;
    }
    // Reserve the whole rendered header, including non-button status/peer text
    // and desktop settings rows. Observe hidden panels too so opening one fits.
    const surfaces = [...document.querySelectorAll(HEADER_SURFACES)];
    for (const el of observed) if (!surfaces.includes(el)) { resize.unobserve(el); observed.delete(el); }
    for (const el of surfaces) if (!observed.has(el)) { resize.observe(el); observed.add(el); }
    const controls = surfaces.filter(el => el.getClientRects().length
      && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]'));
    const viewport = window.visualViewport;
    const safeTop = parseFloat(getComputedStyle(document.body).getPropertyValue('--mobile-safe-top')) || 0;
    const top = Math.max((viewport?.offsetTop || 0) + 4 + safeTop, ...controls.map(el => el.getBoundingClientRect().bottom)) + 8;
    const bottom = top + region.getBoundingClientRect().height;
    const summary = document.querySelector('#editor-scene-menu summary')?.getBoundingClientRect();
    const values = [['--scene-notice-bottom', `${bottom}px`],
      ['--scene-notice-menu-offset', `${Math.max(0, bottom - (summary?.bottom || bottom))}px`]];
    if (region.style.top !== `${top}px`) region.style.top = `${top}px`;
    let changed = false;
    for (const [name, value] of values) if (document.body.style.getPropertyValue(name) !== value) {
      document.body.style.setProperty(name, value); changed = true;
    }
    if (changed) document.dispatchEvent(new Event('scene-sync-notice-layout'));
  }
  function schedule() { if (frame === null) frame = requestAnimationFrame(update); }
  // Only our messages and shell/header changes affect this area. Player clock
  // text and scene updates do not trigger geometry work every animation frame.
  new MutationObserver(schedule).observe(region, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  new MutationObserver(records => {
    if (records.some(r => r.type === 'childList' || r.attributeName === 'class')) schedule();
  }).observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  schedule();
  return region;
}
