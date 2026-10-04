// Inspect rendered UI independently of the product's header selector list.
// Do not filter by hit-testing: that would omit elements already covered.
export function inspectNotificationGeometry({ selector = '#toast', label }) {
  const notice = document.querySelector(selector);
  const noticeRect = notice.getBoundingClientRect().toJSON();
  const interactive = 'button, summary, input, select, textarea, a[href], [role="button"], [tabindex]';
  const id = el => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
  const overlaps = [], headerOverlaps = [], blocked = [], coveredByOtherUi = [], surfaces = [], header = [];
  const transparent = value => value === 'transparent' || /^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(value);
  function visibleRect(el) {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
    const r = el.getBoundingClientRect().toJSON();
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (parent.matches('details:not([open])') && !el.closest('summary')) return null;
      const css = getComputedStyle(parent), p = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
        r.left = Math.max(r.left, p.left + parent.clientLeft);
        r.right = Math.min(r.right, p.left + parent.clientLeft + parent.clientWidth);
      }
      if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
        r.top = Math.max(r.top, p.top + parent.clientTop);
        r.bottom = Math.min(r.bottom, p.top + parent.clientTop + parent.clientHeight);
      }
    }
    r.left = Math.max(0, r.left); r.right = Math.min(innerWidth, r.right);
    r.top = Math.max(0, r.top); r.bottom = Math.min(innerHeight, r.bottom);
    return r.right > r.left && r.bottom > r.top ? r : null;
  }
  for (const el of document.body.querySelectorAll('*')) {
    if (!(el instanceof HTMLElement) || el.tagName === 'CANVAS'
      || notice.contains(el) || el.contains(notice)) continue;
    const r = visibleRect(el);
    if (!r) continue;
    const css = getComputedStyle(el), control = el.matches(interactive);
    const ownText = [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    const floating = css.position === 'fixed' || css.position === 'absolute';
    const painted = !transparent(css.backgroundColor) || css.boxShadow !== 'none'
      || (css.borderStyle !== 'none' && parseFloat(css.borderWidth) > 0 && !transparent(css.borderColor));
    // Scene roots and modal dimmers cover the viewport by design. Inspect
    // their text, controls and panels, not a full-screen noninteractive layer.
    const backdrop = !control && !ownText && r.left <= 0 && r.top <= 0
      && r.right >= innerWidth && r.bottom >= innerHeight;
    if (backdrop || !(control || ownText || floating || painted)) continue;
    const surface = { id: id(el), rect: r, role: el.getAttribute('role'), control,
      text: ownText ? el.textContent.trim().slice(0, 90) : '' };
    surfaces.push(surface);
    if ((control || ownText || painted) && r.bottom <= noticeRect.top) header.push({ el, surface });
    if (noticeRect.left < r.right && noticeRect.right > r.left
      && noticeRect.top < r.bottom && noticeRect.bottom > r.top) overlaps.push(surface.id);
    if (control && r.right - r.left >= 10 && r.bottom - r.top >= 10) {
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      if (!el.contains(hit)) {
        const item = { id: surface.id, coveredBy: hit ? id(hit) : null };
        (hit?.closest('#scene-notifications') ? blocked : coveredByOtherUi).push(item);
      }
    }
  }
  for (let i = 0; i < header.length; i++) for (let j = i + 1; j < header.length; j++) {
    const a = header[i], b = header[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const x = a.surface.rect, y = b.surface.rect;
    if (x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top) {
      headerOverlaps.push([a.surface.id, b.surface.id]);
    }
  }
  return { label, visible: notice.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    rect: noticeRect, overlaps, headerOverlaps, blocked, coveredByOtherUi, surfaces,
    viewport: { width: innerWidth, height: innerHeight } };
}
