// The onboarding host (desktop spec §6.1, §6.3, §6.5, §6.6): the small window's state machine.
//
//   connect ──submit──▶ found ──在浏览器中登录──▶ waiting ──callback ok──▶ main window on `/`
//      ▲                  │  ▲                      │
//      └──换一个地址────────┘  └──取消 / any failure───┘ (the failure shown on found)
//
// Discovery runs here (never in the page). A discovered deployment becomes a provisional profile:
// a new id and partition, so the token exchange has a cookie jar, but nothing is saved until the
// first sign-in completes; an abandoned attempt (the window closed, another address) is cancelled
// and its partition cleared once its exchange, if any, has settled. A deployment that is saved
// already is used as is. One small window at a time, and one flow in it. Electron objects and the
// network come in as parameters.
import {
  appSignInBlocked,
  type DiscoveryResult,
  type Meta,
  normalizeAddress,
} from "@capybara-hq/shell";
import type {
  ConnectError,
  OnboardingFields,
  OnboardingPage,
  OnboardingState,
  SignInError,
} from "../local/onboarding-model.ts";
import type { BasePageState, PagePlatform } from "../shared/local-page.ts";
import type { Controls } from "../shared/protocol.ts";
import type { LocalActContext, LocalContents, LocalPages } from "./local-pages.ts";
import type { Profile } from "./profiles.ts";
import type { SignedInAccount, SignIn, SignInOutcome } from "./sign-in.ts";
import type { SmallWindowColors } from "./windows.ts";

const MAX_NAME_LENGTH = 200;

/** The small window as the host drives it. */
export interface OnboardingWindow {
  webContents: LocalContents;
  on(event: "closed", listener: () => void): unknown;
  close(): void;
  isDestroyed(): boolean;
  setBackgroundColor?(color: string): void;
  setTitleBarOverlay?(o: { color: string; symbolColor: string }): void;
}

export interface OnboardingDeps {
  localPages: Pick<LocalPages, "register" | "handle" | "push">;
  /** Opens the small window (or brings the open one forward) on the onboarding page. */
  openWindow(colors: SmallWindowColors): OnboardingWindow;
  /** Locale, appearance, OS and footer fields for a page about `profile` (none: app level). */
  pageBase(profile?: Profile): Omit<BasePageState, "page" | "platform" | "controls">;
  /** The window controls' rectangle in the small window. */
  controls: Controls | null;
  /** The small window's colors for the appearance its page shows. */
  colors(appearance: BasePageState["appearance"]): SmallWindowColors;
  /** `discover` of packages/shell through the app's network; `base` is already normalized. */
  discover(base: string, signal: AbortSignal): Promise<DiscoveryResult>;
  /** The meta icon as a data: URL (and its cache hash), by the Dock icon's rules; {} when none. */
  platformIcon(
    deployment: { base: string; origin: string },
    icon: string | null,
  ): Promise<{ iconUrl?: string; iconHash?: string }>;
  /** A saved profile's cached icon as a data: URL. */
  storedIcon(profile: Profile): string | undefined;
  /** Managed `lockDeployments`: false refuses an address that is not on the managed list. */
  isAllowed(address: string): boolean;
  /** The saved profile of a deployment address, if any. */
  findProfile(base: string): Profile | undefined;
  newId(): string;
  signIn: Pick<SignIn, "begin" | "pendingUrl" | "cancel" | "quiesce" | "onStaleCallback">;
  /** The redirect URI the app signs in with (`appSignInBlocked`). */
  redirectUri: string;
  /** The system browser. */
  openExternal(url: string): Promise<unknown> | unknown;
  writeClipboard(text: string): void;
  /**
   * Saves a provisional profile under its own id, signed in as `account`. When a profile of the
   * same address was saved meanwhile (a managed profile saved in the background), returns that one
   * unchanged: its partition does not hold this sign-in's session.
   */
  saveProfile(provisional: Profile, account: SignedInAccount): Profile;
  /** Marks a saved profile signed in as `account`; undefined when it is gone. */
  markSignedIn(profileId: string, account: SignedInAccount): Profile | undefined;
  /**
   * Opens (or focuses) the profile's main window; `home`: load `/` there (after a sign-in), else an
   * open window keeps its page.
   */
  openMain(profile: Profile, home: boolean): void;
  /** Clears an abandoned provisional profile's partition. */
  clearPartition(profileId: string): Promise<void>;
  /** The removal flow (spec §6.3), from the signed-out page. */
  removeProfile(profileId: string): void;
  /** Whether profiles may be removed (not under a managed lock). */
  canRemove(): boolean;
  /**
   * Whether this machine is connected as the profile's deployment's device (device@1 status), for
   * the signed-out page's note. Absent: never.
   */
  deviceConnected?: (profileId: string) => boolean;
  /** This machine's name, as the authorize page shows it. */
  machineName: string;
  log?: (message: string, err?: unknown) => void;
}

interface Target {
  profile: Profile;
  /** Not saved yet: its partition is cleared when the flow is abandoned. */
  provisional: boolean;
  /** From this flow's discovery; absent for a saved profile shown at start or after sign-out. */
  meta?: Meta;
  platform: PagePlatform;
  /** An attempt was begun with this profile's partition. */
  used: boolean;
  /** A saved profile's discovery (meta for the pre-check, a fresh name and icon), while it runs. */
  discovering?: Promise<void> | undefined;
}

interface Attempt {
  id: number;
  target: Target;
  /** Where a cancel or a failure returns to: the page the sign-in started from. */
  from: "found" | "signedOut";
}

/** The longest address the connect page takes. */
export const MAX_ADDRESS_LENGTH = 2048;

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** The host to name in a connect error: of the address when it parses, else what was typed. */
function errorHostOf(input: string): string {
  const raw = input.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).host || raw;
  } catch {
    return raw;
  }
}

/** The name a deployment is saved and shown under: its meta name, else its host. */
export function platformName(meta: Pick<Meta, "name">, host: string): string {
  const named = meta.name?.trim().slice(0, MAX_NAME_LENGTH);
  return named ? named : host;
}

export function createOnboarding(deps: OnboardingDeps) {
  const log = (message: string, err?: unknown) => deps.log?.(message, err);

  let page: OnboardingPage = "connect";
  let fields: Omit<OnboardingFields, "page" | "machine" | "canRemove" | "deviceConnected"> = {
    address: "",
    prefill: 0,
    error: null,
    errorHost: null,
    busy: false,
    account: null,
  };
  let target: Target | undefined;
  let attempt: Attempt | undefined;
  let attemptSeq = 0;
  /** The running discovery; a newer submit, a new view or the window closing aborts it. */
  let discovery: { seq: number; abort: AbortController } | undefined;
  let discoverySeq = 0;

  let win: OnboardingWindow | undefined;
  let contents: LocalContents | undefined;
  let unregister: (() => void) | undefined;
  let registeredFor: string | undefined;

  /** The saved profile the page is about (provisional profiles are app level until saved). */
  const pageProfile = (): Profile | undefined =>
    target && !target.provisional ? target.profile : undefined;

  function state(): OnboardingState {
    const base = deps.pageBase(pageProfile());
    return {
      ...base,
      page,
      controls: deps.controls,
      ...(target ? { platform: { ...target.platform } } : {}),
      ...fields,
      machine: deps.machineName,
      canRemove: deps.canRemove(),
      deviceConnected:
        page === "signedOut" && target !== undefined && !target.provisional
          ? (deps.deviceConnected?.(target.profile.id) ?? false)
          : false,
    };
  }

  function register(): void {
    if (!contents) return;
    const profileId = pageProfile()?.id;
    if (unregister && registeredFor === profileId) return;
    unregister?.();
    registeredFor = profileId;
    unregister = deps.localPages.register(contents, {
      kind: "onboarding",
      ...(profileId === undefined ? {} : { profileId }),
      state,
    });
  }

  function push(): void {
    const own = contents;
    if (!own || !win || win.isDestroyed()) return;
    register();
    deps.localPages.push((entry) => entry.contents === own);
  }

  /** Opens or focuses the small window and shows the current view. */
  function show(): void {
    const colors = deps.colors(deps.pageBase(pageProfile()).appearance);
    const window = deps.openWindow(colors);
    if (window !== win) {
      unregister?.();
      unregister = undefined;
      win = window;
      contents = window.webContents;
      register();
      window.on("closed", () => {
        if (win !== window) return;
        forgetWindow();
        void abandon();
      });
    }
    push();
  }

  function forgetWindow(): void {
    unregister?.();
    unregister = undefined;
    registeredFor = undefined;
    win = undefined;
    contents = undefined;
  }

  function stopDiscovery(): void {
    discovery?.abort.abort();
    discovery = undefined;
  }

  /** Ends the attempt without showing anything (the host moved on). */
  function endAttempt(): void {
    const a = attempt;
    attempt = undefined;
    if (a) deps.signIn.cancel(a.target.profile.id);
  }

  /**
   * Leaves the current deployment: its attempt is cancelled and, for a provisional profile that
   * began one, the partition is cleared once the exchange (and the logout of a session it still
   * created) has settled.
   */
  async function dropTarget(): Promise<void> {
    const t = target;
    target = undefined;
    endAttempt();
    if (!t?.provisional || !t.used) return;
    const id = t.profile.id;
    try {
      await deps.signIn.quiesce(id);
      await deps.clearPartition(id);
    } catch (err) {
      log("could not clear an abandoned sign-in partition", err);
    }
  }

  /** The window closed: the flow is abandoned and the next window starts afresh. */
  async function abandon(): Promise<void> {
    stopDiscovery();
    page = "connect";
    fields = { ...fields, error: null, errorHost: null, busy: false, account: null };
    await dropTarget();
  }

  function setPage(next: OnboardingPage, patch: Partial<typeof fields> = {}): void {
    page = next;
    fields = { ...fields, error: null, errorHost: null, busy: false, ...patch };
    push();
  }

  function closeWindow(): void {
    const w = win;
    forgetWindow();
    try {
      if (w && !w.isDestroyed()) w.close();
    } catch (err) {
      log("could not close the small window", err);
    }
  }

  async function submit(raw: string): Promise<void> {
    stopDiscovery();
    void dropTarget();
    const seq = ++discoverySeq;
    page = "connect";
    fields = { ...fields, address: raw, error: null, errorHost: null, busy: false };
    const fail = (error: ConnectError, host: string | null = errorHostOf(raw)) => {
      if (seq === discoverySeq) setPage("connect", { error, errorHost: host });
    };
    if (!deps.isAllowed(raw)) return fail("locked");
    const address = normalizeAddress(raw);
    if (!address.ok) return fail(address.reason === "insecure" ? "not_https" : "invalid");
    const host = hostOf(address.origin);

    const abort = new AbortController();
    discovery = { seq, abort };
    setPage("connect", { busy: true });
    let result: DiscoveryResult;
    try {
      result = await deps.discover(address.base, abort.signal);
    } catch (err) {
      log("discovery failed", err instanceof Error ? err.name : undefined);
      result = { ok: false, error: "unreachable" };
    }
    if (seq !== discoverySeq || abort.signal.aborted || !win) return;
    if (!result.ok) return fail(result.error, host);

    const existing = deps.findProfile(result.base);
    if (existing?.signedIn) {
      // Saved and signed in already: nothing to add, its main window comes forward.
      discovery = undefined;
      // The main window first: closing the last window would quit the app on Windows / Linux.
      deps.openMain(existing, false);
      closeWindow();
      return;
    }
    let icon: { iconUrl?: string; iconHash?: string } = {};
    const storedIcon = existing ? deps.storedIcon(existing) : undefined;
    if (storedIcon) icon = { iconUrl: storedIcon };
    else {
      try {
        icon = await deps.platformIcon(
          { base: result.base, origin: address.origin },
          result.meta.icon,
        );
      } catch (err) {
        log("could not fetch the platform icon", err instanceof Error ? err.name : undefined);
      }
    }
    if (seq !== discoverySeq || abort.signal.aborted || !win) return;
    discovery = undefined;

    const name = platformName(result.meta, host);
    const profile: Profile = existing ?? {
      id: deps.newId(),
      base: result.base,
      origin: address.origin,
      name,
      signedIn: false,
      ...(icon.iconHash ? { iconHash: icon.iconHash } : {}),
    };
    target = {
      profile,
      provisional: !existing,
      meta: result.meta,
      platform: { name, host, ...(icon.iconUrl ? { iconUrl: icon.iconUrl } : {}) },
      used: false,
    };
    setPage("found");
  }

  function complete(t: Target, account: SignedInAccount): void {
    let saved: Profile | undefined;
    try {
      saved = t.provisional
        ? deps.saveProfile(t.profile, account)
        : deps.markSignedIn(t.profile.id, account);
    } catch (err) {
      log("could not save the signed-in profile", err);
    }
    if (!saved) {
      setPage("found", { error: "link_invalid" satisfies SignInError });
      return;
    }
    if (saved.id !== t.profile.id) {
      // The address was saved meanwhile under another id, whose partition lacks this session:
      // drop the provisional partition and sign in again, to the saved profile.
      const provisionalId = t.profile.id;
      void (async () => {
        try {
          await deps.signIn.quiesce(provisionalId);
          await deps.clearPartition(provisionalId);
        } catch (err) {
          log("could not clear an abandoned sign-in partition", err);
        }
      })();
      target = { ...t, profile: saved, provisional: false, used: false };
      setPage("found", { error: "link_invalid" satisfies SignInError });
      return;
    }
    // Saved: closing the window must not clear its partition any more.
    target = undefined;
    // The main window first: closing the last window would quit the app on Windows / Linux.
    deps.openMain(saved, true);
    closeWindow();
  }

  function onOutcome(a: Attempt, outcome: SignInOutcome): void {
    // Cancelled or replaced by the host: nothing to show.
    if (attempt !== a || target !== a.target) return;
    attempt = undefined;
    if (outcome.ok) complete(a.target, outcome.account);
    else setPage(a.from, { error: outcome.reason });
  }

  async function startSignIn(): Promise<void> {
    const t = target;
    if (!t) return;
    const from = page === "signedOut" ? "signedOut" : "found";
    if (t.discovering) {
      await t.discovering;
      if (target !== t || page !== from) return;
    }
    // Spec §6.6: refused before the browser opens when the deployment says so.
    if (t.meta && appSignInBlocked(t.meta, deps.redirectUri)) {
      setPage(from, { error: "not_allowed" satisfies SignInError });
      return;
    }
    const a: Attempt = { id: ++attemptSeq, target: t, from };
    attempt = a;
    t.used = true;
    const { url, outcome } = deps.signIn.begin(t.profile);
    void outcome.then((o) => onOutcome(a, o));
    setPage("waiting");
    try {
      await deps.openExternal(url);
    } catch (err) {
      log("could not open the browser for sign-in", err instanceof Error ? err.name : undefined);
      if (attempt !== a) return;
      endAttempt();
      setPage(from, { error: "link_invalid" satisfies SignInError });
    }
  }

  /** Only the current small window's page is listened to. */
  const fromWindow = (ctx: LocalActContext) => contents !== undefined && ctx.contents === contents;

  deps.localPages.handle("onboarding", "connect.submit", (ctx, args) => {
    const address = args.address;
    if (!fromWindow(ctx) || page !== "connect" || typeof address !== "string") return false;
    if (address.length > MAX_ADDRESS_LENGTH) return false;
    void submit(address);
    return true;
  });
  deps.localPages.handle("onboarding", "found.signIn", (ctx) => {
    if (!fromWindow(ctx) || page !== "found") return false;
    void startSignIn();
    return true;
  });
  deps.localPages.handle("onboarding", "signedOut.signIn", (ctx) => {
    if (!fromWindow(ctx) || page !== "signedOut") return false;
    void startSignIn();
    return true;
  });
  deps.localPages.handle("onboarding", "found.changeAddress", (ctx) => {
    if (!fromWindow(ctx) || page !== "found") return false;
    void dropTarget();
    setPage("connect", { prefill: fields.prefill + 1 });
    return true;
  });
  deps.localPages.handle("onboarding", "waiting.reopen", async (ctx) => {
    if (!fromWindow(ctx) || page !== "waiting" || !attempt) return false;
    const url = deps.signIn.pendingUrl(attempt.target.profile.id);
    if (!url) return false;
    await deps.openExternal(url);
    return true;
  });
  deps.localPages.handle("onboarding", "waiting.copyLink", (ctx) => {
    if (!fromWindow(ctx) || page !== "waiting" || !attempt) return false;
    const url = deps.signIn.pendingUrl(attempt.target.profile.id);
    if (!url) return false;
    deps.writeClipboard(url);
    return true;
  });
  deps.localPages.handle("onboarding", "waiting.cancel", (ctx) => {
    if (!fromWindow(ctx) || page !== "waiting") return false;
    const from = attempt?.from ?? "found";
    endAttempt();
    setPage(from);
    return true;
  });
  deps.localPages.handle("onboarding", "signedOut.addOther", (ctx) => {
    if (!fromWindow(ctx) || page !== "signedOut") return false;
    host.openConnect();
    return true;
  });
  deps.localPages.handle("onboarding", "signedOut.remove", (ctx) => {
    if (!fromWindow(ctx) || page !== "signedOut" || !target || !deps.canRemove()) return false;
    deps.removeProfile(target.profile.id);
    return true;
  });

  // Spec §6.6: a callback for a `state` this app no longer holds, from the deployment the window
  // waits for, says the link is invalid. The window ends its own attempt so the page tells the
  // truth (重新登录 starts a fresh one); the sign-in module itself never cancels on such a link.
  deps.signIn.onStaleCallback((origin) => {
    if (page !== "waiting" || !attempt || target !== attempt.target) return;
    if (origin !== attempt.target.profile.origin) return;
    const from = attempt.from;
    endAttempt();
    setPage(from, { error: "link_invalid" satisfies SignInError });
  });

  /**
   * Discovery for a saved profile shown at start or after sign-out: the meta for the pre-check and
   * the current name and icon. A failure only logs: the sign-in then runs without the pre-check.
   */
  async function refreshSaved(t: Target, signal: AbortSignal): Promise<void> {
    try {
      const result = await deps.discover(t.profile.base, signal);
      if (signal.aborted || target !== t) return;
      if (!result.ok) {
        log(`discovery of a saved platform failed (${result.error})`);
        return;
      }
      t.meta = result.meta;
      const host = hostOf(t.profile.origin);
      let iconUrl = t.platform.iconUrl;
      if (!iconUrl) {
        try {
          iconUrl = (await deps.platformIcon(t.profile, result.meta.icon)).iconUrl;
        } catch (err) {
          log("could not fetch the platform icon", err instanceof Error ? err.name : undefined);
        }
      }
      if (signal.aborted || target !== t) return;
      t.platform = {
        name: platformName(result.meta, host),
        host,
        ...(iconUrl ? { iconUrl } : {}),
      };
      push();
    } catch (err) {
      log("discovery of a saved platform failed", err instanceof Error ? err.name : undefined);
    }
  }

  function showSaved(profile: Profile, view: "signedOut" | "found"): void {
    stopDiscovery();
    if (target?.profile.id !== profile.id || target.provisional) void dropTarget();
    else endAttempt();
    const iconUrl = deps.storedIcon(profile);
    target = {
      profile,
      provisional: false,
      platform: {
        name: profile.name,
        host: hostOf(profile.origin),
        ...(iconUrl ? { iconUrl } : {}),
      },
      used: false,
    };
    const t = target;
    const abort = new AbortController();
    discovery = { seq: ++discoverySeq, abort };
    t.discovering = refreshSaved(t, abort.signal).finally(() => {
      t.discovering = undefined;
    });
    page = view;
    fields = {
      ...fields,
      error: null,
      errorHost: null,
      busy: false,
      account: profile.account ? { ...profile.account } : null,
    };
    show();
  }

  const host = {
    /**
     * The connect page (first launch, 「添加平台…」, `capybara://connect`). `prefill` replaces the
     * field's text; never submitted on its own. Leaves any other flow of the small window.
     */
    openConnect(prefill?: string): void {
      // A sign-in waiting for the browser is not thrown away by a link or a menu: focus only.
      if (page === "waiting" && win && !win.isDestroyed()) {
        show();
        return;
      }
      if (page === "connect" && win && !win.isDestroyed()) {
        if (prefill !== undefined) {
          stopDiscovery();
          discoverySeq++;
          fields = {
            ...fields,
            address: prefill,
            prefill: fields.prefill + 1,
            error: null,
            errorHost: null,
            busy: false,
          };
        }
        show();
        return;
      }
      stopDiscovery();
      void dropTarget();
      page = "connect";
      fields = {
        ...fields,
        address: prefill ?? "",
        prefill: fields.prefill + 1,
        error: null,
        errorHost: null,
        busy: false,
        account: null,
      };
      show();
    },

    /**
     * The signed-out page of a saved profile (start-up of a profile that is not signed in, the end
     * of a sign-out). 「在浏览器中重新登录」 signs in to that profile and opens its main window.
     */
    showSignedOut(profile: Profile): void {
      showSaved(profile, "signedOut");
    },

    /**
     * The found page of a saved profile that never signed in (a managed profile at start-up): the
     * same sign-in, without 「已退出」.
     */
    showFound(profile: Profile): void {
      showSaved(profile, "found");
    },

    /** A saved profile was removed: a page about it goes back to connect. */
    profileRemoved(profileId: string): void {
      if (target?.profile.id !== profileId || target.provisional) return;
      target = undefined;
      endAttempt();
      if (win) setPage("connect", { address: "", prefill: fields.prefill + 1, account: null });
    },

    /** The appearance or language changed: the window's colors follow and the page re-renders. */
    refresh(): void {
      if (!win || win.isDestroyed()) return;
      const colors = deps.colors(deps.pageBase(pageProfile()).appearance);
      try {
        win.setBackgroundColor?.(colors.background);
        win.setTitleBarOverlay?.({ color: colors.background, symbolColor: colors.symbol });
      } catch (err) {
        log("could not recolor the small window", err);
      }
      push();
    },

    /** What the small window shows now, for the menus and tests; undefined when it is closed. */
    current(): { page: OnboardingPage; profileId?: string; provisional: boolean } | undefined {
      if (!win) return undefined;
      return {
        page,
        ...(target ? { profileId: target.profile.id } : {}),
        provisional: target?.provisional ?? false,
      };
    },
  };
  return host;
}

export type Onboarding = ReturnType<typeof createOnboarding>;
