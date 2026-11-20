// The runtime's document (index.html in Capacitor's own WebView, mobile spec §5.3, decision 5). It
// stays loaded while the app runs: it holds the capability registry and the loader, answers the
// gated calls native forwards from profile WebViews, and frames the local error page over itself
// when a profile cannot load. Local pages it frames talk to it with postMessage on the local
// origin only. Only node-free code is bundled here.
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

function errorFrame(onAction: (m: unknown) => void) {
  let frame: HTMLIFrameElement | null = null;
  let pending: ErrorState | null = null;
  const send = () => {
    if (!frame?.contentWindow || !pending) return;
    const message: ErrorStateMessage = { type: "error-state", state: pending, locale: locale() };
    frame.contentWindow.postMessage(message, location.origin);
  };
  window.addEventListener("message", (event) => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin) return;
    if (!isErrorPageMessage(event.data)) return;
    if (event.data.type === "error-page-ready") send();
    else onAction(event.data);
  });
  return {
    show(state: ErrorState) {
      pending = state;
      if (frame) return send();
      frame = document.createElement("iframe");
      frame.src = "error/index.html";
      frame.title = "error";
      frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;";
      document.body.append(frame);
    },
    hide() {
      pending = null;
      frame?.remove();
      frame = null;
    },
  };
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

  const errorView = errorFrame((message) => {
    if (!isErrorPageMessage(message) || message.type !== "error-action") return;
    if (message.action === "open") {
      void switchTo(message.profileId).then((next) => {
        if (next) void loader?.open(next);
      });
    } else if (message.action === "retry") {
      void loader?.retry();
    } else {
      location.href = "address/index.html";
    }
  });
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
