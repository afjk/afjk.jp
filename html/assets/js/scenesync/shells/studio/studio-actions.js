// Studio Shell の command ラッパ（core.commands への薄い委譲、editor-actions.js に倣う）。
export function createStudioActions(core) {
  return {
    add() {
      core?.commands?.openAddMenu?.();
    },
    undo() {
      core?.commands?.undo?.();
    },
    redo() {
      core?.commands?.redo?.();
    },
    setTransformMode(mode) {
      core?.commands?.setTransformMode?.(mode);
    },
    duplicate() {
      core?.commands?.duplicateSelected?.();
    },
    remove() {
      core?.commands?.deleteSelected?.();
    },
    deselect() {
      core?.commands?.deselect?.();
    },
    focusSelected() {
      return core?.commands?.focusSelected?.();
    },
    setInputRoutingMode(mode) {
      core?.commands?.setInputRoutingMode?.(mode);
    },
    openInspector() {
      core?.commands?.openSceneInspector?.();
    },
    exportScene() {
      core?.commands?.exportScene?.();
    },
    openHelp() {
      core?.commands?.openHelp?.();
    },
    startAiLink() {
      core?.commands?.startAiLink?.();
    },
  };
}

export default createStudioActions;
