// Loading a profile (mobile spec §4.4): the stored appearance goes to native first, so the launch
// shows the theme's background, then native opens the profile WebView on its base. Native's load
// events drive the splash (`loaded` starts its 3 s fallback) and the error state: a main-frame
// failure before anything committed (DNS, connection, TLS) or a dead web process hides the
// WebView and shows the local error page with retry and the profile switcher, never the WebView's
// own error page; an HTTP error page from the deployment (a 500) is a page and stays.
//
// Documents (Task 13 review M3, M7): when a profile document says hello native reports `opened`
// and the loader pushes the current state again (the init baked into the document-start script
// is the state at WebView creation); when it ends the registry cancels that profile's calls.
import type { ShellState } from "@capybara-hq/shell";
import { type AppearanceStore, nativeLook } from "./appearance.ts";
import type { DocumentEvent, HostPort, LoadEvent, ProfileHostPort } from "./host-port.ts";
import type { ProfileRef } from "./protocol.ts";
import type { CapabilityRegistry } from "./registry.ts";
import { blockRulesFor } from "./sign-in-block.ts";
import type { Splash } from "./splash.ts";

/** The fields of a profile the loader reads (Task 14's `Profile` has them). */
export interface LoaderProfile extends ProfileRef {
  base: string;
  dataStoreId: string;
  name: string | null;
}

/** `too_old`: the deployment's meta has no `features.appSignIn` (mobile spec §4.3). */
export type ErrorKind = "unreachable" | "tls" | "crashed" | "wipe_owed" | "too_old";

/** What the error page shows; it is a local page, so it learns only these values. */
export interface ErrorState {
  kind: ErrorKind;
  profileId: string;
  host: string;
  /** Native's error code, shown small for support; absent for a crash. */
  code?: string;
  /** The switcher: every profile, the failing one current. */
  profiles: { id: string; label: string; current: boolean }[];
}

export interface ErrorView {
  show(state: ErrorState): void;
  hide(): void;
}

export interface Loader {
  open(profile: LoaderProfile): Promise<void>;
  /** `chrome@1.ready()` from a profile: drops the splash when it is the profile shown. */
  ready(profileId: string): void;
  /** The error page's retry: opens the shown profile again. */
  retry(): Promise<void>;
  /**
   * The profile's deployment is too old for app sign-in (`SignInSupport`): its capabilities are
   * pushed again (no signIn@1) and, when it is the profile shown, the too-old state shows.
   */
  tooOld(profileId: string): void;
  stop(): void;
}

export interface LoaderDeps<P extends LoaderProfile> {
  host: ProfileHostPort;
  /** The call port, for state pushes. */
  calls: HostPort;
  registry: CapabilityRegistry<P>;
  appearance: AppearanceStore;
  splash: Splash;
  errorView: ErrorView;
  /** Every profile, for the error page's switcher. */
  profiles(): LoaderProfile[];
}

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

function hostOf(profile: LoaderProfile): string {
  try {
    return new URL(profile.origin).host;
  } catch {
    return profile.origin;
  }
}

export function createLoader<P extends LoaderProfile>(deps: LoaderDeps<P>): Loader {
  let shown: P | null = null;

  const stateOf = (profile: P): ShellState => {
    const { capabilities, events } = deps.registry.descriptors(profile);
    return { insets: { ...NO_INSETS }, capabilities, events };
  };

  const showError = (kind: ErrorKind, code?: string) => {
    if (!shown) return;
    const failing = shown;
    deps.host.showError(failing.id).catch(() => {});
    deps.errorView.show({
      kind,
      profileId: failing.id,
      host: hostOf(failing),
      ...(code !== undefined ? { code } : {}),
      profiles: deps.profiles().map((p) => ({
        id: p.id,
        label: p.name ?? hostOf(p),
        current: p.id === failing.id,
      })),
    });
    deps.splash.failed();
  };

  const onLoad = (e: LoadEvent) => {
    if (!shown || e.profileId !== shown.id) return;
    if (e.type === "didFinish") deps.splash.loaded();
    else if (e.type === "didFailProvisional") showError(e.tls ? "tls" : "unreachable", e.code);
    else showError("crashed");
  };

  const onDocument = (e: DocumentEvent) => {
    if (e.state === "ended") {
      deps.registry.endDocument(e.profileId);
      return;
    }
    const profile = deps.profiles().find((p) => p.id === e.profileId) as P | undefined;
    if (profile) deps.calls.pushState(profile.id, stateOf(profile)).catch(() => {});
  };

  const stops = [deps.host.onLoad(onLoad), deps.host.onDocument(onDocument)];

  const open = async (profile: P) => {
    shown = profile;
    deps.errorView.hide();
    const stored = await deps.appearance.load(profile.id);
    if (stored) await deps.host.setAppearance(profile.id, nativeLook(stored)).catch(() => {});
    try {
      await deps.host.open({
        profileId: profile.id,
        origin: profile.origin,
        base: profile.base,
        dataStoreId: profile.dataStoreId,
        state: stateOf(profile),
        blockRules: blockRulesFor(profile.base),
      });
    } catch (err) {
      // Android single store: the wipe of the previous deployment's data is still owed, so native
      // loads nothing. Opening again (retry) retries the wipe first.
      if (err instanceof Error && err.message === "wipe_owed") return showError("wipe_owed");
      throw err;
    }
  };

  return {
    open: (profile) => open(profile as P),
    ready(profileId) {
      if (shown?.id === profileId) deps.splash.ready();
    },
    async retry() {
      if (shown) await open(shown);
    },
    tooOld(profileId) {
      const profile = deps.profiles().find((p) => p.id === profileId) as P | undefined;
      if (profile) deps.calls.pushState(profile.id, stateOf(profile)).catch(() => {});
      if (shown?.id === profileId) showError("too_old");
    },
    stop() {
      for (const stop of stops) stop();
    },
  };
}
