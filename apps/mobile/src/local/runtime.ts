// The runtime's document (index.html in Capacitor's own WebView, mobile spec §5.3, decision 5). It
// stays loaded while the app runs: it holds the capability registry and the loader, answers the
// gated calls native forwards from profile WebViews, and frames local pages (the error state, the
// address page) over itself: it never navigates. Local pages it frames talk to it over a
// MessageChannel port it hands each of them on the local origin (src/runtime/local-frames.ts).
// Only node-free code is bundled here.
//
// Start: `startRoute` picks the profile to open or the address page (a debug build launched by a
// UI test opens the test's loopback origin instead, or the address page over an empty in-memory
// profile list). Managed configuration (src/runtime/managed.ts) decides which profiles are
// visible; the gates that follow from it (listing, switching, adding, what stays on screen and
// alive natively) live in src/runtime/profile-access.ts, and this file only wires them. The
// address page discovers and adds a deployment through this document
// (src/runtime/address-bridge.ts), then it opens and its Sign in starts the browser sign-in for it
// (src/runtime/sign-in.ts). Each profile opened is asked for its meta: a deployment too old for
// app sign-in gets the too-old state and no signIn@1. A build whose brand carries push gets push@1
// on the profiles whose meta lists its app id (src/push); the official build never does.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Haptics, NotificationType } from "@capacitor/haptics";
import { Preferences } from "@capacitor/preferences";
import { Share } from "@capacitor/share";
import { SplashScreen } from "@capacitor/splash-screen";
import type { Locale } from "@capybara-hq/shell";
import { brand } from "../../brand.ts";
import { brandPush } from "../push/brand.ts";
import { createPushCapability, createPushOffers, PUSH_KEY } from "../push/capability.ts";
import { connectPush, createPushRouter, forgetOnRemoval } from "../push/connect.ts";
import {
  currentUrlFrom,
  type PushHostNative,
  type PushNative,
  unsupportedPushNative,
} from "../push/native.ts";
import { PUSH_PLUGIN_NAME, type PushPlugin, pushNativeFrom } from "../push/plugin.ts";
import {
  createRegistrationStore,
  PUSH_REGISTRATIONS_PREF_KEY,
  type RegistrationStore,
} from "../push/store.ts";
import { createAddressHost, isAddressPageMessage } from "../runtime/address-bridge.ts";
import { createAppearanceStore } from "../runtime/appearance.ts";
import { createChrome } from "../runtime/capabilities/chrome.ts";
import { registerMobileCapabilities } from "../runtime/capabilities/index.ts";
import {
  MENU_HOST_PLUGIN_NAME,
  type MenuHostPlugin,
  menuHostPortFrom,
} from "../runtime/capabilities/menu.ts";
import {
  connectStrip,
  createNav,
  navNativeFrom,
  type StripHostPlugin,
  stripAtStart,
} from "../runtime/capabilities/nav.ts";
import { openExternalPortFrom } from "../runtime/capabilities/open-external.ts";
import { createProfilesCapability, PROFILES_KEY } from "../runtime/capabilities/profiles.ts";
import { type HttpGetNative, httpGetPortFrom, startRoute } from "../runtime/discovery.ts";
import { type ErrorStateMessage, isErrorPageMessage } from "../runtime/error-page.ts";
import {
  type CapybaraHostPlugin,
  createHostPort,
  createProfileHostPort,
  HOST_PLUGIN_NAME,
  type ProfileHostPlugin,
} from "../runtime/host-port.ts";
import { createLoader, type ErrorState, type LoaderProfile } from "../runtime/loader.ts";
import { createLocalFrames, type FrameHandle, type LocalPage } from "../runtime/local-frames.ts";
import {
  createManagedPolicy,
  MANAGED_CONFIG_PLUGIN,
  type ManagedConfigNative,
  type ManagedPolicy,
  managedSourceFrom,
} from "../runtime/managed.ts";
import { type AppUrlPlugin, connectOpenLinks, createOpenLinkRouter } from "../runtime/open-link.ts";
import { createProfileAccess, type ProfileAccess } from "../runtime/profile-access.ts";
import {
  createProfileStore,
  DATA_STORES_PLUGIN,
  type DataStoresNative,
  dataStorePortFrom,
  PROFILES_PREF_KEY,
  type PrefsPort,
  type ProfileStore,
  preloadPrefs,
} from "../runtime/profiles.ts";
import { createRegistry, serveCalls } from "../runtime/registry.ts";
import {
  appInfoFrom,
  createSignIn,
  createSignInSupport,
  randomState,
  type SignInNative,
  signInPortsFrom,
} from "../runtime/sign-in.ts";
import { removeBlockRulesOnRemoval } from "../runtime/sign-in-block.ts";
import { createSplash } from "../runtime/splash.ts";

/**
 * Debug builds launched by a device test: the loopback origin and the page to open there, or
 * (`testAddress`) start on the address page with an empty profile list kept in memory.
 */
interface LaunchOptions {
  testOrigin?: string;
  testBase?: string;
  testAddress?: boolean;
}

type HostPlugin = CapybaraHostPlugin &
  ProfileHostPlugin &
  HttpGetNative &
  SignInNative &
  StripHostPlugin &
  AppUrlPlugin &
  PushHostNative & {
    removeBlockRules(options: { profileId: string }): Promise<void>;
    launchOptions(): Promise<LaunchOptions>;
    openExternal(options: { url: string }): Promise<void>;
  };

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
    post: (message, transfer) =>
      frame.contentWindow?.postMessage(message, location.origin, transfer),
    onLoad: (listener) => frame.addEventListener("load", listener),
    path: () => {
      try {
        return frame.contentWindow?.location.pathname ?? null;
      } catch {
        return null;
      }
    },
    remove: () => frame.remove(),
  };
}

/** Preferences that live only as long as this document (the address UI test). */
function memoryPrefs(): PrefsPort {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
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
  const platform = Capacitor.getPlatform() === "android" ? "android" : "ios";
  // push@1: only a build whose brand carries a channel on this platform (K4's brand `push`).
  // The CapybaraPush plugin: iOS over APNs (Push/PushBridge.swift), Android over FCM and JPush
  // (push/PushModule.kt); the stand-in for a build without push.
  const pushBuild = brandPush(brand, platform);
  const pushNative: PushNative = pushBuild
    ? pushNativeFrom(registerPlugin<PushPlugin>(PUSH_PLUGIN_NAME))
    : unsupportedPushNative;
  let pushStore: RegistrationStore | null = null;

  let list: () => LoaderProfile[];
  let profiles: ProfileStore | null = null;
  let managed: ManagedPolicy | null = null;
  // The lock gates; made once the loader exists (policy changes before that wait in `start`).
  let access: ProfileAccess | null = null;
  let switchTo: (id: string) => Promise<LoaderProfile | null>;
  let start: Promise<"address" | { profileId: string }>;
  if (options.testOrigin && options.testBase && !options.testAddress) {
    await stores.create(TEST_STORE_ID);
    const test: LoaderProfile = {
      id: "uitest",
      origin: options.testOrigin,
      base: options.testBase,
      dataStoreId: TEST_STORE_ID,
      name: "UI test",
    };
    list = () => [test];
    switchTo = async () => test;
    start = Promise.resolve({ profileId: test.id });
  } else {
    // The address UI test starts with no profile and keeps none; its one store id is fixed.
    const prefs = options.testAddress
      ? memoryPrefs()
      : await preloadPrefs(backend, [PROFILES_PREF_KEY, PUSH_REGISTRATIONS_PREF_KEY]);
    const store = createProfileStore({
      prefs,
      stores,
      confirm: async (text) => window.confirm(text.message),
      newId: options.testAddress ? () => TEST_STORE_ID : () => crypto.randomUUID(),
      now: () => Date.now(),
      locale,
    });
    profiles = store;
    removeBlockRulesOnRemoval(store, plugin);
    if (pushBuild) {
      // Before the lock gates close the removed profile's WebView: the DELETE runs in its page.
      pushStore = createRegistrationStore(prefs);
      forgetOnRemoval({
        store: pushStore,
        deleteFromPage: async (profileId, url) => {
          await plugin.pushDeleteRegistration({ profileId, url });
        },
        onRemoved: (listener) => store.onRemoved(listener),
      });
    }
    const policy = await createManagedPolicy({
      brand,
      source: managedSourceFrom(registerPlugin<ManagedConfigNative>(MANAGED_CONFIG_PLUGIN)),
      profiles: store,
      changed: () => access?.reconcile(),
      log: (message) => console.warn(`[managed] ${message}`),
    });
    managed = policy;
    list = () => access?.list() ?? policy.visible();
    switchTo = async (id) => (access ? access.switchTo(id) : null);
    start = startRoute(brand, policy.values(), store);
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
  const httpGet = httpGetPortFrom(plugin);
  // Android: Play services decide the channel (pickAndroidProvider); read once for the offers.
  const googlePlayServices =
    pushBuild && platform === "android"
      ? await pushNative.googlePlayServices().catch(() => false)
      : false;
  const pushOffers = pushBuild
    ? createPushOffers(pushBuild, { platform, googlePlayServices })
    : null;
  // A removed profile's offer goes with it (a re-pointed one is not matched, see PushOffers).
  if (pushOffers) profiles?.onRemoved((p) => pushOffers.forget(p.id));
  const support = createSignInSupport({
    httpGet,
    onTooOld: (id) => loader?.tooOld(id),
    // The meta read on each open says whether the deployment covers this build for push.
    onMeta: (profile, meta) => {
      if (!pushOffers) return;
      pushOffers.set(profile, meta);
      registry.refresh(profile.id);
    },
  });
  const info = await appInfoFrom(plugin);
  const signIn = createSignIn<LoaderProfile>({
    ...signInPortsFrom(plugin),
    deviceName: info.deviceName,
    appVersion: info.appVersion,
    now: () => Date.now(),
    newState: randomState,
    scheme: brand.scheme,
    // The stored profiles now: an attempt ends when its profile is removed or re-pointed.
    profiles: { list: () => list() },
  });
  // nav@1: iOS only, offered while the window has a strip (StripDetector.swift); native reports
  // each change of the strip and its side, and the registry tells the shown page with one `change`.
  const nav = createNav<LoaderProfile>({
    registry,
    native: navNativeFrom(plugin),
    profiles: () => list(),
    shown: () => loader?.shown() ?? null,
    strip: false,
  });
  if (platform === "ios") {
    // Listen first, then ask: a change between the two is not lost.
    connectStrip(plugin, nav);
    const start = await stripAtStart(plugin);
    nav.stripChanged(start.visible, start.side);
  }
  registerMobileCapabilities(registry, {
    signIn: { capability: signIn.capability, available: (p) => support.available(p) },
    chrome: createChrome({
      appearance,
      native: { setAppearance: (id, look) => profileHost.setAppearance(id, look) },
      ready: (id) => loader?.ready(id),
    }),
    haptics: Haptics,
    share: Share,
    menu: menuHostPortFrom(registerPlugin<MenuHostPlugin>(MENU_HOST_PLUGIN_NAME), locale),
    openExternal: openExternalPortFrom(plugin),
    returnScheme: brand.scheme,
    platform,
    nav,
  });
  if (pushBuild && pushStore && pushOffers) {
    const offers = pushOffers;
    registry.register(
      PUSH_KEY,
      createPushCapability({
        native: pushNative,
        store: pushStore,
        build: pushBuild,
        platform,
        offered: (profile) => offers.providers(profile),
      }),
      { available: (profile) => offers.available(profile) },
    );
  }
  serveCalls(host, registry);

  // Local pages are framed over this document, never navigated to (I4); each talks over its port.
  let onPageMessage: (page: LocalPage, data: unknown) => void = () => {};
  const frames = createLocalFrames({
    create: (src) => iframe(src, src.split("/")[0] ?? src),
    onMessage: (page, data) => onPageMessage(page, data),
  });
  let errorState: ErrorState | null = null;
  const sendErrorState = () => {
    if (!errorState || frames.current() !== "error") return;
    const message: ErrorStateMessage = { type: "error-state", state: errorState, locale: locale() };
    frames.post(message);
  };
  // Resolves whether it opened. Every open asks the deployment whether it can do app sign-in
  // (the loader's `opened`; too old: the too-old state), whoever opened it.
  const openProfile = async (id: string): Promise<boolean> => {
    const next = await switchTo(id);
    if (!next) return false;
    await loader?.open(next);
    return true;
  };
  const showError = () => frames.show("error", "error/index.html");
  const address = createAddressHost({
    httpGet,
    lockedBase: () => {
      const policy = managed?.policy();
      return policy?.locked ? policy.presetUrl : null;
    },
    add: async (found) => {
      if (!access) throw new Error("no profile store");
      return access.add(found);
    },
    // The person tapped Sign in: the deployment opens under the browser sign-in, which signs it
    // in (or leaves the web's own sign-in page with signIn@1 when they cancel).
    opened: (profileId) => {
      frames.hide();
      void openProfile(profileId)
        .then((opened) => (opened ? signIn.begin(profileId) : undefined))
        .catch(() => {});
    },
    closed: () => (errorState ? showError() : frames.hide()),
    post: (message) => {
      if (frames.current() === "address") frames.post(message);
    },
  });
  const showAddress = () => {
    if (frames.current() === "address") return;
    address.reset();
    // Back goes to the error page; with nothing to go back to the page offers no back.
    frames.show("address", errorState ? "address/index.html?back=1" : "address/index.html");
  };
  onPageMessage = (page, data) => {
    if (page === "error" && isErrorPageMessage(data)) {
      if (data.type === "error-page-ready") sendErrorState();
      else if (data.action === "open") void openProfile(data.profileId).catch(() => {});
      else if (data.action === "retry") void loader?.retry();
      else showAddress();
    } else if (page === "address" && isAddressPageMessage(data)) {
      address.handle(data).catch(() => {});
    }
  };
  const errorView = {
    show(state: ErrorState) {
      errorState = state;
      showError();
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
    opened: (profile) => {
      void support.check(profile);
      nav.profileShown(profile.id);
    },
  });

  const toAddress = () => {
    splash.failed();
    showAddress();
  };
  if (profiles && managed) {
    access = createProfileAccess({
      store: profiles,
      policy: managed,
      loader,
      showAddress: toAddress,
    });
  }

  if (profiles && managed && access) {
    const [store, policy, gate] = [profiles, managed, access];
    registry.register(
      PROFILES_KEY,
      createProfilesCapability({
        profiles: store,
        visible: () => gate.list(),
        menu: menuHostPortFrom(registerPlugin<MenuHostPlugin>(MENU_HOST_PLUGIN_NAME), locale),
        openAddress: async () => showAddress(),
        policy: () => policy.policy(),
        switchTo: (id) => gate.switchTo(id),
        haptic: () => {
          Haptics.notification({ type: NotificationType.Warning }).catch(() => {});
        },
        afterSwitch: async (profile) => {
          await loader?.open(profile);
        },
        // The removed profile's WebView closed with it: show the next visible one, else the address.
        afterRemove: async () => {
          const next = gate.list().find((p) => p.id === store.current()?.id) ?? gate.list()[0];
          if (!next) return showAddress();
          if (store.current()?.id !== next.id && (await store.setCurrent(next.id)) !== "switched") {
            return showAddress();
          }
          await loader?.open(next);
        },
        locale,
      }),
      { available: () => !policy.policy().locked },
    );
  }

  const route = await start;
  if (access) {
    // Changes received during start are applied first; a hidden route falls back.
    const first = await access.start(route);
    if (first?.open) await loader.open(first.profile);
    else if (!first) toAddress();
  } else {
    const first = route === "address" ? null : list().find((p) => p.id === route.profileId);
    if (first) await loader.open(first);
    else toAddress();
  }
  if (pushBuild && access) {
    // After the first screen: a tap that launched the app opens its profile over the start one.
    const [gate, shownLoader] = [access, loader];
    connectPush(
      pushNative,
      createPushRouter({
        native: pushNative,
        profiles: () => gate.list(),
        screen: async () => {
          const id = shownLoader.shown();
          const profile = id === null ? undefined : list().find((p) => p.id === id);
          if (!profile) return null;
          const url = await currentUrlFrom(plugin, profile.id);
          return url === null ? null : { origin: profile.origin, url };
        },
        open: async (id, path) => {
          const next = await gate.switchTo(id);
          if (next) await shownLoader.open(next, { path });
        },
      }),
    );
  }
  if (access) {
    // After the first screen: `<scheme>://open?url=` (the browser's way back after a connector
    // OAuth or a login linking) opens its page on the visible profile of exactly that origin.
    // Native holds a link that launched the app until this listener attaches.
    const [gate, shownLoader] = [access, loader];
    connectOpenLinks(
      plugin,
      createOpenLinkRouter({
        scheme: brand.scheme,
        profiles: () => gate.list(),
        open: async (id, path) => {
          const next = await gate.switchTo(id);
          if (next) await shownLoader.open(next, { path });
        },
      }),
    );
  }
  // Orphaned stores of earlier removals whose native deletion failed; after the first screen, so
  // a slow native removal never holds up the launch.
  void profiles?.sweep().catch(() => {});
}

main().catch(() => {
  SplashScreen.hide().catch(() => {});
});
