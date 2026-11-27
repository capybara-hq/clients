// `<scheme>://open?url=<page>` links (mobile spec §4.4, shell external authorization spec §3, §5):
// the browser's 「回到 Capybara」 after a connector OAuth or a login linking finished there. Native
// forwards every link of the brand's scheme it receives outside a sign-in as an `appUrlOpen` event
// of the `CapybaraHost` plugin (iOS: the scene's open URL contexts; Android: MainActivity's VIEW
// intents for the `open` host). Links are untrusted input, as on the desktop
// (apps/desktop/src/main/deep-links.ts): a page loads only on a visible profile whose origin is
// exactly the link's, and anything else (another kind of link, another scheme, a non-http(s) URL,
// an unknown origin) is ignored. Nothing here signs in, saves or adds a profile.
import { parseDeepLink } from "@capybara-hq/shell";

/** A link longer than this is ignored (the web's own links are far shorter). */
export const OPEN_LINK_MAX = 4096;

export interface OpenLinkDeps {
  /** The brand's URL scheme: links of any other scheme are ignored. */
  scheme: string;
  /** The profiles a link may open (the managed gate's visible list). */
  profiles(): readonly { id: string; origin: string }[];
  /** Makes the profile current and loads `origin + path` in it (native re-checks the path). */
  open(profileId: string, path: string): Promise<void>;
}

export interface OpenLinkRouter {
  route(link: string): Promise<void>;
}

/** The profile and in-app path an `open` link leads to; null when it leads nowhere. */
export function openLinkTarget(
  link: string,
  scheme: string,
  profiles: readonly { id: string; origin: string }[],
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
  const profile = profiles.find((p) => p.origin === url.origin);
  if (!profile) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Native loads `origin + path`: a path that could read as another host is never handed over.
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  return { profileId: profile.id, path };
}

export function createOpenLinkRouter(deps: OpenLinkDeps): OpenLinkRouter {
  return {
    async route(link) {
      const target = openLinkTarget(link, deps.scheme, deps.profiles());
      if (target) await deps.open(target.profileId, target.path);
    },
  };
}

/** The plugin's `appUrlOpen` event: `{ url }` for each link of the brand's scheme. */
export interface AppUrlPlugin {
  addListener(
    eventName: "appUrlOpen",
    listener: (e: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

/** Forwards native's links to the router; returns how to stop. */
export function connectOpenLinks(plugin: AppUrlPlugin, router: OpenLinkRouter): () => void {
  let stopped = false;
  const handle = plugin.addListener("appUrlOpen", (e) => {
    if (stopped || typeof e !== "object" || e === null) return;
    const url = (e as { url?: unknown }).url;
    if (typeof url === "string") void router.route(url).catch(() => {});
  });
  return () => {
    stopped = true;
    void handle.then((h) => h.remove()).catch(() => {});
  };
}
