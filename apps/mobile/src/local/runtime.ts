// The runtime's document (index.html in Capacitor's own WebView, mobile spec §5.3, decision 5). It
// stays loaded while the app runs: it holds the capability registry and the loader, answers the
// gated calls native forwards from profile WebViews, and frames local pages (the error state, the
// address page) over itself: it never navigates. Local pages it frames talk to it with
// postMessage on the local origin only. Only node-free code is bundled here.
//
// Start: the current profile opens (a debug build launched by a UI test opens the test's loopback
// origin instead). With no profile yet the splash drops; the address page (Task 15) takes over.
import { registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { SplashScreen } from "@capacitor/splash-screen";
import type { Locale } from "@capybara-hq/shell";
import { createAppearanceStore } from "../runtime/appearance.ts";
import { CHROME_CAPABILITY_KEY, createChrome } from "../runtime/capabilities/chrome.ts";
import { type ErrorStateMessage, isErrorPageMessage } from "../runtime/error-page.ts";
import {
  type CapybaraHostPlugin,
  createHostPort,
  createProfileHostPort,
  HOST_PLUGIN_NAME,
  type ProfileHostPlugin,
} from "../runtime/host-port.ts";
import { createLoader, type ErrorState, type LoaderProfile } from "../runtime/loader.ts";
import { createLocalFrames, type FrameHandle } from "../runtime/local-frames.ts";
import {
  createProfileStore,
  DATA_STORES_PLUGIN,
  type DataStoresNative,
  dataStorePortFrom,
  PROFILES_PREF_KEY,
  preloadPrefs,
} from "../runtime/profiles.ts";
import { createRegistry, serveCalls } from "../runtime/registry.ts";
import { createSplash } from "../runtime/splash.ts";

/** Debug builds launched by a device test: the loopback origin and the page to open there. */
interface LaunchOptions {
  testOrigin?: string;
  testBase?: string;
}

type HostPlugin = CapybaraHostPlugin &
  ProfileHostPlugin & { launchOptions(): Promise<LaunchOptions> };

/** The fixed store of the UI test's loopback profile (debug builds only ever open it). */
const TEST_STORE_ID = "6d0c6e2b-1f4a-4c1e-9b7e-0a11e5a7e514";

const locale = (): Locale => (navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en");

/** A framed local page over this document (src/runtime/local-frames.ts). */
function iframe(src: string, title: string): FrameHandle {
  const frame = document.createElement("iframe");
  frame.src = src;
  frame.title = title;
  frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;";
  document.body.append(frame);
  return {
    window: frame.contentWindow,
    post: (message) => frame.contentWindow?.postMessage(message, location.origin),
    remove: () => frame.remove(),
  };
}

/**
 * The address page's messages to the runtime (Task 15 adopts them when it is framed here):
 * `address-close` goes back to what showed before, `address-added` opens the new profile.
 */
type AddressPageMessage = { type: "address-close" } | { type: "address-added"; profileId: string };

function isAddressPageMessage(v: unknown): v is AddressPageMessage {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.type === "address-close" || (r.type === "address-added" && typeof r.profileId === "string")
  );
}

async function main(): Promise<void> {
  const plugin = registerPlugin<HostPlugin>(HOST_PLUGIN_NAME);
  const host = createHostPort(plugin);
  const profileHost = createProfileHostPort(plugin);
  const backend = {
    get: async (key: string) => (await Preferences.get({ key })).value,
    set: (key: string, value: string) => Preferences.set({ key, value }),
  };
  const stores = dataStorePortFrom(registerPlugin<DataStoresNative>(DATA_STORES_PLUGIN));
  const options = await plugin.launchOptions().catch((): LaunchOptions => ({}));

  let list: () => LoaderProfile[];
  let current: LoaderProfile | null;
  let switchTo: (id: string) => Promise<LoaderProfile | null>;
  if (options.testOrigin && options.testBase) {
    await stores.create(TEST_STORE_ID);
    const test: LoaderProfile = {
      id: "uitest",
      origin: options.testOrigin,
      base: options.testBase,
      dataStoreId: TEST_STORE_ID,
      name: "UI test",
    };
    list = () => [test];
    current = test;
    switchTo = async () => test;
  } else {
    const prefs = await preloadPrefs(backend, [PROFILES_PREF_KEY]);
    const profiles = createProfileStore({
      prefs,
      stores,
      confirm: async (text) => window.confirm(text.message),
      newId: () => crypto.randomUUID(),
      now: () => Date.now(),
      locale,
    });
    list = () => profiles.list();
    current = profiles.current();
    switchTo = async (id) =>
      (await profiles.setCurrent(id)) === "switched" ? profiles.current() : null;
  }

  const registry = createRegistry<LoaderProfile>({ host, profiles: { list: () => list() } });
  const splash = createSplash({
    hide: () => {
      SplashScreen.hide().catch(() => {});
    },
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  });
  const appearance = createAppearanceStore(backend);
  let loader: ReturnType<typeof createLoader> | undefined;
  registry.register(
    CHROME_CAPABILITY_KEY,
    createChrome({
      appearance,
      native: { setAppearance: (id, look) => profileHost.setAppearance(id, look) },
      ready: (id) => loader?.ready(id),
    }),
  );
  serveCalls(host, registry);

  // Local pages are framed over this document, never navigated to (I4).
  const frames = createLocalFrames({ create: (src) => iframe(src, src.split("/")[0] ?? src) });
  let errorState: ErrorState | null = null;
  const sendErrorState = () => {
    if (!errorState || frames.current() !== "error") return;
    const message: ErrorStateMessage = { type: "error-state", state: errorState, locale: locale() };
    frames.post(message);
  };
  const openProfile = (id: string) =>
    void switchTo(id).then((next) => {
      if (next) void loader?.open(next);
    });
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    const page = frames.sourceOf(event.source);
    if (page === "error" && isErrorPageMessage(event.data)) {
      const m = event.data;
      if (m.type === "error-page-ready") sendErrorState();
      else if (m.action === "open") openProfile(m.profileId);
      else if (m.action === "retry") void loader?.retry();
      else frames.show("address", "address/index.html");
    } else if (page === "address" && isAddressPageMessage(event.data)) {
      const m = event.data;
      if (m.type === "address-added") {
        frames.hide();
        openProfile(m.profileId);
      } else if (errorState) {
        frames.show("error", "error/index.html");
      } else {
        frames.hide();
      }
    }
  });
  const errorView = {
    show(state: ErrorState) {
      errorState = state;
      frames.show("error", "error/index.html");
      sendErrorState();
    },
    hide() {
      errorState = null;
      frames.hide();
    },
  };
  loader = createLoader({
    host: profileHost,
    calls: host,
    registry,
    appearance,
    splash,
    errorView,
    profiles: () => list(),
  });

  if (current) await loader.open(current);
  else splash.failed();
}

main().catch(() => {
  SplashScreen.hide().catch(() => {});
});
