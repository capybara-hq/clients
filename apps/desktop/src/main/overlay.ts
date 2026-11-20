// The main window's error overlay (desktop spec §6.8): a WebContentsView with the local page
// `main-error`, added on top of the window's own web contents and sized to the whole content area,
// so the deployment's page (and its sidebar) is covered while it shows. The window keeps its size;
// the view follows every resize. Removing it closes the view's web contents. The view's contents
// are registered as a local page of kind `main-error` (its actions only) while it lives.
//
// Electron objects come in as parameters.
import type { PageState } from "../shared/local-page.ts";
import { localPageUrl } from "../shared/protocol.ts";
import type { LocalContents, LocalPages } from "./local-pages.ts";
import type { Rect } from "./window-bounds.ts";

/** The view's web contents as the overlay drives it. */
export interface OverlayContents extends LocalContents {
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
  close(): void;
  focus(): void;
}

/** A WebContentsView. */
export interface OverlayView {
  webContents: OverlayContents;
  setBounds(rect: Rect): void;
  setBackgroundColor(color: string): void;
}

/** The main window the overlay covers. */
export interface OverlayParent {
  contentView: { addChildView(view: unknown): void; removeChildView(view: unknown): void };
  getContentSize(): number[];
  on(event: "resize", listener: () => void): unknown;
  removeListener(event: "resize", listener: () => void): unknown;
  isDestroyed(): boolean;
}

export interface OverlayDeps {
  /** `new WebContentsView({ webPreferences: localWebPreferences(...) })`. */
  createView(): OverlayView;
  localPages: Pick<LocalPages, "register" | "push">;
  /** The local pages' navigation rules (security.ts `hardenLocalContents`). */
  harden?(contents: OverlayContents): void;
  log?(message: string, err?: unknown): void;
}

export interface OverlayOptions {
  profileId: string;
  /** The page's state now (asked on every `state()` and push). */
  state(): PageState;
  /** The view's ground before the page paints. */
  background: string;
}

export interface Overlay {
  /** The view's web contents: `act` calls from it are this overlay's. */
  readonly contents: OverlayContents;
  /** Sends the page a fresh state. */
  push(): void;
  /** Takes the view off the window and closes it (once). */
  remove(): void;
  isRemoved(): boolean;
}

export function showOverlay(deps: OverlayDeps, parent: OverlayParent, o: OverlayOptions): Overlay {
  const log = (message: string, err?: unknown) => deps.log?.(message, err);
  const view = deps.createView();
  const contents = view.webContents;
  deps.harden?.(contents);
  const unregister = deps.localPages.register(contents, {
    kind: "main-error",
    profileId: o.profileId,
    state: o.state,
  });
  let removed = false;

  const fit = () => {
    if (removed || parent.isDestroyed()) return;
    const [width = 0, height = 0] = parent.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };

  try {
    view.setBackgroundColor(o.background);
  } catch (err) {
    log("could not color the error overlay", err);
  }
  fit();
  parent.contentView.addChildView(view);
  parent.on("resize", fit);
  contents
    .loadURL(localPageUrl("main-error"))
    .catch((err: unknown) => log("could not load the error overlay", err));
  contents.focus();

  return {
    contents,
    push() {
      if (removed) return;
      deps.localPages.push((entry) => entry.contents === contents);
    },
    remove() {
      if (removed) return;
      removed = true;
      unregister();
      try {
        parent.removeListener("resize", fit);
        if (!parent.isDestroyed()) parent.contentView.removeChildView(view);
      } catch (err) {
        // The window went away meanwhile: the view goes with it.
        log("could not detach the error overlay", err);
      }
      try {
        if (!contents.isDestroyed()) contents.close();
      } catch (err) {
        log("could not close the error overlay", err);
      }
    },
    isRemoved: () => removed,
  };
}
