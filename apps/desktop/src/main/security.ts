// The security baseline of the shell windows (spec §7.2): webPreferences, permissions, navigation
// and window.open rules. Electron objects come in as parameters.
import { APP_SCHEME, LOCAL_HOST } from "../shared/protocol.ts";

const BASE_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  // Off so preloads run in the main frame only; the preload still checks for the top frame.
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
  spellcheck: true,
} as const;

export function profileWebPreferences(o: { partition: string; preload: string }) {
  return { ...BASE_PREFERENCES, partition: o.partition, preload: o.preload };
}

/**
 * A window of the profile's partition that is not a deployment window (the device verification
 * page, spec §9.2): the signed-in session, but no preload, so no Shell environment.
 */
export function childWebPreferences(o: { partition: string }) {
  return { ...BASE_PREFERENCES, partition: o.partition };
}

/**
 * The local pages (small window, error overlay, shell dialogs): the app's own partition, never a
 * profile's, so no deployment cookie or storage is ever in reach of a local page.
 */
export const LOCAL_PARTITION = "local";

export function localWebPreferences(o: { preload: string }) {
  return { ...BASE_PREFERENCES, partition: LOCAL_PARTITION, preload: o.preload, spellcheck: false };
}

/**
 * The only permissions the web uses: clipboard writes (copy buttons) and notifications. The
 * microphone and camera are not used by the web today, so they are denied.
 */
export const GRANTED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "notifications",
]);

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** Granted only to the profile origin's top frame, and only for a listed permission. */
export function isPermissionAllowed(
  permission: string,
  requestingOrigin: string | null,
  isMainFrame: boolean,
  profileOrigin: string,
): boolean {
  return GRANTED_PERMISSIONS.has(permission) && isMainFrame && requestingOrigin === profileOrigin;
}

export interface PermissionSession {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: { requestingUrl: string; isMainFrame: boolean },
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
      details: { isMainFrame: boolean; requestingUrl?: string },
    ) => boolean,
  ): void;
  setDevicePermissionHandler(handler: (details: unknown) => boolean): void;
}

export function installPermissionHandlers(session: PermissionSession, profileOrigin: string): void {
  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(
      isPermissionAllowed(
        permission,
        originOf(details.requestingUrl),
        details.isMainFrame,
        profileOrigin,
      ),
    );
  });
  session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    // A check not made for a document (a service worker) has no webContents: denied.
    if (wc === null) return false;
    return isPermissionAllowed(
      permission,
      originOf(requestingOrigin),
      details.isMainFrame,
      profileOrigin,
    );
  });
  // WebHID, WebUSB, Web Serial: never.
  session.setDevicePermissionHandler(() => false);
}

/** The local pages need no permission: every request and check is denied. */
export function installDenyAllPermissions(session: PermissionSession): void {
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
}

function isHttp(url: URL): boolean {
  return url.protocol === "https:" || url.protocol === "http:";
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Top-level navigation may leave the origin (connector OAuth), over http(s) only. */
export function isNavigationAllowed(url: string): boolean {
  const u = parse(url);
  return u !== null && isHttp(u);
}

export type WindowOpenDecision =
  | { kind: "profile"; url: string }
  | { kind: "external"; url: string }
  | { kind: "refuse" };

/**
 * Same-origin http(s) opens a window of the profile; another http(s) origin goes to the system
 * browser; everything else (javascript:, file:, blob:, data:, about:, custom schemes) is refused.
 */
export function decideWindowOpen(url: string, profileOrigin: string): WindowOpenDecision {
  const u = parse(url);
  if (!u || !isHttp(u)) return { kind: "refuse" };
  if (u.origin === profileOrigin) return { kind: "profile", url: u.href };
  return { kind: "external", url: u.href };
}

type Prevented = { preventDefault(): void; url?: string };

export interface ContentsLike {
  // biome-ignore lint/suspicious/noExplicitAny: Electron's event listeners are overloaded per event.
  on(event: string, listener: (...args: any[]) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
}

function navigationUrl(e: Prevented, url: unknown): string {
  return typeof e.url === "string" ? e.url : typeof url === "string" ? url : "";
}

/** The baseline for every webContents, whatever window it belongs to. */
export function hardenAnyContents(wc: ContentsLike): void {
  wc.on("will-attach-webview", (e: Prevented) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
}

export function hardenProfileContents(
  wc: ContentsLike,
  o: {
    origin: string;
    openExternal(url: string): unknown;
    openProfileWindow(url: string): unknown;
  },
): void {
  hardenAnyContents(wc);
  const httpOnly = (e: Prevented, url: unknown) => {
    if (!isNavigationAllowed(navigationUrl(e, url))) e.preventDefault();
  };
  wc.on("will-navigate", httpOnly);
  wc.on("will-redirect", httpOnly);
  wc.setWindowOpenHandler(({ url }) => {
    const d = decideWindowOpen(url, o.origin);
    if (d.kind === "profile") o.openProfileWindow(d.url);
    else if (d.kind === "external") o.openExternal(d.url);
    return { action: "deny" };
  });
}

/** A local page never navigates away from app://local and opens no windows. */
export function hardenLocalContents(wc: ContentsLike): void {
  hardenAnyContents(wc);
  const stay = (e: Prevented, url: unknown) => {
    const u = parse(navigationUrl(e, url));
    if (!u || u.protocol !== `${APP_SCHEME}:` || u.host !== LOCAL_HOST) e.preventDefault();
  };
  wc.on("will-navigate", stay);
  wc.on("will-redirect", stay);
}
