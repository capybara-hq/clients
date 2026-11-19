// What to redo after which change. A focus change only rebuilds the tray and the app menu; the
// Dock icon (a network fetch) is re-evaluated at start and when the profile set changes.
export interface UiRefreshDeps {
  /** Rebuilds the tray and the app menu from the current state. */
  render(): void;
  /** Re-evaluates the Dock icon for the current profiles. */
  updateDock(): Promise<void>;
  log?: (message: string, err?: unknown) => void;
}

export function createUiRefresh(deps: UiRefreshDeps) {
  return {
    /** The front profile or a setting changed (focus, tray click, start at login). */
    stateChanged(): void {
      deps.render();
    },
    /** Start, a profile was added or removed, or managed profiles were ensured. */
    profilesChanged(): void {
      deps.render();
      deps.updateDock().catch((err: unknown) => deps.log?.("could not update the Dock icon", err));
    },
  };
}
