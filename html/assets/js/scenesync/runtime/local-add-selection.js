// A completed local import must not take focus from a newer user action.
export function canSelectCompletedLocalAdd(start, current) {
  return start.enabled && current.enabled
    && start.selectionVersion === current.selectionVersion
    && current.loaded && !current.locked;
}
