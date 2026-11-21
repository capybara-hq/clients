import type { PushPermission } from "@capybara-hq/plugin-sdk";
import { describe, expect, test, vi } from "vitest";
import { brandPush, PUSH_PROVIDERS } from "../../src/push/brand.ts";
import { createPushCapability, createPushOffers, PUSH_KEY } from "../../src/push/capability.ts";
import {
  connectPush,
  createPushRouter,
  forgetOnRemoval,
  REGISTRATIONS_PATH,
} from "../../src/push/connect.ts";
import type { PushNative } from "../../src/push/native.ts";
import { createRegistrationStore, PUSH_REGISTRATIONS_PREF_KEY } from "../../src/push/store.ts";
import type { HostPort } from "../../src/runtime/host-port.ts";
import type { PrefsPort } from "../../src/runtime/profiles.ts";
import type { ShellCallMessage } from "../../src/runtime/protocol.ts";
import { createRegistry } from "../../src/runtime/registry.ts";

const A = { id: "p1", origin: "https://a.example", base: "https://a.example" };
const B = { id: "p2", origin: "https://b.example", base: "https://b.example/capy" };
const APP_ID = "com.example.app";

function fakeNative(opts: { permission?: PushPermission; token?: string; play?: boolean } = {}) {
  let permission: PushPermission = opts.permission ?? "granted";
  let token = opts.token ?? "tok-1";
  const listeners = {
    token: new Set<(provider: string, token: string) => void>(),
    foreground: new Set<(data: Record<string, unknown>) => void>(),
    tap: new Set<(data: Record<string, unknown>) => void>(),
  };
  const on =
    <T>(set: Set<T>) =>
    (cb: T) => {
      set.add(cb);
      return () => void set.delete(cb);
    };
  const native = {
    permission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => {
      if (permission === "prompt") permission = "granted";
      return permission;
    }),
    token: vi.fn(async (_provider: string) => token),
    onToken: vi.fn(on(listeners.token)),
    onForeground: vi.fn(on(listeners.foreground)),
    onTap: vi.fn(on(listeners.tap)),
    present: vi.fn(
      async (_n: { title: string; body: string; data: Record<string, unknown> }) => {},
    ),
    googlePlayServices: vi.fn(async () => opts.play ?? false),
  } satisfies PushNative;
  return {
    native,
    setToken: (t: string) => {
      token = t;
    },
    setPermission: (p: PushPermission) => {
      permission = p;
    },
    foreground: (data: Record<string, unknown>) => {
      for (const cb of listeners.foreground) cb(data);
    },
    tap: (data: Record<string, unknown>) => {
      for (const cb of listeners.tap) cb(data);
    },
    listening: () => listeners.foreground.size + listeners.tap.size,
  };
}

function memoryPrefs(): PrefsPort & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
  };
}

const iosBuild = {
  appId: APP_ID,
  providers: [PUSH_PROVIDERS.apns],
  apns: { environment: "production" as const },
};
const metaFor = (providers: string[]) => ({ features: { push: [{ appId: APP_ID, providers }] } });

function setup(
  opts: {
    native?: ReturnType<typeof fakeNative>;
    platform?: "ios" | "android";
    build?: { appId: string; providers: readonly string[] };
    deployment?: string[];
  } = {},
) {
  const fake = opts.native ?? fakeNative();
  const prefs = memoryPrefs();
  const store = createRegistrationStore(prefs);
  const build = opts.build ?? iosBuild;
  const offers = createPushOffers(build);
  const host: HostPort = {
    onCall: () => () => {},
    reply: async () => {},
    pushState: vi.fn(async () => {}),
    event: async () => {},
  };
  const profiles = [A, B];
  const registry = createRegistry({ host, profiles: { list: () => profiles } });
  registry.register(
    PUSH_KEY,
    createPushCapability({
      native: fake.native,
      store,
      build,
      platform: opts.platform ?? "ios",
      offered: (p) => offers.providers(p),
    }),
    { available: (p) => offers.available(p) },
  );
  for (const p of profiles) offers.set(p, metaFor(opts.deployment ?? [...build.providers]));
  let n = 0;
  const call = (
    fn: string,
    args: unknown[] = [],
    activation = false,
    prof: { id: string; origin: string } = A,
  ) =>
    registry.dispatch({
      profileId: prof.id,
      origin: prof.origin,
      docId: "doc-0001-aaaa",
      callId: `c${++n}`,
      key: PUSH_KEY,
      fn,
      args,
      activation,
    } satisfies ShellCallMessage);
  return { fake, prefs, store, offers, registry, host, call };
}

const ok = (value: unknown) => ({ ok: true, value });

describe("push@1 availability", () => {
  test("offered only when the deployment lists the build's app id with a carried provider", () => {
    const { registry, offers } = setup();
    expect(registry.descriptors(A).capabilities[PUSH_KEY]).toEqual([
      "status",
      "register",
      "registered",
      "unregister",
    ]);
    offers.set(A, metaFor(["push-fcm"]));
    expect(registry.descriptors(A).capabilities[PUSH_KEY]).toBeUndefined();
    offers.set(A, null);
    expect(registry.descriptors(A).capabilities[PUSH_KEY]).toBeUndefined();
  });

  test("a profile's offer is forgotten, and does not follow it to another base", () => {
    const { registry, offers } = setup();
    expect(offers.available(A)).toBe(true);
    // Re-pointed: the same id on another deployment is not offered on the old meta.
    const moved = { ...A, origin: "https://c.example", base: "https://c.example" };
    expect(offers.available(moved)).toBe(false);
    expect(offers.providers(moved)).toEqual([]);
    expect(offers.available({ ...A, base: "https://a.example/other" })).toBe(false);
    offers.forget(A.id);
    expect(registry.descriptors(A).capabilities[PUSH_KEY]).toBeUndefined();
    expect(offers.available(B)).toBe(true);
  });

  test("register is not confirming: it needs no dialog slot", () => {
    const impl = createPushCapability({
      native: fakeNative().native,
      store: createRegistrationStore(memoryPrefs()),
      build: iosBuild,
      platform: "ios",
      offered: () => [PUSH_PROVIDERS.apns],
    });
    expect(impl.confirming ?? []).toEqual([]);
  });

  test("the official brand (no push field) yields no build, a fork's per platform", () => {
    expect(brandPush({ appId: APP_ID }, "ios")).toBeNull();
    const push = {
      apns: { environment: "production" as const },
      fcm: { googleServicesFile: "google-services.json" },
      aggregator: { appId: "j", appKey: "k" },
    };
    expect(brandPush({ appId: APP_ID, push }, "ios")?.providers).toEqual(["push-apns"]);
    expect(brandPush({ appId: APP_ID, push }, "android")?.providers).toEqual([
      "push-fcm",
      "push-jpush",
    ]);
    expect(brandPush({ appId: APP_ID, push: { apns: push.apns } }, "android")).toBeNull();
  });
});

describe("push@1.status", () => {
  test("maps the permission with no registration", async () => {
    const { call, fake } = setup({ native: fakeNative({ permission: "prompt" }) });
    expect(await call("status")).toEqual(
      ok({ permission: "prompt", registrationId: null, tokenChanged: false }),
    );
    fake.setPermission("denied");
    expect(await call("status")).toEqual(
      ok({ permission: "denied", registrationId: null, tokenChanged: false }),
    );
  });

  test("reports the registration id and whether the token changed", async () => {
    const { call, fake } = setup();
    await call("register");
    await call("registered", ["r1"]);
    expect(await call("status")).toEqual(
      ok({ permission: "granted", registrationId: "r1", tokenChanged: false }),
    );
    fake.setToken("tok-2");
    expect(await call("status")).toEqual(
      ok({ permission: "granted", registrationId: "r1", tokenChanged: true }),
    );
  });
});

describe("push@1.register", () => {
  test("prompt without a user activation rejects no_activation and asks nothing", async () => {
    const { call, fake } = setup({ native: fakeNative({ permission: "prompt" }) });
    expect(await call("register", [], false)).toEqual({ ok: false, code: "no_activation" });
    expect(fake.native.requestPermission).not.toHaveBeenCalled();
  });

  test("prompt with an activation asks the OS and resolves the registration", async () => {
    const { call, fake } = setup({ native: fakeNative({ permission: "prompt" }) });
    expect(await call("register", [], true)).toEqual(
      ok({ platform: "ios", appId: APP_ID, provider: "push-apns", token: "tok-1" }),
    );
    expect(fake.native.requestPermission).toHaveBeenCalledTimes(1);
    expect(fake.native.token).toHaveBeenCalledWith("push-apns");
  });

  test("the person refusing the OS prompt rejects cancelled", async () => {
    const fake = fakeNative({ permission: "prompt" });
    fake.native.requestPermission.mockImplementation(async () => "denied");
    const { call } = setup({ native: fake });
    expect(await call("register", [], true)).toEqual({ ok: false, code: "cancelled" });
    expect(fake.native.token).not.toHaveBeenCalled();
  });

  test("denied rejects cancelled", async () => {
    const { call, fake } = setup({ native: fakeNative({ permission: "denied" }) });
    expect(await call("register", [], true)).toEqual({ ok: false, code: "cancelled" });
    expect(fake.native.token).not.toHaveBeenCalled();
  });

  test("granted resolves without an activation and without asking", async () => {
    const { call, fake } = setup();
    expect(await call("register", [], false)).toEqual(
      ok({ platform: "ios", appId: APP_ID, provider: "push-apns", token: "tok-1" }),
    );
    expect(fake.native.requestPermission).not.toHaveBeenCalled();
  });

  test("android: FCM with Play services, the aggregator without", async () => {
    const build = { appId: APP_ID, providers: ["push-fcm", "push-jpush"] };
    const withPlay = setup({ native: fakeNative({ play: true }), platform: "android", build });
    expect(await withPlay.call("register")).toEqual(
      ok({ platform: "android", appId: APP_ID, provider: "push-fcm", token: "tok-1" }),
    );
    const without = setup({ native: fakeNative({ play: false }), platform: "android", build });
    expect(await without.call("register")).toEqual(
      ok({ platform: "android", appId: APP_ID, provider: "push-jpush", token: "tok-1" }),
    );
  });

  test("android: a channel the deployment does not cover is never picked", async () => {
    const build = { appId: APP_ID, providers: ["push-fcm", "push-jpush"] };
    const s = setup({
      native: fakeNative({ play: true }),
      platform: "android",
      build,
      deployment: ["push-jpush"],
    });
    expect(await s.call("register")).toEqual(
      ok({ platform: "android", appId: APP_ID, provider: "push-jpush", token: "tok-1" }),
    );
    const none = setup({
      native: fakeNative({ play: false }),
      platform: "android",
      build,
      deployment: ["push-fcm"],
    });
    expect(await none.call("register")).toEqual({ ok: false, code: "failed" });
  });

  test("an empty or oversized token fails", async () => {
    const { call, fake } = setup();
    fake.setToken("");
    expect(await call("register")).toEqual({ ok: false, code: "failed" });
    fake.setToken("x".repeat(4097));
    expect(await call("register")).toEqual({ ok: false, code: "failed" });
  });
});

describe("push@1.registered and unregister", () => {
  test("registered stores the id for the profile; the token itself is never stored", async () => {
    const { call, store, prefs } = setup();
    await call("register");
    expect(await call("registered", ["r1"])).toEqual(ok(null));
    expect(store.get(A.id)?.id).toBe("r1");
    expect(prefs.values.get(PUSH_REGISTRATIONS_PREF_KEY)).not.toContain("tok-1");
  });

  test("registered without a register first, or with a malformed id, fails", async () => {
    const { call, store } = setup();
    expect(await call("registered", ["r1"])).toEqual({ ok: false, code: "failed" });
    await call("register");
    for (const bad of ["", "a/b", "../x", 5, null, "x".repeat(129)]) {
      expect(await call("registered", [bad])).toEqual({ ok: false, code: "failed" });
    }
    expect(store.get(A.id)).toBeNull();
  });

  test("unregister clears only this profile's registration", async () => {
    const { call, store } = setup();
    await call("register", [], false, A);
    await call("registered", ["ra"], false, A);
    await call("register", [], false, B);
    await call("registered", ["rb"], false, B);
    expect(store.any()).toBe(true);
    expect(await call("unregister", [], false, A)).toEqual(ok(null));
    expect(store.get(A.id)).toBeNull();
    expect(store.get(B.id)?.id).toBe("rb");
    expect(store.any()).toBe(true);
  });

  test("concurrent writes for two profiles both land", async () => {
    const values = new Map<string, string>();
    const prefs: PrefsPort = {
      get: (key) => values.get(key) ?? null,
      // Each write settles a turn later, so unserialised writes would race on stale state.
      set: (key, value) =>
        new Promise<void>((resolve) =>
          queueMicrotask(() => {
            values.set(key, value);
            resolve();
          }),
        ),
    };
    const store = createRegistrationStore(prefs);
    const reg = (id: string) => ({ id, provider: "push-apns", tokenHash: "h" });
    await Promise.all([store.set(A.id, reg("ra")), store.set(B.id, reg("rb"))]);
    expect([store.get(A.id)?.id, store.get(B.id)?.id]).toEqual(["ra", "rb"]);
    const afterSet = createRegistrationStore(prefs);
    expect([afterSet.get(A.id)?.id, afterSet.get(B.id)?.id]).toEqual(["ra", "rb"]);
    await Promise.all([store.clear(A.id), store.set("p3", reg("r3"))]);
    const reloaded = createRegistrationStore(prefs);
    expect([reloaded.get(A.id), reloaded.get(B.id)?.id, reloaded.get("p3")?.id]).toEqual([
      null,
      "rb",
      "r3",
    ]);
    expect(store.get(B.id)?.id).toBe("rb");
  });

  test("the store survives a restart through its preferences", async () => {
    const { call, prefs } = setup();
    await call("register");
    await call("registered", ["r1"]);
    expect(createRegistrationStore(prefs).get(A.id)?.id).toBe("r1");
  });
});

describe("foreground, taps and removal", () => {
  const payload = { origin: B.origin, path: "/chat/c1?org=o1", threadId: "c1" };

  function router(screen: { origin: string; url: string } | null) {
    const fake = fakeNative();
    const open = vi.fn(async (_id: string, _path: string) => {});
    const screenFn = vi.fn(async () => screen);
    const r = createPushRouter({
      native: fake.native,
      profiles: () => [A, B],
      screen: screenFn,
      open,
    });
    return { fake, open, router: r, screen: screenFn };
  }

  test("a foreground push is presented as a banner", async () => {
    const { fake, router: r } = router({ origin: A.origin, url: `${A.origin}/chat/other` });
    await r.foreground({ ...payload, title: "Agent", body: "finished" });
    expect(fake.native.present).toHaveBeenCalledWith({
      title: "Agent",
      body: "finished",
      data: { ...payload, title: "Agent", body: "finished" },
    });
  });

  test("a foreground push for the page on screen is not presented", async () => {
    const {
      fake,
      router: r,
      screen,
    } = router({
      origin: B.origin,
      url: `${B.origin}/chat/c1?org=o2`,
    });
    await r.foreground({ ...payload, title: "Agent", body: "finished" });
    expect(screen).toHaveBeenCalled();
    expect(fake.native.present).not.toHaveBeenCalled();
  });

  test("a foreground push without a title or a valid payload is not presented", async () => {
    const { fake, router: r } = router(null);
    await r.foreground({ ...payload, body: "finished" });
    await r.foreground({ ...payload, origin: "https://a.example/x", title: "T", body: "B" });
    expect(fake.native.present).not.toHaveBeenCalled();
  });

  test("a tap on a second profile's origin opens that profile on the path", async () => {
    const { router: r, open } = router(null);
    await r.tap(payload);
    expect(open).toHaveBeenCalledWith(B.id, "/chat/c1?org=o1");
  });

  test("a tap for an unknown origin or a malformed payload navigates nowhere", async () => {
    const { router: r, open } = router(null);
    await r.tap({ ...payload, origin: "https://b.example.evil" });
    await r.tap({ ...payload, origin: "http://b.example" });
    await r.tap({ ...payload, path: "//evil.example" });
    expect(open).not.toHaveBeenCalled();
  });

  test("connectPush forwards native foreground pushes and taps; stopping removes them", async () => {
    const fake = fakeNative();
    const r = { foreground: vi.fn(async () => {}), tap: vi.fn(async () => {}) };
    const stop = connectPush(fake.native, r);
    expect(fake.listening()).toBe(2);
    fake.foreground({ a: 1 });
    fake.tap({ b: 2 });
    expect(r.foreground).toHaveBeenCalledWith({ a: 1 });
    expect(r.tap).toHaveBeenCalledWith({ b: 2 });
    stop();
    expect(fake.listening()).toBe(0);
  });

  test("profile removal issues the DELETE from the page before clearing", async () => {
    const { call, store } = setup();
    await call("register", [], false, B);
    await call("registered", ["rb-1"], false, B);
    const order: string[] = [];
    const deleteFromPage = vi.fn(async (_profileId: string, url: string) => {
      order.push(`delete ${url} (stored: ${store.get(B.id)?.id ?? "none"})`);
    });
    let removed: ((p: typeof B) => void | Promise<void>) | undefined;
    forgetOnRemoval({
      store,
      deleteFromPage,
      onRemoved: (listener) => {
        removed = listener;
        return () => {};
      },
    });
    await removed?.(B);
    expect(order).toEqual([
      `delete https://b.example/capy${REGISTRATIONS_PATH}/rb-1 (stored: rb-1)`,
    ]);
    expect(deleteFromPage).toHaveBeenCalledWith(B.id, expect.any(String));
    expect(store.get(B.id)).toBeNull();
  });

  test("a DELETE that never answers is cut at the deadline and the entry cleared", async () => {
    const { call, store } = setup();
    await call("register", [], false, B);
    await call("registered", ["rb-1"], false, B);
    let removed: ((p: typeof B) => void | Promise<void>) | undefined;
    let expire = () => {};
    forgetOnRemoval({
      store,
      deleteFromPage: () => new Promise<void>(() => {}),
      deadline: () => ({
        done: new Promise<void>((resolve) => {
          expire = resolve;
        }),
        cancel: () => {},
      }),
      onRemoved: (listener) => {
        removed = listener;
        return () => {};
      },
    });
    const removal = removed?.(B);
    await vi.waitFor(() => expect(store.get(B.id)).not.toBeNull());
    expire();
    await removal;
    expect(store.get(B.id)).toBeNull();
  });

  test("a failed DELETE still clears; a profile without a registration sends none", async () => {
    const { call, store } = setup();
    await call("register", [], false, B);
    await call("registered", ["rb-1"], false, B);
    const deleteFromPage = vi.fn(async () => {
      throw new Error("no page");
    });
    let removed: ((p: typeof B) => void | Promise<void>) | undefined;
    forgetOnRemoval({
      store,
      deleteFromPage,
      onRemoved: (listener) => {
        removed = listener;
        return () => {};
      },
    });
    await removed?.(B);
    expect(store.get(B.id)).toBeNull();
    await removed?.(A);
    expect(deleteFromPage).toHaveBeenCalledTimes(1);
  });
});
