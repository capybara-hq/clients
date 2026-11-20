// Local pages over the runtime document (I4). The runtime document (index.html) never navigates:
// leaving it would drop the registry, `serveCalls` and the loader, and every profile's gated call
// would go unanswered. A local page (the error state, the address page) is framed over it instead,
// one at a time, and talks to it with postMessage on the local origin; a message counts only when
// its source is the frame shown now. The DOM is injected, so vitest needs none.

export type LocalPage = "error" | "address";

export interface FrameHandle {
  /** The frame's content window: the `source` its messages carry. */
  window: unknown;
  post(message: unknown): void;
  remove(): void;
}

export interface LocalFrames {
  /** Shows `page` (keeping its frame when it already shows), replacing any other page. */
  show(page: LocalPage, src: string): void;
  hide(): void;
  current(): LocalPage | null;
  /** Posts to the page shown now. */
  post(message: unknown): void;
  /** The page a message came from, or null when its source is not the frame shown now. */
  sourceOf(source: unknown): LocalPage | null;
}

export function createLocalFrames(deps: { create(src: string): FrameHandle }): LocalFrames {
  let shown: { page: LocalPage; frame: FrameHandle } | null = null;
  const hide = () => {
    shown?.frame.remove();
    shown = null;
  };
  return {
    show(page, src) {
      if (shown?.page === page) return;
      hide();
      shown = { page, frame: deps.create(src) };
    },
    hide,
    current: () => shown?.page ?? null,
    post(message) {
      shown?.frame.post(message);
    },
    sourceOf(source) {
      return shown && source !== null && source === shown.frame.window ? shown.page : null;
    },
  };
}
