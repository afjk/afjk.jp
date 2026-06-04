import { createStudioActions } from './studio-actions.js';

const STYLE_ID = 'scene-sync-studio-shell-style';
const BODY_CLASS = 'scene-sync-shell-studio';

async function ensureStylesheet() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./studio-shell.css', import.meta.url).href;
  document.head.appendChild(link);
}

// 細い line アイコン（24x24, currentColor, stroke）。やわらかモダン基調。
const ICON = {
  edit: '<path d="M16.5 3.8a2 2 0 0 1 2.8 2.8L7.5 18.4 3.5 19.5l1.1-4Z"/>',
  play: '<path d="M7 4.5 18.5 12 7 19.5Z" stroke-linejoin="round"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/>',
  rotate: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.2v4.2h-4.2"/>',
  scale: '<path d="M14 4h6v6"/><path d="M10 20H4v-6"/><path d="M20 4l-7 7"/><path d="M4 20l7-7"/>',
  duplicate: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5V4.5A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>',
  trash: '<path d="M3.5 6h17"/><path d="M8.5 6V4.5A1.5 1.5 0 0 1 10 3h4a1.5 1.5 0 0 1 1.5 1.5V6"/><path d="M18.5 6 17.6 19a1.5 1.5 0 0 1-1.5 1.4H7.9A1.5 1.5 0 0 1 6.4 19L5.5 6"/>',
  close: '<path d="M17 7 7 17M7 7l10 10"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-2"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  link: '<path d="M9.5 14.5 14.5 9.5"/><path d="M10.5 6.8 12 5.3a4 4 0 0 1 5.7 5.7l-1.5 1.5"/><path d="M13.5 17.2 12 18.7a4 4 0 0 1-5.7-5.7l1.5-1.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.4 2.4 0 1 1 3.3 2.2c-.8.4-1.1 1-1.1 1.8"/><path d="M12 16.5h.01"/>',
};

function icon(name, size = 22) {
  return `<svg class="studio-ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ''}</svg>`;
}

// 英語ラベル・やわらかモダン・ダークニュートラルガラスのライト層向け Edit シェル。
// core.commands / getEditorState のみで構築（scene 内部に依存しない）。
export function createSceneSyncShell({ id = 'studio', requestedId = 'studio', availableShellIds = [] } = {}) {
  let root = null;
  let actions = null;
  let removeStateListener = null;
  let menuOpen = false;
  let onDocPointerDown = null;
  let onDocKeyDown = null;

  function getState(core) {
    return core?.getEditorState?.() ?? {};
  }

  function render(core) {
    if (!root) return;
    const s = getState(core);
    const selected = (s.selectedCount || 0) > 0;
    const mode = s.inputRoutingMode === 'interact' ? 'interact' : 'edit';

    root.querySelectorAll('[data-studio-mode]').forEach((btn) => {
      btn.dataset.active = String(btn.dataset.studioMode === mode);
    });

    const undoBtn = root.querySelector('[data-studio-undo]');
    const redoBtn = root.querySelector('[data-studio-redo]');
    if (undoBtn) undoBtn.disabled = !s.canUndo;
    if (redoBtn) redoBtn.disabled = !s.canRedo;

    const hint = root.querySelector('[data-studio-hint]');
    if (hint) hint.dataset.show = String((s.objectCount || 0) === 0);

    const card = root.querySelector('[data-studio-card]');
    if (card) card.dataset.show = String(selected);
    if (selected) {
      const nameEl = card.querySelector('[data-studio-card-name]');
      if (nameEl) {
        nameEl.textContent = s.selectedCount > 1
          ? `${s.selectedCount} selected`
          : (s.selectionLabel || 'Object');
      }
      const tm = s.transformMode || 'translate';
      card.querySelectorAll('[data-studio-tool]').forEach((btn) => {
        btn.dataset.active = String(btn.dataset.studioTool === tm);
      });
      const dupBtn = card.querySelector('[data-studio-duplicate]');
      if (dupBtn) dupBtn.disabled = s.selectedCount !== 1;
    }
  }

  function setMenuOpen(next) {
    menuOpen = next;
    const menu = root?.querySelector('[data-studio-menu]');
    const menuBtn = root?.querySelector('[data-studio-menu-btn]');
    if (menu) menu.dataset.open = String(menuOpen);
    if (menuBtn) menuBtn.dataset.active = String(menuOpen);

    // root は pointer-events:none のため canvas クリックが届かない。
    // メニュー open 中だけ document に外側クリック / Escape を張る。
    if (menuOpen) {
      if (!onDocPointerDown) {
        onDocPointerDown = (e) => {
          if (e.target.closest('[data-studio-menu]') || e.target.closest('[data-studio-menu-btn]')) return;
          setMenuOpen(false);
        };
        onDocKeyDown = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
        // 開いたクリックのイベント列を拾って即閉じしないよう、登録は次ティックへ遅延。
        // capture phase で canvas が止めても確実に届くようにする。
        setTimeout(() => {
          if (!onDocPointerDown) return;
          document.addEventListener('pointerdown', onDocPointerDown, true);
          document.addEventListener('keydown', onDocKeyDown, true);
        }, 0);
      }
    } else if (onDocPointerDown) {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
      onDocPointerDown = null;
      onDocKeyDown = null;
    }
  }

  function bind(core) {
    const on = (sel, handler, type = 'click') => {
      root.querySelectorAll(sel).forEach((el) => el.addEventListener(type, handler));
    };

    on('[data-studio-mode]', (e) => actions.setInputRoutingMode(e.currentTarget.dataset.studioMode));
    on('[data-studio-add]', () => actions.add());
    on('[data-studio-undo]', () => actions.undo());
    on('[data-studio-redo]', () => actions.redo());
    on('[data-studio-tool]', (e) => actions.setTransformMode(e.currentTarget.dataset.studioTool));
    on('[data-studio-duplicate]', () => actions.duplicate());
    on('[data-studio-delete]', () => actions.remove());
    on('[data-studio-deselect]', () => actions.deselect());
    on('[data-studio-details]', () => { actions.openInspector(); setMenuOpen(false); });
    on('[data-studio-menu-btn]', () => setMenuOpen(!menuOpen));
    on('[data-studio-export]', () => { actions.exportScene(); setMenuOpen(false); });
    on('[data-studio-help]', () => { actions.openHelp(); setMenuOpen(false); });
    on('[data-studio-ai]', () => { actions.startAiLink(); setMenuOpen(false); });
  }

  return {
    id,
    requestedId,
    name: 'Studio Shell',
    kind: 'editor',
    layouts: ['desktop', 'mobile'],
    inputs: ['pointer', 'touch', 'keyboard'],

    async mount({ core } = {}) {
      await ensureStylesheet();

      document.body.dataset.sceneSyncShell = 'studio';
      document.body.classList.add(BODY_CLASS);
      document.body.classList.remove('scene-sync-shell-editor', 'scene-sync-shell-minimal', 'scene-sync-shell-player');

      actions = createStudioActions(core);

      root = document.createElement('div');
      root.className = 'studio-shell';
      root.setAttribute('aria-label', 'Scene Sync Studio');
      root.innerHTML = `
        <div class="studio-mode-pill" role="group" aria-label="Mode">
          <button class="studio-mode-seg" data-studio-mode="edit" data-active="true" type="button">
            ${icon('edit', 16)}<span>Edit</span>
          </button>
          <button class="studio-mode-seg" data-studio-mode="interact" data-active="false" type="button">
            ${icon('play', 16)}<span>Play</span>
          </button>
        </div>

        <div class="studio-card" data-studio-card data-show="false" role="group" aria-label="Selection">
          <div class="studio-card-head">
            <span class="studio-card-name" data-studio-card-name>Object</span>
            <button class="studio-icon-btn studio-card-x" data-studio-deselect type="button" title="Deselect" aria-label="Deselect">${icon('close', 18)}</button>
          </div>
          <div class="studio-tools">
            <button class="studio-tool" data-studio-tool="translate" data-active="true" type="button">
              ${icon('move', 20)}<span>Move</span>
            </button>
            <button class="studio-tool" data-studio-tool="rotate" data-active="false" type="button">
              ${icon('rotate', 20)}<span>Rotate</span>
            </button>
            <button class="studio-tool" data-studio-tool="scale" data-active="false" type="button">
              ${icon('scale', 20)}<span>Scale</span>
            </button>
          </div>
          <div class="studio-card-actions">
            <button class="studio-chip" data-studio-duplicate type="button">${icon('duplicate', 16)}<span>Duplicate</span></button>
            <button class="studio-chip studio-chip-danger" data-studio-delete type="button">${icon('trash', 16)}<span>Delete</span></button>
            <button class="studio-chip studio-chip-ghost" data-studio-details type="button"><span>Details</span>${icon('chevron', 14)}</button>
          </div>
        </div>

        <div class="studio-dock">
          <button class="studio-icon-btn studio-dock-btn" data-studio-undo type="button" title="Undo" aria-label="Undo">${icon('undo', 20)}</button>
          <div class="studio-add-wrap">
            <div class="studio-hint" data-studio-hint data-show="true">Tap + to add</div>
            <button class="studio-add" data-studio-add type="button" aria-label="Add">${icon('plus', 26)}</button>
          </div>
          <button class="studio-icon-btn studio-dock-btn" data-studio-redo type="button" title="Redo" aria-label="Redo">${icon('redo', 20)}</button>
          <div class="studio-menu-wrap">
            <button class="studio-icon-btn studio-dock-btn" data-studio-menu-btn type="button" title="Menu" aria-label="Menu">${icon('more', 20)}</button>
            <div class="studio-menu" data-studio-menu data-open="false" role="menu">
              <button class="studio-menu-item" data-studio-details type="button">${icon('sliders', 18)}<span>Properties</span></button>
              <button class="studio-menu-item" data-studio-export type="button">${icon('download', 18)}<span>Export</span></button>
              <button class="studio-menu-item" data-studio-ai type="button">${icon('link', 18)}<span>AI Link</span></button>
              <button class="studio-menu-item" data-studio-help type="button">${icon('help', 18)}<span>Help</span></button>
            </div>
          </div>
        </div>
      `;

      bind(core);
      document.body.appendChild(root);
      removeStateListener = core?.onStateChange?.(() => render(core)) ?? null;
      render(core);

      if (core?.debug) {
        console.debug('[SceneSyncShell] mounted studio shell', { requestedId, availableShellIds });
      }
    },

    unmount() {
      setMenuOpen(false); // document リスナを確実に解除
      removeStateListener?.();
      removeStateListener = null;
      root?.remove();
      root = null;
      actions = null;
      document.body.classList.remove(BODY_CLASS);
      delete document.body.dataset.sceneSyncShell;
    },
  };
}

export default createSceneSyncShell;
