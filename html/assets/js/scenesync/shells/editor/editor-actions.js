export function createEditorActions(core) {
  return {
    openAddMenu() {
      core?.commands?.openAddMenu?.();
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
    undo() {
      core?.commands?.undo?.();
    },
    redo() {
      core?.commands?.redo?.();
    },
    deleteSelected() {
      core?.commands?.deleteSelected?.();
    },
    focusSelected() {
      return core?.commands?.focusSelected?.();
    },
    openSceneInspector() {
      core?.commands?.openSceneInspector?.();
    },
    closeSceneInspector() {
      core?.commands?.closeSceneInspector?.();
    },
    toggleSceneInspector() {
      core?.commands?.toggleSceneInspector?.();
    },
    setTransformMode(mode) {
      core?.commands?.setTransformMode?.(mode);
    },
    duplicateSelected() {
      core?.commands?.duplicateSelected?.();
    },
    deselect() {
      core?.commands?.deselect?.();
    },
  };
}

export default createEditorActions;
