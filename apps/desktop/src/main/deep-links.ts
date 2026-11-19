// Deep links (spec §6.4, §6.5): the app registers its scheme, receives `capybara://` links through
// `open-url` (macOS; may fire before `ready`) or a second instance's arguments (Windows, Linux),
// and routes them. Links are untrusted input: unknown or malformed ones are ignored.
import { type AuthCallback, parseDeepLink } from "@capybara-hq/shell";

export interface DeepLinkHandlers {
  /** `capybara://auth/callback`: the sign-in module decides whether it matches an attempt. */
  onAuth(cb: AuthCallback): Promise<void>;
  /**
   * `capybara://connect?url=`: Task 15 opens the address page prefilled; never connects silently.
   * Without a handler the link does nothing.
   */
  onConnect?: (address: string) => void;
  /** `capybara://open?url=`: Task 15 focuses the matching profile. Without one, nothing. */
  onOpen?: (url: string) => void;
  log?: (message: string, err?: unknown) => void;
}

export function createDeepLinkRouter(handlers: DeepLinkHandlers) {
  return {
    routeDeepLink(url: string): void {
      const link = parseDeepLink(url);
      if (!link) return;
      switch (link.kind) {
        case "auth":
          handlers.onAuth(link).catch((err: unknown) => {
            handlers.log?.("sign-in callback failed", err instanceof Error ? err.name : undefined);
          });
          return;
        case "connect":
          // TODO(Task 15): the address page prefilled with `link.address`, confirmed by the person.
          handlers.onConnect?.(link.address);
          return;
        case "open":
          // TODO(Task 15): focus the profile whose origin matches and navigate there.
          handlers.onOpen?.(link.url);
          return;
      }
    },
  };
}

/** The first argument that is a link of `scheme` (how Windows and Linux pass it), if any. */
export function deepLinkFromArgv(argv: readonly string[], scheme: string): string | undefined {
  const prefix = `${scheme.toLowerCase()}:`;
  return argv.find((a) => a.toLowerCase().startsWith(prefix));
}

export interface DeepLinkApp {
  on(
    event: "open-url",
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): unknown;
  setAsDefaultProtocolClient(scheme: string, path?: string, args?: string[]): boolean;
}

export interface InstallDeepLinksOptions {
  scheme: string;
  /** `process.argv` of this launch. */
  argv: readonly string[];
  /** A development run (`process.defaultApp`): register the interpreter and the entry script. */
  defaultApp?: { execPath: string; args: string[] };
}

/** Links that arrive before `ready`; more than this many are dropped (nobody clicks that fast). */
const QUEUE_MAX = 16;

/**
 * Call before `ready`, so a macOS `open-url` that launched the app is not lost. Links wait until
 * `ready(route)`, then go out in order.
 */
export function installDeepLinks(app: DeepLinkApp, o: InstallDeepLinksOptions) {
  let route: ((url: string) => void) | undefined;
  const queue: string[] = [];
  const deliver = (url: string) => {
    if (route) route(url);
    else if (queue.length < QUEUE_MAX) queue.push(url);
  };

  if (o.defaultApp) {
    app.setAsDefaultProtocolClient(o.scheme, o.defaultApp.execPath, o.defaultApp.args);
  } else {
    app.setAsDefaultProtocolClient(o.scheme);
  }

  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliver(url);
  });

  const initial = deepLinkFromArgv(o.argv, o.scheme);
  if (initial) deliver(initial);

  return {
    ready(routeFn: (url: string) => void): void {
      route = routeFn;
      for (const url of queue.splice(0)) routeFn(url);
    },

    /** A second instance's arguments: true when they carried a link (routed), false otherwise. */
    fromSecondInstance(argv: readonly string[]): boolean {
      const link = deepLinkFromArgv(argv, o.scheme);
      if (!link) return false;
      deliver(link);
      return true;
    },
  };
}
