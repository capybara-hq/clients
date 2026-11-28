import { sameOriginUrl } from "@capybara-hq/shell";
import { describe, expect, test, vi } from "vitest";
import {
  createChromeCapability,
  createNotifyCapability,
  createOpenExternalCapability,
  openExternalOptions,
} from "../src/main/capabilities.ts";
import { createShellBridge } from "../src/main/ipc.ts";
import type { Profile } from "../src/main/profiles.ts";
import type { Appearance } from "../src/shared/appearance.ts";

const profile: Profile = {
  id: "p1",
  signedIn: true,
  base: "https://capybara.example.com/team",
  origin: "https://capybara.example.com",
  name: "Example",
};

function fakeNotificationClass() {
  const instances: {
    opts: { title: string; body: string };
    show: ReturnType<typeof vi.fn>;
    click(): void;
    close(): void;
  }[] = [];
  class FakeNotification {
    static isSupported = () => true;
    private listeners = new Map<string, () => void>();
    show = vi.fn();
    constructor(public opts: { title: string; body: string }) {
      instances.push(this as unknown as (typeof instances)[number]);
    }
    on(event: string, l: () => void) {
      this.listeners.set(event, l);
      return this;
    }
    click() {
      this.listeners.get("click")?.();
    }
    close() {
      this.listeners.get("close")?.();
    }
  }
  return { FakeNotification, instances };
}

const ctx = () => ({ profile, window: { setBackgroundColor: vi.fn() } });

describe("notify@1", () => {
  test("shows an OS notification; a click focuses and navigates on the same origin", async () => {
    const { FakeNotification, instances } = fakeNotificationClass();
    const showProfile = vi.fn();
    const cap = createNotifyCapability({ Notification: FakeNotification, showProfile });
    await cap.notify(ctx(), {
      title: "Approval needed",
      body: "Run x",
      path: "/team/chat/1?x=1#m",
    });
    expect(instances).toHaveLength(1);
    expect(instances[0]?.opts).toMatchObject({ title: "Approval needed", body: "Run x" });
    expect(instances[0]?.show).toHaveBeenCalled();
    instances[0]?.click();
    expect(showProfile).toHaveBeenCalledWith(
      profile,
      "https://capybara.example.com/team/chat/1?x=1#m",
    );
  });

  test("without a path a click only focuses", async () => {
    const { FakeNotification, instances } = fakeNotificationClass();
    const showProfile = vi.fn();
    const cap = createNotifyCapability({ Notification: FakeNotification, showProfile });
    await cap.notify(ctx(), { title: "t", body: "b" });
    instances[0]?.click();
    expect(showProfile).toHaveBeenCalledWith(profile, undefined);
  });

  test("a path that leaves the origin is refused", async () => {
    const { FakeNotification, instances } = fakeNotificationClass();
    const cap = createNotifyCapability({ Notification: FakeNotification, showProfile: vi.fn() });
    for (const path of [
      "//evil.example.com/x",
      "https://evil.example.com/",
      "javascript:alert(1)",
      "chat/1",
      "/\\evil.example.com",
      3,
    ]) {
      await expect(cap.notify(ctx(), { title: "t", body: "b", path })).rejects.toEqual({
        code: "failed",
      });
    }
    expect(instances).toHaveLength(0);
  });

  test("bad input is refused", async () => {
    const { FakeNotification } = fakeNotificationClass();
    const cap = createNotifyCapability({ Notification: FakeNotification, showProfile: vi.fn() });
    for (const input of [
      null,
      "x",
      { title: 1, body: "b" },
      { title: "t" },
      { title: "t".repeat(1001), body: "b" },
    ]) {
      await expect(cap.notify(ctx(), input)).rejects.toEqual({ code: "failed" });
    }
  });

  test("same-origin check", () => {
    expect(sameOriginUrl("/a", profile.origin)).toBe("https://capybara.example.com/a");
    expect(sameOriginUrl("//x.example.com/a", profile.origin)).toBeNull();
    expect(sameOriginUrl("/\\x.example.com", profile.origin)).toBeNull();
  });
});

describe("openExternal@1", () => {
  test("opens http(s) only", async () => {
    const openExternal = vi.fn(async () => undefined);
    const cap = createOpenExternalCapability({ openExternal });
    await cap.open(ctx(), "https://docs.example.com/a");
    await cap.open(ctx(), "http://docs.example.com/a");
    expect(openExternal).toHaveBeenCalledTimes(2);
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "capybara://auth/callback",
      "smb://x",
      "nonsense",
      5,
    ]) {
      await expect(cap.open(ctx(), url)).rejects.toEqual({ code: "failed" });
    }
    expect(openExternal).toHaveBeenCalledTimes(2);
  });
});

describe("openExternal@1 returnScheme", () => {
  test("openExternal@1 exposes returnScheme", () => {
    const bridge = createShellBridge({
      resolveSender: () => ({ profile }),
      stateFor: () => ({ insets: { top: 0, right: 0, bottom: 0, left: 0 }, controls: null }),
      platform: "macos",
      shellVersion: "1.2.3",
    });
    bridge.registerCapability(
      "openExternal@1",
      createOpenExternalCapability({ openExternal: async () => undefined }),
      openExternalOptions("capybara"),
    );
    expect(bridge.describe(profile)).toEqual({ "openExternal@1": ["open"] });
    expect(bridge.describeFields(profile)).toEqual({
      "openExternal@1": { returnScheme: "capybara" },
    });
  });
});

const TOKENS = {
  bg: "rgb(16, 20, 24)",
  panel: "#111",
  ink: "rgba(230, 230, 227, 1)",
  muted: "#8e8e89",
  line: "#2a2a28",
  accent: "#ff6a13",
  onAccent: "#0a0a0a",
};

function chromeCtx(o: { overlay?: "ok" | "throws" } = {}) {
  return {
    ...ctx(),
    window: {
      setBackgroundColor: vi.fn(),
      ...(o.overlay
        ? {
            setTitleBarOverlay: vi.fn(() => {
              if (o.overlay === "throws") throw new Error("Titlebar overlay is not enabled");
            }),
          }
        : {}),
    },
  };
}

describe("chrome@1", () => {
  test("setAppearance sets the window background", async () => {
    const onReport = vi.fn();
    const cap = createChromeCapability({ onReport });
    const c = chromeCtx();
    await cap.setAppearance(c, { scheme: "dark", background: "#101418" });
    expect(c.window.setBackgroundColor).toHaveBeenCalledWith("#101418");
    expect(onReport).toHaveBeenCalledWith(profile, { scheme: "dark" });
  });

  test("an rgb() background is handed to Electron as #rrggbb", async () => {
    const cap = createChromeCapability();
    const c = chromeCtx();
    await cap.setAppearance(c, { scheme: "light", background: "rgba(250, 249, 246, 1)" });
    expect(c.window.setBackgroundColor).toHaveBeenCalledWith("#faf9f6");
  });

  test("see-through colors: the background is not applied, a token set is dropped", async () => {
    const onReport = vi.fn();
    const cap = createChromeCapability({ onReport });
    const c = chromeCtx();
    await cap.setAppearance(c, { scheme: "light", background: "rgba(250, 249, 246, 0.5)" });
    expect(c.window.setBackgroundColor).not.toHaveBeenCalled();
    expect(onReport).toHaveBeenLastCalledWith(profile, { scheme: "light" });
    await cap.setAppearance(c, {
      scheme: "dark",
      background: "#101418",
      tokens: { ...TOKENS, ink: "rgba(0, 0, 0, 0)" },
      singleScheme: true,
    });
    // Scheme and background stay; the tokens are not stored.
    expect(c.window.setBackgroundColor).toHaveBeenCalledWith("#101418");
    expect(onReport).toHaveBeenLastCalledWith(profile, { scheme: "dark", singleScheme: true });
  });

  test("a report equal to the stored one is not reported again", async () => {
    let stored: Appearance | undefined;
    const onReport = vi.fn((_p: Profile, a: Appearance) => {
      stored = a;
    });
    const cap = createChromeCapability({ onReport, stored: () => stored });
    const c = chromeCtx();
    const input = { scheme: "dark", background: "#101418", tokens: TOKENS };
    await cap.setAppearance(c, input);
    await cap.setAppearance(c, { ...input, tokens: { ...TOKENS } });
    expect(onReport).toHaveBeenCalledTimes(1);
    // The window still follows each call.
    expect(c.window.setBackgroundColor).toHaveBeenCalledTimes(2);
    await cap.setAppearance(c, { ...input, singleScheme: true });
    expect(onReport).toHaveBeenCalledTimes(2);
  });

  test("tokens and singleScheme are stored; tokens.bg wins as the background", async () => {
    const onReport = vi.fn();
    const cap = createChromeCapability({ onReport });
    const c = chromeCtx({ overlay: "ok" });
    await cap.setAppearance(c, {
      scheme: "dark",
      background: "#000000",
      tokens: TOKENS,
      singleScheme: true,
    });
    expect(c.window.setBackgroundColor).toHaveBeenCalledWith("#101418");
    // The main window's overlay stays see-through: the web shows under the caption buttons.
    expect(c.window.setTitleBarOverlay).toHaveBeenCalledWith({
      color: "rgba(0, 0, 0, 0)",
      symbolColor: "#8e8e89",
    });
    expect(onReport).toHaveBeenCalledWith(profile, {
      scheme: "dark",
      tokens: TOKENS,
      singleScheme: true,
    });
  });

  test("singleScheme false is accepted and not stored", async () => {
    const onReport = vi.fn();
    const cap = createChromeCapability({ onReport });
    await cap.setAppearance(chromeCtx(), {
      scheme: "light",
      background: "#fff",
      singleScheme: false,
    });
    expect(onReport).toHaveBeenCalledWith(profile, { scheme: "light" });
  });

  test("a window without a title bar overlay still takes the call", async () => {
    const onReport = vi.fn();
    const cap = createChromeCapability({ onReport });
    const c = chromeCtx({ overlay: "throws" });
    await cap.setAppearance(c, { scheme: "dark", background: "#101418", tokens: TOKENS });
    expect(c.window.setBackgroundColor).toHaveBeenCalledWith("#101418");
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  test("an invalid colour, scheme, token set or singleScheme is refused", async () => {
    const onReport = vi.fn();
    const cap = createChromeCapability({ onReport });
    const c = chromeCtx();
    const { accent: _accent, ...sixTokens } = TOKENS;
    for (const input of [
      { scheme: "dark", background: "red; x" },
      { scheme: "dark", background: "url(x)" },
      { scheme: "dark", background: "red" },
      { scheme: "dark", background: "#11223344" },
      { scheme: "blue", background: "#fff" },
      { scheme: "dark" },
      { scheme: "dark", background: "#fff", tokens: sixTokens },
      { scheme: "dark", background: "#fff", tokens: { ...TOKENS, ink: "var(--x)" } },
      { scheme: "dark", background: "#fff", tokens: { ...TOKENS, line: "</style>" } },
      { scheme: "dark", background: "#fff", tokens: "x" },
      { scheme: "dark", background: "#fff", tokens: null },
      { scheme: "dark", background: "#fff", singleScheme: "yes" },
      null,
    ]) {
      await expect(cap.setAppearance(c, input)).rejects.toEqual({ code: "failed" });
    }
    expect(c.window.setBackgroundColor).not.toHaveBeenCalled();
    expect(onReport).not.toHaveBeenCalled();
  });
});
