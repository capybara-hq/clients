// Local pages over the runtime document (I4). The runtime document (index.html) never navigates:
// leaving it would drop the registry, `serveCalls` and the loader, and every profile's gated call
// would go unanswered. A local page (the error state, the address page) is framed over it instead,
// one at a time.
//
// The channel is a MessageChannel per framed document: when the frame has loaded, the runtime
// posts it one port (`local-port`) on the local origin, and from then on both sides talk only
// over that port. Only the frame the runtime created ever holds it, so no message needs its
// `source` checked (WebKit reports the parent itself as the source of a frame's postMessage made
// from a user-gesture handler, which made source checks drop real clicks). A hidden frame's port
// is closed. The DOM is injected, so vitest needs none.
// The page's side is src/runtime/local-channel.ts.

export type LocalPage = "error" | "address";

/** The message that hands a framed document its port. */
export const LOCAL_PORT_MESSAGE = "local-port";

export interface FrameHandle {
  /** Posts to the frame's window, on the local origin only, transferring `transfer`. */
  post(message: unknown, transfer: MessagePort[]): void;
  /** Calls `listener` each time the frame has loaded a document. */
  onLoad(listener: () => void): void;
  remove(): void;
}

export interface LocalFrames {
  /** Shows `page` (keeping its frame when it already shows), replacing any other page. */
  show(page: LocalPage, src: string): void;
  hide(): void;
  current(): LocalPage | null;
  /** Posts to the page shown now, over its port (dropped before the page has its port). */
  post(message: unknown): void;
}

export function createLocalFrames(deps: {
  create(src: string): FrameHandle;
  /** A message from the page shown now, over its port. */
  onMessage(page: LocalPage, data: unknown): void;
}): LocalFrames {
  let shown: { page: LocalPage; frame: FrameHandle; port: MessagePort | null } | null = null;
  const hide = () => {
    shown?.port?.close();
    shown?.frame.remove();
    shown = null;
  };
  return {
    show(page, src) {
      if (shown?.page === page) return;
      hide();
      const frame = deps.create(src);
      const entry: { page: LocalPage; frame: FrameHandle; port: MessagePort | null } = {
        page,
        frame,
        port: null,
      };
      shown = entry;
      frame.onLoad(() => {
        if (shown !== entry) return;
        // A reloaded document gets a fresh port; the old one is closed.
        entry.port?.close();
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
          if (shown === entry) deps.onMessage(page, event.data);
        };
        entry.port = channel.port1;
        frame.post({ type: LOCAL_PORT_MESSAGE }, [channel.port2]);
      });
    },
    hide,
    current: () => shown?.page ?? null,
    post(message) {
      shown?.port?.postMessage(message);
    },
  };
}
