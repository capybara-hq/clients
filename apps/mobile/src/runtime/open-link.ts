// `<scheme>://open?url=<page>` links (mobile spec §4.4, shell external authorization spec §3, §5):
// the browser's "back to the app" button after a connector OAuth or a login linking finished
// there. Native keeps the last `open` link of the brand's scheme it received (iOS: the scene's
// open URL contexts; Android: MainActivity's VIEW intents for the `open` host) and announces it
// with an `appUrlOpen` event of the `CapybaraHost` plugin; the runtime takes it with
// `takeAppUrl`, once when it starts listening (a link that launched the app) and on each event.
// Only the last link is kept: links that piled up before the runtime listened open one page.
// Links are untrusted input, as on the desktop (apps/desktop/src/main/deep-links.ts): a page
// loads only on a visible profile whose origin is exactly the link's (the longest matching base
// wins), and anything else (another kind of link, another scheme, a non-http(s) URL, an unknown
// origin) is ignored. Nothing here signs in, saves or adds a profile.
import { parseDeepLink } from "@capybara-hq/shell";

/** A link longer than this is ignored (the web's own links are far shorter). */
export const OPEN_LINK_MAX = 4096;

export interface OpenLinkDeps {
  /** The brand's URL scheme: links of any other scheme are ignored. */
  scheme: string;
  /** The profiles a link may open (the managed gate's visible list). */
  profiles(): readonly LinkProfile[];
  /** Makes the profile current and loads `origin + path` in it (native re-checks the path). */
  open(profileId: string, path: string): Promise<void>;
}

export interface LinkProfile {
  id: string;
  origin: string;
  /** Origin plus path prefix, no trailing slash. */
  base: string;
}

export interface OpenLinkRouter {
  route(link: string): Promise<void>;
}

/** The profile and in-app path an `open` link leads to; null when it leads nowhere. */
export function openLinkTarget(
  link: string,
  scheme: string,
  profiles: readonly LinkProfile[],
): { profileId: string; path: string } | null {
  if (link.length > OPEN_LINK_MAX) return null;
  const parsed = parseDeepLink(link, scheme);
  if (parsed?.kind !== "open") return null;
  let url: URL;
  try {
    url = new URL(parsed.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const profile = profileForUrl(profiles, url);
  if (!profile) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Native loads `origin + path`: a path that could read as another host is never handed over.
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  return { profileId: profile.id, path };
}

/** The same origin exactly; the longest base the path is within wins (the desktop's rule). */
function profileForUrl(profiles: readonly LinkProfile[], url: URL): LinkProfile | undefined {
  const same = profiles.filter((p) => p.origin === url.origin);
  const full = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  const within = same
    .filter((p) => full === p.base || full.startsWith(`${p.base}/`))
    .sort((a, b) => b.base.length - a.base.length);
  return within[0] ?? same[0];
}

export function createOpenLinkRouter(deps: OpenLinkDeps): OpenLinkRouter {
  return {
    async route(link) {
      const target = openLinkTarget(link, deps.scheme, deps.profiles());
      if (target) await deps.open(target.profileId, target.path);
    },
  };
}

/**
 * The plugin's side: `appUrlOpen` announces a link; `takeAppUrl` answers the last one kept
 * (`{ url }`) and forgets it, or `{}` when there is none.
 */
export interface AppUrlPlugin {
  addListener(
    eventName: "appUrlOpen",
    listener: (e: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
  takeAppUrl(): Promise<unknown>;
}

/** Takes native's kept link on each announcement and once at the start; returns how to stop. */
export function connectOpenLinks(plugin: AppUrlPlugin, router: OpenLinkRouter): () => void {
  let stopped = false;
  const take = async () => {
    if (stopped) return;
    const answer = await plugin.takeAppUrl();
    const url =
      typeof answer === "object" && answer !== null ? (answer as { url?: unknown }).url : undefined;
    if (!stopped && typeof url === "string") await router.route(url);
  };
  const handle = plugin.addListener("appUrlOpen", () => {
    void take().catch(() => {});
  });
  // Listening first, then taking: a link that arrives between the two is not lost.
  void handle.then(take).catch(() => {});
  return () => {
    stopped = true;
    void handle.then((h) => h.remove()).catch(() => {});
  };
}
