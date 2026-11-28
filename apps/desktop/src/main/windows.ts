// Windows: one or more per profile (the deployment's web in the profile's partition, the main
// window) and the small window of the local onboarding pages (spec §6.1). Knows which webContents
// belongs to which profile, which is what the IPC checks resolve against. Electron objects come in
// as parameters.

import { BUILTIN_TOKENS } from "../shared/appearance.ts";
import {
  CAPTION_BUTTONS_WIDTH,
  type CapabilityDescriptors,
  type CapabilityFields,
  type Controls,
  chromeState,
  localPageUrl,
  MAIN_TOP_ROW,
  MAIN_TRAFFIC_LIGHT_POSITION,
  SHELL_CHANNELS,
  type ShellEventMessage,
  type ShellPlatform,
  type ShellState,
  SMALL_CONTROLS,
  SMALL_TRAFFIC_LIGHT_POSITION,
} from "../shared/protocol.ts";
import { type Profile, partitionFor } from "./profiles.ts";
import { blockInWindowSignIn, type WebRequestSession } from "./request-guard.ts";
import {
  type ContentsLike,
  hardenLocalContents,
  hardenProfileContents,
  installPermissionHandlers,
  localWebPreferences,
  type PermissionSession,
  profileWebPreferences,
} from "./security.ts";
import { type HeaderSession, installDesktopUserAgent } from "./user-agent.ts";
import {
  type BoundsScheduler,
  DEFAULT_SIZE,
  type DisplayInfo,
  initialBounds,
  type Rect,
  trackBounds,
} from "./window-bounds.ts";

export interface WebContentsLike extends ContentsLike {
  id: number;
  mainFrame: { origin: string };
  send(channel: string, payload: unknown): void;
  reload(): void;
  isDestroyed(): boolean;
  /** The main frame's URL now (sign-out pairs a logout with a window already on /login). */
  getURL?(): string;
}

/** The `close` event's argument: preventing it keeps the window. */
export interface CloseEventLike {
  preventDefault(): void;
}

export interface WindowLike {
  webContents: WebContentsLike;
  on(event: string, listener: () => void): unknown;
  show(): void;
  /** Hides the window, keeping its page (macOS: a closed main window is hidden). */
  hide?(): void;
  setFullScreen?(flag: boolean): void;
  focus(): void;
  close(): void;
  /** Closes at once: no `close` event, no `beforeunload` (a page cannot keep the window). */
  destroy(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  isFullScreen(): boolean;
  isMaximized?(): boolean;
  getBounds(): Rect;
  /** The page area's size, `[width, height]` (Windows / Linux place the caption buttons by it). */
  getContentSize?(): number[];
  /** The rectangle a maximized or full-screen window restores to. */
  getNormalBounds?(): Rect;
  setBackgroundColor(color: string): void;
  /** Windows / Linux with a title bar overlay: its colors (K8 calls it on a theme change). */
  setTitleBarOverlay?(o: TitleBarOverlay): void;
  loadURL(url: string): Promise<void>;
}

export interface TitleBarOverlay {
  color: string;
  symbolColor: string;
  height?: number;
}

export interface WindowOptions {
  x?: number;
  y?: number;
  width: number;
  height: number;
  useContentSize?: boolean;
  minWidth?: number;
  minHeight?: number;
  show: boolean;
  title: string;
  titleBarStyle?: "hiddenInset" | "hidden";
  trafficLightPosition?: { x: number; y: number };
  titleBarOverlay?: TitleBarOverlay;
  backgroundColor?: string;
  resizable?: boolean;
  maximizable?: boolean;
  fullscreenable?: boolean;
  webPreferences: ReturnType<typeof profileWebPreferences> | ReturnType<typeof localWebPreferences>;
}

/** The small window (spec §6.1): fixed 480×600, its content a local page. */
export const SMALL_WINDOW_SIZE = { width: 480, height: 600 } as const;
/** Windows / Linux: the small window's caption overlay height. */
export const CAPTION_OVERLAY_HEIGHT = 32;
/** The caption overlay's colors when no appearance is known: the light scheme's ground and muted. */
export const DEFAULT_OVERLAY_COLORS = {
  color: BUILTIN_TOKENS.light.bg,
  symbolColor: BUILTIN_TOKENS.light.muted,
} as const;
/** A further window of a profile opens this far right and down of its first window. */
export const CASCADE_OFFSET = 24;
/** The main window's smallest size (spec §6.7). */
export const MAIN_MIN_SIZE = { width: 480, height: 400 } as const;

/**
 * The window controls' rectangle in the small window, for the page to keep clear of: the traffic
 * lights top left on macOS, the caption buttons top right elsewhere.
 */
export function smallWindowControls(platform: ShellPlatform): Controls {
  if (platform === "macos") return { ...SMALL_CONTROLS };
  return {
    x: SMALL_WINDOW_SIZE.width - CAPTION_BUTTONS_WIDTH,
    y: 0,
    width: CAPTION_BUTTONS_WIDTH,
    height: CAPTION_OVERLAY_HEIGHT,
  };
}

/** The small window's colors: its ground, and the caption symbols on Windows / Linux. */
export interface SmallWindowColors {
  background: string;
  symbol: string;
}

/** The small window's options: not resizable, no maximize, no full screen, the local preload. */
export function smallWindowOptions(
  platform: ShellPlatform,
  colors: SmallWindowColors,
  o: { title: string; preload: string },
): WindowOptions {
  return {
    ...SMALL_WINDOW_SIZE,
    useContentSize: true,
    show: false,
    title: o.title,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: colors.background,
    ...(platform === "macos"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { ...SMALL_TRAFFIC_LIGHT_POSITION } }
      : {
          titleBarStyle: "hidden",
          titleBarOverlay: {
            color: colors.background,
            symbolColor: colors.symbol,
            height: CAPTION_OVERLAY_HEIGHT,
          },
        }),
    webPreferences: localWebPreferences({ preload: o.preload }),
  };
}

/**
 * The main window's title bar (desktop spec §7.3): hidden, the web running to the top edge. macOS
 * centres the traffic lights in its top row; Windows and Linux draw the caption buttons as a title
 * bar overlay as high as the row, in the profile's colors (`chromeState` reports either
 * rectangle). Without a frame the app menu bar is not drawn; its accelerators stay.
 */
export function mainWindowChrome(
  platform: ShellPlatform,
  colors: { color: string; symbolColor: string },
): Pick<WindowOptions, "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay"> {
  return platform === "macos"
    ? { titleBarStyle: "hidden", trafficLightPosition: { ...MAIN_TRAFFIC_LIGHT_POSITION } }
    : { titleBarStyle: "hidden", titleBarOverlay: { ...colors, height: MAIN_TOP_ROW } };
}

/** A window as far as its chrome state needs it: its sizes and whether it is full screen. */
export interface ChromeWindow {
  getContentSize?(): number[];
  getBounds?(): Rect;
  isFullScreen?(): boolean;
}

/** The width of a window's page area: the caption buttons sit at its right edge. */
export function contentWidth(win: ChromeWindow): number {
  return win.getContentSize?.()[0] ?? win.getBounds?.().width ?? 0;
}

/** A main window's insets and controls now (`chromeState` for the window as it is). */
export function windowChromeState(
  platform: ShellPlatform,
  win: ChromeWindow,
  fullscreen: boolean = win.isFullScreen?.() ?? false,
): ReturnType<typeof chromeState> {
  return chromeState(platform, fullscreen, contentWidth(win));
}

/** A partition as the window manager configures it. */
export type ProfileSession = PermissionSession &
  Pick<HeaderSession, "getUserAgent"> & {
    webRequest: WebRequestSession["webRequest"] & HeaderSession["webRequest"];
  };

export interface WindowManagerDeps {
  createWindow(options: WindowOptions): WindowLike;
  sessionFor(partition: string): ProfileSession;
  preloadPath: string;
  /** The local pages' preload (`window.capybaraLocal`), for the small window. */
  localPreloadPath: string;
  platform: ShellPlatform;
  openExternal(url: string): unknown;
  /** The capability descriptors offered to a profile now. */
  describe(profile: Profile): CapabilityDescriptors;
  /** The event names offered to a profile now (`name@major.event`). */
  describeEvents?: (profile: Profile) => CapabilityDescriptors;
  /** The data fields of the capabilities offered to a profile now. */
  describeFields?: (profile: Profile) => CapabilityFields;
  /** A profile window committed a main-frame navigation: what is offered may be decided again. */
  onProfileLoad?: (profile: Profile) => void;
  /**
   * A profile partition was prepared (once per partition, before its first window loads): the
   * sign-out's `webRequest.onCompleted` listener goes here (sign-out.ts `watchLogout`).
   */
  onPartitionPrepared?: (profile: Profile, partition: string) => void;
  /**
   * A profile window was created, before its first load: the session watch goes here (the expired
   * and unreachable overlays, session-watch.ts).
   */
  onProfileWindow?: (profile: Profile, window: WindowLike) => void;
  /** A profile window closed: its event subscriptions can go. */
  onProfileClosed?: (webContentsId: number) => void;
  /**
   * A profile window opened or closed (called once `hasProfileWindows` says so): the tray and the
   * app menu mark which platforms are open.
   */
  onProfileWindowsChanged?: () => void;
  /**
   * Whether the profile is still stored (removed or being removed: false). A window is never
   * opened for one that is not: it would fill the partition a removal clears. Absent: always.
   */
  profileExists?: (profileId: string) => boolean;
  /** A profile window was focused: the last-used profile. */
  onFocusProfile(profile: Profile): void;
  /** `Capybara Desktop/<version> (<machine>)`, sent only to each profile's own origin. */
  userAgent: string;
  /** A window's ground before its page paints: the profile's appearance (desktop spec §6.10). */
  backgroundColor?: (profile: Profile) => string;
  /** Windows / Linux: the caption overlay's colors for the profile's appearance. */
  overlayColors?: (profile: Profile) => { color: string; symbolColor: string };
  /** The displays' work areas, for the main window's first rectangle (`screen.getAllDisplays`). */
  displays?: () => DisplayInfo[];
  /** Remembers a main window's rectangle for its profile (spec §6.7). */
  saveBounds?: (profileId: string, bounds: Rect) => void;
  boundsScheduler?: BoundsScheduler;
  /** The app's name, the small window's title. */
  appName?: string;
  /**
   * macOS: closing a main window hides it, keeping its page, scroll and draft for the next Dock
   * click; only a quit (`prepareQuit`) or a removal / sign-out closes it for real.
   */
  hideOnClose?: boolean;
  /** Errors that have nowhere else to go (a failed load). */
  log?: (message: string, err: unknown) => void;
}

/** What the IPC layer resolves a sender to. */
export interface ProfileTarget {
  profile: Profile;
  window: WindowLike;
}

type Entry =
  | { kind: "profile"; profile: Profile; window: WindowLike }
  | { kind: "small"; window: WindowLike };

/** The id of a webContents-like sender, or undefined for anything else. */
export function webContentsId(sender: unknown): number | undefined {
  if (typeof sender !== "object" || sender === null) return undefined;
  const id = (sender as { id?: unknown }).id;
  return typeof id === "number" ? id : undefined;
}

export function createWindowManager(deps: WindowManagerDeps) {
  // Keyed by webContents id: stable for the life of the contents and never reused.
  const byContents = new Map<number, Entry>();
  const get = (sender: unknown) => {
    const id = webContentsId(sender);
    return id === undefined ? undefined : byContents.get(id);
  };
  const permissionsInstalled = new Set<string>();
  let lastFocused: Entry | undefined;
  /** Set once the app quits: a close is a close again. */
  let quitting = false;
  /** Full-screen windows closed by the person: hidden once they have left full screen. */
  const hideAfterFullScreen = new Set<WindowLike>();

  const entries = () => [...byContents.values()];
  const profileEntries = (id: string) =>
    entries().filter(
      (e): e is Extract<Entry, { kind: "profile" }> => e.kind === "profile" && e.profile.id === id,
    );

  function load(win: WindowLike, url: string): void {
    win.loadURL(url).catch((err: unknown) => deps.log?.(`could not load ${url}`, err));
  }

  /**
   * Forgets a window (once): no IPC resolves to it any more. Takes the webContents id recorded at
   * `track`: after `closed`, reading the window's `webContents` throws.
   */
  function untrack(id: number): void {
    const entry = byContents.get(id);
    if (!entry) return;
    byContents.delete(id);
    if (lastFocused === entry) lastFocused = undefined;
    if (entry.kind === "profile") {
      deps.onProfileClosed?.(id);
      deps.onProfileWindowsChanged?.();
    }
  }

  function track(entry: Entry): void {
    const { window: win } = entry;
    const id = win.webContents.id;
    byContents.set(id, entry);
    win.on("focus", () => {
      lastFocused = entry;
      if (entry.kind === "profile") deps.onFocusProfile(entry.profile);
    });
    win.on("closed", () => untrack(id));
    win.on("ready-to-show", () => win.show());
  }

  function bringToFront(win: WindowLike): void {
    hideAfterFullScreen.delete(win);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /**
   * A main window's close while hiding applies: hidden instead (it stays tracked, so the menus
   * still count it open). A full-screen window first leaves full screen: hiding it in place
   * leaves a black space behind (an Electron quirk on macOS).
   */
  function hideOnClose(win: WindowLike, id: number): void {
    // `close` passes its event; the window's other events pass nothing this module reads.
    const onClose = (event: CloseEventLike) => {
      if (quitting || !byContents.has(id)) return;
      event.preventDefault();
      if (win.isFullScreen() && win.setFullScreen) {
        hideAfterFullScreen.add(win);
        win.setFullScreen(false);
        return;
      }
      win.hide?.();
    };
    win.on("close", onClose as unknown as () => void);
    win.on("leave-full-screen", () => {
      if (hideAfterFullScreen.delete(win)) win.hide?.();
    });
  }

  function stateOf(entry: Extract<Entry, { kind: "profile" }>, fullscreen: boolean): ShellState {
    const events = deps.describeEvents?.(entry.profile) ?? {};
    const fields = deps.describeFields?.(entry.profile) ?? {};
    return {
      ...windowChromeState(deps.platform, entry.window, fullscreen),
      capabilities: deps.describe(entry.profile),
      ...(Object.keys(events).length > 0 ? { events } : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
    };
  }

  /** True while the window's top frame is on the profile origin (and the contents live). */
  function onProfileOrigin(win: WindowLike, profile: Profile): boolean {
    try {
      const wc = win.webContents;
      return !wc.isDestroyed() && wc.mainFrame.origin === profile.origin;
    } catch {
      return false;
    }
  }

  /** Sends `change` only while the window's main frame is on the profile origin. */
  function sendState(entry: Extract<Entry, { kind: "profile" }>, fullscreen: boolean): void {
    const wc = entry.window.webContents;
    try {
      if (wc.isDestroyed() || wc.mainFrame.origin !== entry.profile.origin) return;
      wc.send(SHELL_CHANNELS.change, stateOf(entry, fullscreen));
    } catch {
      // The frame went away between the check and the send: nothing to tell.
    }
  }

  /**
   * Permissions, the sign-in guard, the user agent and the logout watch, once per profile
   * partition.
   */
  function preparePartition(profile: Profile): string {
    const partition = partitionFor(profile.id);
    if (!permissionsInstalled.has(partition)) {
      const ses = deps.sessionFor(partition);
      installPermissionHandlers(ses, profile.origin);
      blockInWindowSignIn(ses, profile.base);
      installDesktopUserAgent(ses, profile.origin, deps.userAgent);
      permissionsInstalled.add(partition);
      deps.onPartitionPrepared?.(profile, partition);
    }
    return partition;
  }

  /** Opens a profile window; undefined for a profile no longer stored (`profileExists`). */
  function openProfileWindow(profile: Profile, url: string = profile.base): WindowLike | undefined {
    if (deps.profileExists && !deps.profileExists(profile.id)) return undefined;
    const partition = preparePartition(profile);
    // The profile's first window opens at the remembered rectangle and keeps it up to date; a
    // further window cascades from the first one and is not remembered.
    const first = profileEntries(profile.id)[0];
    let rect: Rect | undefined;
    if (first) {
      try {
        const b = first.window.getBounds();
        rect = { ...b, x: b.x + CASCADE_OFFSET, y: b.y + CASCADE_OFFSET };
      } catch {
        rect = undefined;
      }
    } else if (deps.displays) {
      rect = initialBounds(profile.bounds, deps.displays());
    }
    const win = deps.createWindow({
      ...(rect ?? DEFAULT_SIZE),
      minWidth: MAIN_MIN_SIZE.width,
      minHeight: MAIN_MIN_SIZE.height,
      show: false,
      title: profile.name,
      ...mainWindowChrome(deps.platform, deps.overlayColors?.(profile) ?? DEFAULT_OVERLAY_COLORS),
      ...(deps.backgroundColor ? { backgroundColor: deps.backgroundColor(profile) } : {}),
      webPreferences: profileWebPreferences({ partition, preload: deps.preloadPath }),
    });
    const entry: Extract<Entry, { kind: "profile" }> = { kind: "profile", profile, window: win };
    track(entry);
    if (deps.hideOnClose) hideOnClose(win, win.webContents.id);
    hardenProfileContents(win.webContents, {
      origin: profile.origin,
      openExternal: deps.openExternal,
      openProfileWindow: (target) => openProfileWindow(profile, target),
    });
    win.webContents.on("did-navigate", () => deps.onProfileLoad?.(profile));
    deps.onProfileWindow?.(profile, win);
    deps.onProfileWindowsChanged?.();
    win.on("enter-full-screen", () => sendState(entry, true));
    win.on("leave-full-screen", () => sendState(entry, false));
    if (deps.platform !== "macos") {
      // The caption buttons sit at the right edge: a new width moves their rectangle.
      let width = contentWidth(win);
      win.on("resize", () => {
        if (win.isDestroyed()) return;
        const now = contentWidth(win);
        if (now === width) return;
        width = now;
        sendState(entry, win.isFullScreen());
      });
    }
    const save = deps.saveBounds;
    if (save && !first) trackBounds(win, (b) => save(profile.id, b), deps.boundsScheduler);
    load(win, url);
    return win;
  }

  const smallEntry = () =>
    entries().find((e): e is Extract<Entry, { kind: "small" }> => e.kind === "small");

  return {
    openProfileWindow,

    /** Focuses a window of the profile (and loads `url` there), or opens one. */
    showProfile(profile: Profile, url?: string): void {
      const open = profileEntries(profile.id);
      const entry =
        lastFocused?.kind === "profile" && lastFocused.profile.id === profile.id
          ? lastFocused
          : open[open.length - 1];
      if (!entry) {
        openProfileWindow(profile, url);
        return;
      }
      bringToFront(entry.window);
      if (url !== undefined) load(entry.window, url);
    },

    /**
     * After a sign-in: every window of the profile reloads (a window that left the origin goes back
     * to the base), and one comes forward from behind the browser. Opens a window when none is.
     */
    reloadProfile(profile: Profile): void {
      const open = profileEntries(profile.id);
      if (open.length === 0) {
        openProfileWindow(profile);
        return;
      }
      for (const e of open) {
        const wc = e.window.webContents;
        let onOrigin = false;
        try {
          onOrigin = !wc.isDestroyed() && wc.mainFrame.origin === profile.origin;
        } catch {
          onOrigin = false;
        }
        if (onOrigin) wc.reload();
        else load(e.window, profile.base);
      }
      const front =
        lastFocused?.kind === "profile" && lastFocused.profile.id === profile.id
          ? lastFocused
          : open[open.length - 1];
      if (front) bringToFront(front.window);
    },

    /**
     * The small window (one at a time): brings the open one forward, else opens it on the local
     * onboarding page. The caller registers its webContents as a local page before the page asks
     * for its state (the load is asynchronous) and listens for `closed`.
     */
    openSmallWindow(colors: SmallWindowColors): { window: WindowLike; created: boolean } {
      const existing = smallEntry();
      if (existing) {
        bringToFront(existing.window);
        return { window: existing.window, created: false };
      }
      const win = deps.createWindow(
        smallWindowOptions(deps.platform, colors, {
          title: deps.appName ?? "Capybara",
          preload: deps.localPreloadPath,
        }),
      );
      track({ kind: "small", window: win });
      hardenLocalContents(win.webContents);
      load(win, localPageUrl("onboarding"));
      return { window: win, created: true };
    },

    /** The open small window, if any. */
    smallWindow(): WindowLike | undefined {
      return smallEntry()?.window;
    },

    closeSmallWindow(): void {
      const e = smallEntry();
      if (e && !e.window.isDestroyed()) e.window.close();
    },

    /** One event of a subscription, sent only while the window is on the profile origin. */
    sendEvent(target: ProfileTarget, message: ShellEventMessage): boolean {
      if (!onProfileOrigin(target.window, target.profile)) return false;
      try {
        target.window.webContents.send(SHELL_CHANNELS.event, message);
        return true;
      } catch {
        return false;
      }
    },

    resolveSender(sender: unknown): ProfileTarget | undefined {
      const e = get(sender);
      return e?.kind === "profile" ? { profile: e.profile, window: e.window } : undefined;
    },

    /** Tells every window of a profile (or all) that its capabilities may have changed. */
    broadcastChange(profileId?: string): void {
      for (const e of entries()) {
        if (e.kind !== "profile" || (profileId !== undefined && e.profile.id !== profileId))
          continue;
        sendState(e, e.window.isFullScreen());
      }
    },

    /**
     * Focuses the most recently focused window; false when none is open. With `accept`, profile
     * windows of a profile it refuses (a managed lock) are skipped; the small window is not.
     */
    focusLast(accept?: (profile: Profile) => boolean): boolean {
      const all = entries().filter((e) => e.kind === "small" || !accept || accept(e.profile));
      const target = lastFocused && all.includes(lastFocused) ? lastFocused : all[all.length - 1];
      if (!target) return false;
      bringToFront(target.window);
      return true;
    },

    /**
     * Destroys every window of a profile and forgets them at once (a removal, a sign-out): a
     * profile being removed must not pass the IPC checks while its partition is cleared, and a
     * `close()` would be asynchronous and could be cancelled by the page's `beforeunload`,
     * leaving a forgotten window on that partition.
     */
    closeProfileWindows(profileId: string): void {
      for (const [id, e] of [...byContents]) {
        if (e.kind !== "profile" || e.profile.id !== profileId) continue;
        untrack(id);
        if (!e.window.isDestroyed()) e.window.destroy();
      }
    },

    /**
     * Closes a main window for real (a profile window that met /login while not signed in), even
     * where a close hides it; any other window is just closed.
     */
    closeWindow(win: WindowLike): void {
      for (const [id, e] of [...byContents]) {
        if (e.window === win && e.kind === "profile") untrack(id);
      }
      if (!win.isDestroyed()) win.close();
    },

    /** The app is quitting (`before-quit`, an update's restart): closes are no longer hides. */
    prepareQuit(): void {
      quitting = true;
    },

    /**
     * The window a dialog about a profile attaches to: that profile's last focused (or newest)
     * window, else the small window when it is in front (it shows that profile's pages); else
     * undefined, and the dialog stands alone. Never another profile's window: a dialog about one
     * platform must not sit on another's, nor be refused because that window is busy.
     */
    dialogParent(profileId: string): WindowLike | undefined {
      if (lastFocused?.kind === "profile" && lastFocused.profile.id === profileId) {
        return lastFocused.window;
      }
      const own = profileEntries(profileId).at(-1);
      if (own) return own.window;
      return lastFocused?.kind === "small" && entries().includes(lastFocused)
        ? lastFocused.window
        : undefined;
    },

    /** Whether a main window of the profile is open. */
    hasProfileWindows(profileId: string): boolean {
      return profileEntries(profileId).length > 0;
    },

    /** The main-frame URLs of the profile's open windows (a destroyed one is skipped). */
    profileUrls(profileId: string): string[] {
      const urls: string[] = [];
      for (const e of profileEntries(profileId)) {
        try {
          const wc = e.window.webContents;
          const url = wc.isDestroyed() ? undefined : wc.getURL?.();
          if (url) urls.push(url);
        } catch {
          // Gone between the check and the read.
        }
      }
      return urls;
    },

    hasWindows(): boolean {
      return byContents.size > 0;
    },
  };
}

export type WindowManager = ReturnType<typeof createWindowManager>;
