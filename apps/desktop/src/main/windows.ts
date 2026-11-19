// Windows: one or more per profile (the deployment's web in the profile's partition) and the
// address page. Knows which webContents belongs to which profile, which is what the IPC checks
// resolve against. Electron objects come in as parameters.
import {
  ADDRESS_URL,
  type CapabilityDescriptors,
  chromeState,
  SHELL_CHANNELS,
  type ShellPlatform,
  type ShellState,
  TRAFFIC_LIGHT_POSITION,
} from "../shared/protocol.ts";
import { type Profile, partitionFor } from "./profiles.ts";
import {
  ADDRESS_PARTITION,
  addressWebPreferences,
  type ContentsLike,
  hardenAddressContents,
  hardenProfileContents,
  installDenyAllPermissions,
  installPermissionHandlers,
  type PermissionSession,
  profileWebPreferences,
} from "./security.ts";

export interface WebContentsLike extends ContentsLike {
  id: number;
  mainFrame: { origin: string };
  send(channel: string, payload: unknown): void;
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
  titleBarStyle: "hiddenInset";
  trafficLightPosition: { x: number; y: number };
  backgroundColor?: string;
  resizable?: boolean;
  webPreferences:
    | ReturnType<typeof profileWebPreferences>
    | ReturnType<typeof addressWebPreferences>;
}

export interface WindowManagerDeps {
  createWindow(options: WindowOptions): WindowLike;
  sessionFor(partition: string): PermissionSession;
  preloadPath: string;
  addressPreloadPath: string;
  platform: ShellPlatform;
  openExternal(url: string): unknown;
  /** The capability descriptors offered to a profile now. */
  describe(profile: Profile): CapabilityDescriptors;
  /** A profile window was focused: the last-used profile. */
  onFocusProfile(profile: Profile): void;
  /** An address window closed: what was pending for its webContents id can go. */
  onAddressClosed?: (webContentsId: number) => void;
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
    return {
      ...chromeState(deps.platform, fullscreen),
      capabilities: deps.describe(entry.profile),
    };
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

  function openProfileWindow(profile: Profile, url: string = profile.base): WindowLike {
    const partition = partitionFor(profile.id);
    if (!permissionsInstalled.has(partition)) {
      installPermissionHandlers(deps.sessionFor(partition), profile.origin);
      permissionsInstalled.add(partition);
    }
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

    /** Focuses the most recently focused window; false when none is open. */
    focusLast(): boolean {
      const all = entries();
      const target = lastFocused ?? all[all.length - 1];
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
