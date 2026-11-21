// The launch splash (mobile spec §4.4, decision 3). The native splash (`@capacitor/splash-screen`,
// `launchAutoHide: false`) stays until the web's first paint: it drops on `chrome@1.ready()`, on
// the error state, or 3 s after the main-frame load finished (webs that never call `ready`).
// Hidden once; everything after that does nothing.

export interface Splash {
  /** `chrome@1.ready()` from the shown profile's document. */
  ready(): void;
  /** The main-frame load finished: start the fallback. */
  loaded(): void;
  /** The error state shows: drop the splash now. */
  failed(): void;
}

export const SPLASH_FALLBACK_MS = 3000;

export function createSplash(deps: {
  hide(): void;
  /** Runs `fn` after `ms`; returns how to cancel. */
  schedule(fn: () => void, ms: number): () => void;
}): Splash {
  let hidden = false;
  let cancel: (() => void) | undefined;
  const hide = () => {
    if (hidden) return;
    hidden = true;
    cancel?.();
    cancel = undefined;
    try {
      deps.hide();
    } catch {
      // The plugin is gone: nothing left to hide.
    }
  };
  return {
    ready: hide,
    failed: hide,
    loaded() {
      if (hidden || cancel) return;
      cancel = deps.schedule(hide, SPLASH_FALLBACK_MS);
    },
  };
}
