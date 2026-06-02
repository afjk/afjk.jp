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
    openSceneInspector() {
      core?.commands?.openSceneInspector?.();
    },
    closeSceneInspector() {
      core?.commands?.closeSceneInspector?.();
    },
  };
}

export default createEditorActions;
