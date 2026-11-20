// Deep links (spec §6.4, §6.5): the app registers its scheme, receives `capybara://` links through
// `open-url` (macOS; may fire before `ready`) or a second instance's arguments (Windows, Linux),
// and routes them. Links are untrusted input: unknown or malformed ones are ignored.
import { type AuthCallback, normalizeAddress, parseDeepLink } from "@capybara-hq/shell";
import type { Profile } from "./profiles.ts";

export interface DeepLinkHandlers {
  /** The app's own scheme (`brand.scheme`): links of any other scheme are ignored. */
  scheme: string;
  /** `capybara://auth/callback`: the sign-in module decides whether it matches an attempt. */
  onAuth(cb: AuthCallback): Promise<void>;
  /**
   * `capybara://connect?url=`: opens the connect page prefilled; never connects silently.
   * Without a handler the link does nothing.
   */
  onConnect?: (address: string) => void;
  /** `capybara://open?url=`: focuses the matching profile. Without one, nothing. */
  onOpen?: (url: string) => void;
  log?: (message: string, err?: unknown) => void;
}

export function createDeepLinkRouter(handlers: DeepLinkHandlers) {
  return {
    routeDeepLink(url: string): void {
      const link = parseDeepLink(url, handlers.scheme);
      if (!link) return;
      switch (link.kind) {
        case "auth":
          handlers.onAuth(link).catch((err: unknown) => {
            handlers.log?.("sign-in callback failed", err instanceof Error ? err.name : undefined);
          });
          return;
        case "connect":
          handlers.onConnect?.(link.address);
          return;
        case "open":
          handlers.onOpen?.(link.url);
          return;
      }
    },
  };
}

/** The connect field takes no more than this many characters. */
const MAX_LINK_ADDRESS = 2048;

export interface DeepLinkActions {
  /** The profiles this app offers now (under a managed lock: the managed ones). */
  profiles(): readonly Profile[];
  /** Managed `lockDeployments`: false for an address that is not on the managed list. */
  isAllowedAddress(address: string): boolean;
  /** Opens (or reuses) the small window's connect page with `prefill` in its field. */
  openConnect(prefill: string): void;
  /** Focuses a window of the profile and loads `url` there. */
  showProfile(profile: Profile, url: string): void;
}

/** The profile a page URL belongs to: the same origin exactly (the longest matching base wins). */
export function profileForUrl(
  profiles: readonly Profile[],
  url: string,
): { profile: Profile; url: string } | undefined {
  const address = normalizeAddress(url);
  if (!address.ok) return undefined;
  let target: URL;
  try {
    target = new URL(url.trim());
  } catch {
    return undefined;
  }
  const same = profiles.filter((p) => p.origin === address.origin);
  const path = target.pathname.replace(/\/+$/, "");
  const full = `${address.origin}${path}`;
  const within = same
    .filter((p) => full === p.base || full.startsWith(`${p.base}/`))
    .sort((a, b) => b.base.length - a.base.length);
  const profile = within[0] ?? same[0];
  return profile ? { profile, url: target.href } : undefined;
}

/** The `connect` and `open` handlers. Links are untrusted: nothing here saves or signs in. */
export function createDeepLinkHandlers(actions: DeepLinkActions) {
  return {
    /** Prefills the connect page and stops there: the person presses continue. */
    onConnect(address: string): void {
      if (address.length > MAX_LINK_ADDRESS || !actions.isAllowedAddress(address)) return;
      actions.openConnect(address);
    },
    /** Only for a profile that already exists, and only to a URL on its own origin. */
    onOpen(url: string): void {
      const match = profileForUrl(actions.profiles(), url);
      if (match) actions.showProfile(match.profile, match.url);
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
