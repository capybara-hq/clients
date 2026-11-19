// Windows: one or more per profile (the deployment's web in the profile's partition) and the
// address page. Knows which webContents belongs to which profile, which is what the IPC checks
// resolve against. Electron objects come in as parameters.
import {
  ADDRESS_URL,
  type CapabilityDescriptors,
  chromeState,
  SHELL_CHANNELS,
  type ShellEventMessage,
  type ShellPlatform,
  type ShellState,
  TRAFFIC_LIGHT_POSITION,
} from "../shared/protocol.ts";
import { type Profile, partitionFor } from "./profiles.ts";
import { blockInWindowSignIn, type WebRequestSession } from "./request-guard.ts";
import {
  ADDRESS_PARTITION,
  addressWebPreferences,
  type ContentsLike,
  childWebPreferences,
  hardenAddressContents,
  hardenProfileContents,
  installDenyAllPermissions,
  installPermissionHandlers,
  type PermissionSession,
  profileWebPreferences,
} from "./security.ts";
import { type HeaderSession, installDesktopUserAgent } from "./user-agent.ts";

export interface WebContentsLike extends ContentsLike {
  id: number;
  mainFrame: { origin: string };
  send(channel: string, payload: unknown): void;
  reload(): void;
  isDestroyed(): boolean;
}

export interface WindowLike {
  webContents: WebContentsLike;
  on(event: string, listener: () => void): unknown;
  show(): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  isFullScreen(): boolean;
  setBackgroundColor(color: string): void;
  loadURL(url: string): Promise<void>;
}

export interface WindowOptions {
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  show: boolean;
  title: string;
  titleBarStyle?: "hiddenInset";
  trafficLightPosition?: { x: number; y: number };
  backgroundColor?: string;
  resizable?: boolean;
  /** A child window (the device verification page) stays above its parent and closes with it. */
  parent?: unknown;
  webPreferences:
    | ReturnType<typeof profileWebPreferences>
    | ReturnType<typeof addressWebPreferences>
    | ReturnType<typeof childWebPreferences>;
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
  addressPreloadPath: string;
  platform: ShellPlatform;
  openExternal(url: string): unknown;
  /** The capability descriptors offered to a profile now. */
  describe(profile: Profile): CapabilityDescriptors;
  /** The event names offered to a profile now (`device@1.onStatus`). */
  describeEvents?: (profile: Profile) => CapabilityDescriptors;
  /** A profile window committed a main-frame navigation: what is offered may be decided again. */
  onProfileLoad?: (profile: Profile) => void;
  /** A profile window closed: its event subscriptions can go. */
  onProfileClosed?: (webContentsId: number) => void;
  /** A profile window was focused: the last-used profile. */
  onFocusProfile(profile: Profile): void;
  /** An address window closed: what was pending for its webContents id can go. */
  onAddressClosed?: (webContentsId: number) => void;
  /** `Capybara Desktop/<version> (<machine>)`, sent only to each profile's own origin. */
  userAgent: string;
  backgroundColor?: () => string;
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
  | { kind: "address"; window: WindowLike; prefill: string | null };

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

  const entries = () => [...byContents.values()];
  const profileEntries = (id: string) =>
    entries().filter(
      (e): e is Extract<Entry, { kind: "profile" }> => e.kind === "profile" && e.profile.id === id,
    );

  function load(win: WindowLike, url: string): void {
    win.loadURL(url).catch((err: unknown) => deps.log?.(`could not load ${url}`, err));
  }

  function track(entry: Entry): void {
    const { window: win } = entry;
    const id = win.webContents.id;
    byContents.set(id, entry);
    win.on("focus", () => {
      lastFocused = entry;
      if (entry.kind === "profile") deps.onFocusProfile(entry.profile);
    });
    win.on("closed", () => {
      byContents.delete(id);
      if (entry.kind === "address") deps.onAddressClosed?.(id);
      else deps.onProfileClosed?.(id);
      if (lastFocused === entry) lastFocused = undefined;
    });
    win.on("ready-to-show", () => win.show());
  }

  function bringToFront(win: WindowLike): void {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function stateOf(entry: Extract<Entry, { kind: "profile" }>, fullscreen: boolean): ShellState {
    const events = deps.describeEvents?.(entry.profile) ?? {};
    return {
      ...chromeState(deps.platform, fullscreen),
      capabilities: deps.describe(entry.profile),
      ...(Object.keys(events).length > 0 ? { events } : {}),
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

  /** Permissions, the sign-in guard and the user agent, once per profile partition. */
  function preparePartition(profile: Profile): string {
    const partition = partitionFor(profile.id);
    if (!permissionsInstalled.has(partition)) {
      const ses = deps.sessionFor(partition);
      installPermissionHandlers(ses, profile.origin);
      blockInWindowSignIn(ses, profile.base);
      installDesktopUserAgent(ses, profile.origin, deps.userAgent);
      permissionsInstalled.add(partition);
    }
    return partition;
  }

  function openProfileWindow(profile: Profile, url: string = profile.base): WindowLike {
    const partition = preparePartition(profile);
    const win = deps.createWindow({
      width: 1280,
      height: 820,
      minWidth: 480,
      minHeight: 400,
      show: false,
      title: profile.name,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
      ...(deps.backgroundColor ? { backgroundColor: deps.backgroundColor() } : {}),
      webPreferences: profileWebPreferences({ partition, preload: deps.preloadPath }),
    });
    const entry: Extract<Entry, { kind: "profile" }> = { kind: "profile", profile, window: win };
    track(entry);
    hardenProfileContents(win.webContents, {
      origin: profile.origin,
      openExternal: deps.openExternal,
      openProfileWindow: (target) => openProfileWindow(profile, target),
    });
    win.webContents.on("did-navigate", () => deps.onProfileLoad?.(profile));
    win.on("enter-full-screen", () => sendState(entry, true));
    win.on("leave-full-screen", () => sendState(entry, false));
    load(win, url);
    return win;
  }

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

    openAddressWindow(prefill?: string): WindowLike {
      const existing = entries().find((e) => e.kind === "address");
      if (existing && existing.kind === "address") {
        if (prefill !== undefined) {
          existing.prefill = prefill;
          load(existing.window, ADDRESS_URL);
        }
        bringToFront(existing.window);
        return existing.window;
      }
      if (!permissionsInstalled.has(ADDRESS_PARTITION)) {
        installDenyAllPermissions(deps.sessionFor(ADDRESS_PARTITION));
        permissionsInstalled.add(ADDRESS_PARTITION);
      }
      const win = deps.createWindow({
        width: 560,
        height: 620,
        show: false,
        resizable: false,
        title: "Capybara",
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
        ...(deps.backgroundColor ? { backgroundColor: deps.backgroundColor() } : {}),
        webPreferences: addressWebPreferences({ preload: deps.addressPreloadPath }),
      });
      track({ kind: "address", window: win, prefill: prefill ?? null });
      hardenAddressContents(win.webContents);
      load(win, ADDRESS_URL);
      return win;
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

    /**
     * A window of the profile's partition above `parent` for a page of the deployment (the device
     * verification page): signed in, but untracked, so no IPC resolves to it, and no preload.
     */
    openChildWindow(
      profile: Profile,
      parent: unknown,
      url: string,
    ): { close(): void; onClosed(cb: () => void): void } {
      const parentAlive =
        typeof parent === "object" &&
        parent !== null &&
        !(parent as { isDestroyed?: () => boolean }).isDestroyed?.();
      const win = deps.createWindow({
        width: 560,
        height: 720,
        show: false,
        // The default title bar: the page has no inset for traffic lights.
        title: profile.name,
        ...(parentAlive ? { parent } : {}),
        ...(deps.backgroundColor ? { backgroundColor: deps.backgroundColor() } : {}),
        webPreferences: childWebPreferences({ partition: preparePartition(profile) }),
      });
      hardenProfileContents(win.webContents, {
        origin: profile.origin,
        openExternal: deps.openExternal,
        openProfileWindow: (target) => openProfileWindow(profile, target),
      });
      win.on("ready-to-show", () => win.show());
      const closedListeners: (() => void)[] = [];
      win.on("closed", () => {
        for (const cb of closedListeners.splice(0)) cb();
      });
      load(win, url);
      return {
        close: () => {
          if (!win.isDestroyed()) win.close();
        },
        onClosed: (cb) => {
          closedListeners.push(cb);
        },
      };
    },

    resolveSender(sender: unknown): ProfileTarget | undefined {
      const e = get(sender);
      return e?.kind === "profile" ? { profile: e.profile, window: e.window } : undefined;
    },

    isAddressSender(sender: unknown): boolean {
      return get(sender)?.kind === "address";
    },

    prefillFor(sender: unknown): string | null {
      const e = get(sender);
      return e?.kind === "address" ? e.prefill : null;
    },

    closeSender(sender: unknown): void {
      get(sender)?.window.close();
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
     * windows of a profile it refuses (a managed lock) are skipped; the address window is not.
     */
    focusLast(accept?: (profile: Profile) => boolean): boolean {
      const all = entries().filter((e) => e.kind === "address" || !accept || accept(e.profile));
      const target = lastFocused && all.includes(lastFocused) ? lastFocused : all[all.length - 1];
      if (!target) return false;
      bringToFront(target.window);
      return true;
    },

    closeProfileWindows(profileId: string): void {
      for (const e of profileEntries(profileId)) e.window.close();
    },

    hasWindows(): boolean {
      return byContents.size > 0;
    },
  };
}

export type WindowManager = ReturnType<typeof createWindowManager>;
