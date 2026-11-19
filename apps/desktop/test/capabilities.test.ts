import { describe, expect, test, vi } from "vitest";
import {
  createChromeCapability,
  createNotifyCapability,
  createOpenExternalCapability,
  isBackgroundColor,
  sameOriginUrl,
} from "../src/main/capabilities.ts";
import type { Profile } from "../src/main/profiles.ts";

const profile: Profile = {
  id: "p1",
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

describe("chrome@1", () => {
  test("setAppearance sets the window background", async () => {
    const cap = createChromeCapability();
    const c = ctx();
    await cap.setAppearance(c, { scheme: "dark", background: "#101418" });
    expect(c.window.setBackgroundColor).toHaveBeenCalledWith("#101418");
  });

  test("an invalid colour or scheme is refused", async () => {
    const cap = createChromeCapability();
    const c = ctx();
    for (const input of [
      { scheme: "dark", background: "red; x" },
      { scheme: "dark", background: "url(x)" },
      { scheme: "blue", background: "#fff" },
      { scheme: "dark" },
      null,
    ]) {
      await expect(cap.setAppearance(c, input)).rejects.toEqual({ code: "failed" });
    }
    expect(c.window.setBackgroundColor).not.toHaveBeenCalled();
  });

  test("colour forms", () => {
    // Only #rgb and #rrggbb: Electron reads 4 and 8 digits as alpha first, CSS as alpha last.
    for (const c of ["#fff", "#FFFFFF", "#101418"]) expect(isBackgroundColor(c)).toBe(true);
    for (const c of ["fff", "#ggg", "#12345", "#1234", "#11223344", "rgb(1,2,3)", " #fff", ""])
      expect(isBackgroundColor(c)).toBe(false);
  });
});
