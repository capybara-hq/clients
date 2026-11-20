import { describe, expect, test, vi } from "vitest";
import {
  decideWindowOpen,
  GRANTED_PERMISSIONS,
  hardenLocalContents,
  hardenProfileContents,
  installDenyAllPermissions,
  installPermissionHandlers,
  isNavigationAllowed,
  LOCAL_PARTITION,
  localWebPreferences,
  profileWebPreferences,
} from "../src/main/security.ts";
import { fakeSession, fakeWebContents } from "./fakes.ts";

const ORIGIN = "https://capybara.example.com";

describe("webPreferences", () => {
  test("deployment windows are isolated, sandboxed and without node or webview", () => {
    const p = profileWebPreferences({ partition: "persist:profile-p1", preload: "/x/preload.cjs" });
    expect(p).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: "persist:profile-p1",
      preload: "/x/preload.cjs",
    });
  });
});

describe("permissions", () => {
  test("the granted list is explicit and small", () => {
    expect([...GRANTED_PERMISSIONS].sort()).toEqual(["clipboard-sanitized-write", "notifications"]);
  });

  test("the profile origin's top frame gets a listed permission", async () => {
    const s = fakeSession();
    installPermissionHandlers(s, ORIGIN);
    expect(await s.request("notifications", `${ORIGIN}/chat/1`)).toBe(true);
    expect(s.check("clipboard-sanitized-write", ORIGIN)).toBe(true);
  });

  test("a request from another origin is denied", async () => {
    const s = fakeSession();
    installPermissionHandlers(s, ORIGIN);
    expect(await s.request("notifications", "https://evil.example.com/")).toBe(false);
    expect(await s.request("notifications", "https://capybara.example.com.evil.io/")).toBe(false);
    expect(s.check("notifications", "https://evil.example.com")).toBe(false);
  });

  test("sub-frames and unlisted permissions are denied", async () => {
    const s = fakeSession();
    installPermissionHandlers(s, ORIGIN);
    expect(await s.request("notifications", `${ORIGIN}/plugin-ui/x`, false)).toBe(false);
    expect(s.check("notifications", ORIGIN, false)).toBe(false);
    for (const p of ["media", "geolocation", "clipboard-read", "openExternal", "hid", "unknown"]) {
      expect(await s.request(p, `${ORIGIN}/`)).toBe(false);
      expect(s.check(p, ORIGIN)).toBe(false);
    }
    expect(await s.request("notifications", "not a url")).toBe(false);
    expect(s.device({ deviceType: "usb", origin: ORIGIN })).toBe(false);
  });
});

describe("the local partition's permissions", () => {
  test("everything is denied, whatever the origin", async () => {
    const s = fakeSession();
    installDenyAllPermissions(s);
    for (const p of [...GRANTED_PERMISSIONS, "media", "geolocation"]) {
      expect(await s.request(p, "app://local/onboarding.html")).toBe(false);
      expect(s.check(p, "app://local")).toBe(false);
    }
    expect(s.device({ deviceType: "usb" })).toBe(false);
  });
});

describe("navigation", () => {
  test("top-level navigation may leave the origin over http(s) only", () => {
    expect(isNavigationAllowed("https://github.com/login/oauth/authorize")).toBe(true);
    expect(isNavigationAllowed("http://localhost:3000/")).toBe(true);
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "app://local/onboarding.html",
      "data:text/html,x",
      "capybara://auth/callback",
      "nonsense",
    ]) {
      expect(isNavigationAllowed(url)).toBe(false);
    }
  });

  test("will-navigate to a non-http(s) scheme is prevented", () => {
    const wc = fakeWebContents();
    hardenProfileContents(wc, {
      origin: ORIGIN,
      openExternal: vi.fn(),
      openProfileWindow: vi.fn(),
    });
    const blocked = { url: "file:///etc/passwd", preventDefault: vi.fn() };
    wc.emit("will-navigate", blocked, blocked.url);
    expect(blocked.preventDefault).toHaveBeenCalled();
    const allowed = { url: "https://idp.example.com/sso", preventDefault: vi.fn() };
    wc.emit("will-navigate", allowed, allowed.url);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
  });

  test("<webview> is never attached", () => {
    const wc = fakeWebContents();
    hardenProfileContents(wc, {
      origin: ORIGIN,
      openExternal: vi.fn(),
      openProfileWindow: vi.fn(),
    });
    const e = { preventDefault: vi.fn() };
    wc.emit("will-attach-webview", e, {}, {});
    expect(e.preventDefault).toHaveBeenCalled();
  });
});

describe("window.open", () => {
  test("decisions", () => {
    expect(decideWindowOpen(`${ORIGIN}/files/1`, ORIGIN)).toEqual({
      kind: "profile",
      url: `${ORIGIN}/files/1`,
    });
    expect(decideWindowOpen("https://docs.example.com/x", ORIGIN)).toEqual({
      kind: "external",
      url: "https://docs.example.com/x",
    });
    for (const url of [
      "javascript:alert(1)",
      "file:///x",
      "mailto:a@b.c",
      `blob:${ORIGIN}/abc`,
      "data:text/html,x",
      "",
      "about:blank",
    ]) {
      expect(decideWindowOpen(url, ORIGIN)).toEqual({ kind: "refuse" });
    }
  });

  test("another origin goes to the system browser and the window is denied", () => {
    const wc = fakeWebContents();
    const openExternal = vi.fn();
    const openProfileWindow = vi.fn();
    hardenProfileContents(wc, { origin: ORIGIN, openExternal, openProfileWindow });
    expect(wc.openWindow("https://docs.example.com/x")).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://docs.example.com/x");
    expect(openProfileWindow).not.toHaveBeenCalled();
  });

  test("javascript: is refused without opening anything", () => {
    const wc = fakeWebContents();
    const openExternal = vi.fn();
    const openProfileWindow = vi.fn();
    hardenProfileContents(wc, { origin: ORIGIN, openExternal, openProfileWindow });
    expect(wc.openWindow("javascript:alert(1)")).toEqual({ action: "deny" });
    expect(openExternal).not.toHaveBeenCalled();
    expect(openProfileWindow).not.toHaveBeenCalled();
  });

  test("same origin opens a profile window", () => {
    const wc = fakeWebContents();
    const openExternal = vi.fn();
    const openProfileWindow = vi.fn();
    hardenProfileContents(wc, { origin: ORIGIN, openExternal, openProfileWindow });
    expect(wc.openWindow(`${ORIGIN}/share/abc`)).toEqual({ action: "deny" });
    expect(openProfileWindow).toHaveBeenCalledWith(`${ORIGIN}/share/abc`);
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("local page windows", () => {
  test("use the app's local partition with the baseline preferences", () => {
    expect(localWebPreferences({ preload: "/x/local.cjs" })).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      partition: LOCAL_PARTITION,
      preload: "/x/local.cjs",
    });
    expect(LOCAL_PARTITION).not.toMatch(/^persist:/);
  });

  test("stay on app://local and open no windows", () => {
    const wc = fakeWebContents("app://local/onboarding.html");
    hardenLocalContents(wc);
    for (const url of ["https://capybara.example.com/", "app://other/onboarding.html"]) {
      const away = { url, preventDefault: vi.fn() };
      wc.emit("will-navigate", away, url);
      expect(away.preventDefault).toHaveBeenCalled();
    }
    const stay = { url: "app://local/main-error.html", preventDefault: vi.fn() };
    wc.emit("will-navigate", stay, stay.url);
    expect(stay.preventDefault).not.toHaveBeenCalled();
    expect(wc.openWindow("https://capybara.example.com/")).toEqual({ action: "deny" });
  });
});
