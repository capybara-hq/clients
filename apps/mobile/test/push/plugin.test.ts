import { describe, expect, test, vi } from "vitest";
import { type PushPlugin, pushNativeFrom } from "../../src/push/plugin.ts";

function fakePlugin(answers: Partial<Record<keyof PushPlugin, unknown>> = {}) {
  const answer = (key: keyof PushPlugin, fallback: unknown) =>
    key in answers ? answers[key] : fallback;
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const removed: string[] = [];
  const plugin: PushPlugin = {
    permission: vi.fn(async () => answer("permission", { permission: "granted" })),
    requestPermission: vi.fn(async () => answer("requestPermission", { permission: "granted" })),
    token: vi.fn(async () => answer("token", { token: "ab01" })),
    present: vi.fn(async () => {}),
    googlePlayServices: vi.fn(async () => answer("googlePlayServices", { available: false })),
    addListener: vi.fn(async (event: string, listener: (e: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return {
        remove: async () => {
          set.delete(listener);
          removed.push(event);
        },
      };
    }),
  };
  const emit = (event: string, e: unknown) => {
    for (const l of listeners.get(event) ?? []) l(e);
  };
  return { plugin, emit, removed };
}

describe("pushNativeFrom", () => {
  test("maps permissions and treats anything else as denied", async () => {
    expect(await pushNativeFrom(fakePlugin().plugin).permission()).toBe("granted");
    const prompt = fakePlugin({ permission: { permission: "prompt" } }).plugin;
    expect(await pushNativeFrom(prompt).permission()).toBe("prompt");
    for (const bad of [{ permission: "maybe" }, {}, null, "granted"]) {
      const { plugin } = fakePlugin({ permission: bad, requestPermission: bad });
      expect(await pushNativeFrom(plugin).permission()).toBe("denied");
      expect(await pushNativeFrom(plugin).requestPermission()).toBe("denied");
    }
  });

  test("asks for the token of the provider and refuses a malformed answer", async () => {
    const { plugin } = fakePlugin();
    expect(await pushNativeFrom(plugin).token("push-apns")).toBe("ab01");
    expect(plugin.token).toHaveBeenCalledWith({ provider: "push-apns" });
    await pushNativeFrom(plugin).token("push-fcm", { exclusive: true });
    expect(plugin.token).toHaveBeenLastCalledWith({ provider: "push-fcm", exclusive: true });
    for (const bad of [{ token: "" }, { token: 7 }, {}, null]) {
      const native = pushNativeFrom(fakePlugin({ token: bad }).plugin);
      await expect(native.token("push-apns")).rejects.toThrow("no push token");
    }
  });

  test("googlePlayServices is true only for a real true", async () => {
    expect(await pushNativeFrom(fakePlugin().plugin).googlePlayServices()).toBe(false);
    const yes = fakePlugin({ googlePlayServices: { available: true } }).plugin;
    expect(await pushNativeFrom(yes).googlePlayServices()).toBe(true);
    const odd = fakePlugin({ googlePlayServices: { available: "true" } }).plugin;
    expect(await pushNativeFrom(odd).googlePlayServices()).toBe(false);
  });

  test("forwards events, drops malformed ones and stops on request", async () => {
    const { plugin, emit, removed } = fakePlugin();
    const native = pushNativeFrom(plugin);
    const taps: unknown[] = [];
    const foreground: unknown[] = [];
    const tokens: [string, string][] = [];
    const stopTap = native.onTap((d) => taps.push(d));
    native.onForeground((d) => foreground.push(d));
    native.onToken((p, t) => tokens.push([p, t]));
    emit("tap", { path: "/x", origin: "https://a.example" });
    emit("tap", "not an object");
    emit("foreground", { title: "T" });
    emit("token", { provider: "push-apns", token: "cd" });
    emit("token", { provider: "push-apns" });
    expect(taps).toEqual([{ path: "/x", origin: "https://a.example" }]);
    expect(foreground).toEqual([{ title: "T" }]);
    expect(tokens).toEqual([["push-apns", "cd"]]);
    stopTap();
    emit("tap", { path: "/y" });
    expect(taps).toHaveLength(1);
    await vi.waitFor(() => expect(removed).toEqual(["tap"]));
  });

  test("present passes the banner through", async () => {
    const { plugin } = fakePlugin();
    const banner = { title: "T", body: "B", data: { path: "/x" } };
    await pushNativeFrom(plugin).present(banner);
    expect(plugin.present).toHaveBeenCalledWith(banner);
  });
});
