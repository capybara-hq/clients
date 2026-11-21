// The framed local page's side of its channel to the runtime (src/runtime/local-frames.ts). The
// page accepts its port only from its parent on its own (the local) origin, then talks only over
// that port. What it sends before the port arrives waits and goes out in order.

export interface RuntimeLink {
  post(message: unknown): void;
  /** A `message` event of the page's window. */
  receive(event: {
    origin: string;
    source: unknown;
    data: unknown;
    ports: readonly MessagePort[];
  }): void;
}

export function createRuntimeLink(deps: {
  /** `window.parent`. */
  parent: unknown;
  /** The page's own origin (the local origin). */
  origin: string;
  onMessage(data: unknown): void;
}): RuntimeLink {
  let port: MessagePort | null = null;
  const queued: unknown[] = [];
  return {
    post(message) {
      if (port) port.postMessage(message);
      else queued.push(message);
    },
    receive(event) {
      if (event.origin !== deps.origin || event.source === null || event.source !== deps.parent) {
        return;
      }
      const data = event.data as { type?: unknown } | null;
      const given = event.ports[0];
      if (typeof data !== "object" || data === null || data.type !== "local-port" || !given) return;
      port?.close();
      port = given;
      port.onmessage = (e) => deps.onMessage(e.data);
      for (const message of queued.splice(0)) port.postMessage(message);
    },
  };
}
