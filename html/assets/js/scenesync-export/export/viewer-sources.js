function stripSourceMappingUrl(source) {
  return String(source).replace(/\r?\n?\/\/# sourceMappingURL=.*(?:\r?\n)?$/u, '\n');
}

export const VIEWER_SOURCES = [
  { src: '/assets/js/scenesync-export/viewer/static-viewer-entry.js', dest: 'viewer/viewer.js' },
  { src: '/assets/js/scenesync-export/viewer/create-viewer-core.js', dest: 'viewer/create-viewer-core.js', transform: (source) => source.replaceAll('../../scenesync/', '../scenesync/') },
  { src: '/assets/js/scenesync-export/viewer/export-behavior-runtime.js', dest: 'viewer/export-behavior-runtime.js' },
  { src: '/assets/js/scenesync-export/viewer/object-audio-controller.js', dest: 'viewer/object-audio-controller.js' },
  { src: '/assets/js/scenesync-export/viewer/static-asset-resolver.js', dest: 'viewer/static-asset-resolver.js' },
  { src: '/assets/js/scenesync-export/viewer/scene-document.js', dest: 'viewer/scene-document.js' },
  { src: '/assets/js/scenesync-export/viewer/viewer-scene-clock.js', dest: 'viewer/viewer-scene-clock.js' },
  { src: '/assets/js/scenesync/shells/player/player-transport.js', dest: 'viewer/player-transport.js' },
  { src: '/assets/js/scenesync/shells/player/player-actions.js', dest: 'viewer/player-actions.js' },
  { src: '/assets/js/scenesync/shells/player/player-shell.css', dest: 'viewer/player-shell.css' },
  { src: '/assets/js/scenesync/scene-physics.js', dest: 'viewer/scene-physics.js', transform: (source) => source.replaceAll('./runtime/runtime-events.js', '../scenesync/runtime/runtime-events.js').replaceAll('./runtime/event-timeline.js', '../scenesync/runtime/event-timeline.js') },
  { src: '/assets/js/scenesync/physics/index.js', dest: 'viewer/physics/index.js' },
  { src: '/assets/js/scenesync/physics/rapier-world.js', dest: 'viewer/physics/rapier-world.js' },
  { src: '/assets/js/scenesync/plugins/scene-sync-physics-plugin.js', dest: 'scenesync/plugins/scene-sync-physics-plugin.js' },
  { src: '/assets/js/scenesync/plugins/scene-sync-loomlet-plugin.js', dest: 'scenesync/plugins/scene-sync-loomlet-plugin.js' },
  { src: '/assets/js/scenesync/runtime/schedule-context.js', dest: 'scenesync/runtime/schedule-context.js' },
  { src: '/assets/js/scenesync/runtime/runtime-events.js', dest: 'scenesync/runtime/runtime-events.js' },
  { src: '/assets/js/scenesync/runtime/event-timeline.js', dest: 'scenesync/runtime/event-timeline.js' },
  { src: '/assets/js/scenesync-export/viewer/viewer.css', dest: 'viewer/viewer.css' },
  { src: '/assets/js/scenesync/handoff/protocol.js', dest: 'scenesync/handoff/protocol.js' },
  { src: '/assets/js/scenesync/handoff/source.js', dest: 'scenesync/handoff/source.js' },
  { src: '/assets/js/scenesync/handoff/source.css', dest: 'scenesync/handoff/source.css' },
  { src: '/assets/js/scenesync/utils/room-code.js', dest: 'scenesync/utils/room-code.js' },
  { src: '/assets/vendor/rapier-deterministic/0.19.3/rapier.mjs', dest: 'viewer/rapier/rapier.js', transform: stripSourceMappingUrl },
  { src: '/assets/vendor/rapier-deterministic/0.19.3/rapier_wasm3d_bg.wasm', dest: 'viewer/rapier/rapier_wasm3d_bg.wasm', binary: true },
  { src: '/assets/vendor/loomlet/0.3.0/loomlet-scenesync-runtime.browser.js', dest: 'viewer/loomlet/loomlet-scenesync-runtime.browser.js' },
];

export const SINGLE_HTML_HANDOFF_SOURCES = [
  { src: '/assets/js/scenesync/handoff/protocol.js', dest: 'scenesync/handoff/protocol.js' },
  { src: '/assets/js/scenesync/handoff/source.js', dest: 'scenesync/handoff/source.js' },
  { src: '/assets/js/scenesync/handoff/source.css', dest: 'scenesync/handoff/source.css' },
  { src: '/assets/js/scenesync/utils/room-code.js', dest: 'scenesync/utils/room-code.js' },
];

export async function fetchExportViewerSources(sources = VIEWER_SOURCES) {
  const results = {};
  const failures = [];
  await Promise.all(sources.map(async ({ src, dest, binary = false, transform = null }) => {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = binary ? await res.arrayBuffer() : await res.text();
      results[dest] = typeof transform === 'function' ? transform(content) : content;
    } catch (error) {
      failures.push({ src, dest, error: error.message });
    }
  }));
  return { results, failures };
}
