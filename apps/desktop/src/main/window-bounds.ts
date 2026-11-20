// The main window's rectangle: where it opens and how it is remembered (spec §6.9).

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  workArea: Rect;
  primary?: boolean;
}

export const DEFAULT_SIZE = { width: 1280, height: 800 } as const;
/** The saved rectangle must overlap a work area by at least this much in both directions. */
export const MIN_VISIBLE = 100;

function overlap(a: Rect, b: Rect): { w: number; h: number } {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w, h };
}

/** The saved rectangle when it is still visible, else 1280×800 centered on the primary display. */
export function initialBounds(saved: Rect | undefined, displays: DisplayInfo[]): Rect {
  if (
    saved &&
    displays.some((d) => {
      const o = overlap(saved, d.workArea);
      return o.w >= MIN_VISIBLE && o.h >= MIN_VISIBLE;
    })
  ) {
    return { ...saved };
  }
  const primary = displays.find((d) => d.primary) ?? displays[0];
  const area = primary?.workArea ?? { x: 0, y: 0, ...DEFAULT_SIZE };
  const width = Math.min(DEFAULT_SIZE.width, area.width);
  const height = Math.min(DEFAULT_SIZE.height, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

export interface TrackedWindow {
  getBounds(): Rect;
  isMaximized?(): boolean;
  isMinimized?(): boolean;
  isFullScreen?(): boolean;
  on(event: "resize" | "move" | "close", listener: () => void): unknown;
}

export interface BoundsScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const BOUNDS_DEBOUNCE_MS = 300;

/** Saves the window's rectangle on resize / move (debounced) and on close. */
export function trackBounds(
  win: TrackedWindow,
  save: (bounds: Rect) => void,
  scheduler: BoundsScheduler = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): void {
  let handle: unknown;
  let pending = false;
  const flush = () => {
    if (handle !== undefined) scheduler.clear(handle);
    handle = undefined;
    pending = false;
    // A maximized, minimized or full-screen rectangle is not the one to restore.
    if (win.isMaximized?.() || win.isMinimized?.() || win.isFullScreen?.()) return;
    save(win.getBounds());
  };
  const schedule = () => {
    if (handle !== undefined) scheduler.clear(handle);
    pending = true;
    handle = scheduler.set(flush, BOUNDS_DEBOUNCE_MS);
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("close", () => {
    // Save on close even without a pending change, so the final rectangle is always kept.
    if (pending || handle === undefined) flush();
  });
}
