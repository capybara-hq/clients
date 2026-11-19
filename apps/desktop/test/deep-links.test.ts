import { describe, expect, test, vi } from "vitest";
import {
  createDeepLinkHandlers,
  createDeepLinkRouter,
  deepLinkFromArgv,
  installDeepLinks,
} from "../src/main/deep-links.ts";
import type { Profile } from "../src/main/profiles.ts";
import { fakeEmitter } from "./fakes.ts";

const AUTH = "capybara://auth/callback?code=cap_ac_1&state=s1&iss=https%3A%2F%2Fa.example.com";

describe("routeDeepLink", () => {
  test("an auth callback goes to the sign-in handler", () => {
    const onAuth = vi.fn(async () => undefined);
    const router = createDeepLinkRouter({ onAuth });
    router.routeDeepLink(AUTH);
    expect(onAuth).toHaveBeenCalledExactlyOnceWith({
      kind: "auth",
      code: "cap_ac_1",
      state: "s1",
      iss: "https://a.example.com",
    });
  });

  test("a denial reaches the handler as an error", () => {
    const onAuth = vi.fn(async (_cb: unknown) => undefined);
    createDeepLinkRouter({ onAuth }).routeDeepLink(
      "capybara://auth/callback?error=access_denied&state=s1&iss=https%3A%2F%2Fa.example.com",
    );
    expect(onAuth.mock.calls[0]?.[0]).toMatchObject({ kind: "auth", error: "access_denied" });
  });

  test("connect and open go to their handlers when given (Task 15)", () => {
    const onAuth = vi.fn(async () => undefined);
    const onConnect = vi.fn();
    const onOpen = vi.fn();
    const router = createDeepLinkRouter({ onAuth, onConnect, onOpen });
    router.routeDeepLink("capybara://connect?url=a.example.com");
    router.routeDeepLink("capybara://open?url=https%3A%2F%2Fa.example.com%2Fchat%2F1");
    expect(onConnect).toHaveBeenCalledWith("a.example.com");
    expect(onOpen).toHaveBeenCalledWith("https://a.example.com/chat/1");
    expect(onAuth).not.toHaveBeenCalled();
    // Without handlers they do nothing.
    expect(() =>
      createDeepLinkRouter({ onAuth }).routeDeepLink("capybara://open?url=x"),
    ).not.toThrow();
  });

  test("unknown or malformed links are ignored", () => {
    const onAuth = vi.fn(async () => undefined);
    const router = createDeepLinkRouter({ onAuth });
    for (const url of [
      "capybara://auth/callback?code=x",
      "capybara://evil",
      "https://a.example.com/auth/callback?code=x&state=s&iss=y",
      "not a url",
      "",
    ]) {
      router.routeDeepLink(url);
    }
    expect(onAuth).not.toHaveBeenCalled();
  });

  test("a failing handler is logged, never thrown into the event loop", async () => {
    const log = vi.fn();
    const router = createDeepLinkRouter({
      onAuth: async () => {
        throw new Error("boom");
      },
      log,
    });
    router.routeDeepLink(AUTH);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
  });
});

describe("deepLinkFromArgv", () => {
  test("finds the scheme's link among the arguments", () => {
    expect(deepLinkFromArgv(["/app", "--flag", AUTH], "capybara")).toBe(AUTH);
    expect(deepLinkFromArgv(["/app", "CAPYBARA://open?url=x"], "capybara")).toBe(
      "CAPYBARA://open?url=x",
    );
    expect(deepLinkFromArgv(["/app", "--flag", "https://x"], "capybara")).toBeUndefined();
    expect(deepLinkFromArgv(["/app", "capybaraz://x"], "capybara")).toBeUndefined();
  });
});

function fakeApp() {
  const em = fakeEmitter();
  return {
    emit: em.emit,
    on(event: "open-url", listener: (event: { preventDefault(): void }, url: string) => void) {
      em.on(event, listener as (...args: unknown[]) => void);
    },
    setAsDefaultProtocolClient: vi.fn((..._args: unknown[]) => true),
  };
}

describe("installDeepLinks", () => {
  test("registers the scheme; open-url links wait until ready, then are routed in order", () => {
    const app = fakeApp();
    const links = installDeepLinks(app, { scheme: "capybara", argv: ["/app"] });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith("capybara");
    const preventDefault = vi.fn();
    app.emit("open-url", { preventDefault }, "capybara://open?url=1");
    app.emit("open-url", { preventDefault }, "capybara://open?url=2");
    expect(preventDefault).toHaveBeenCalledTimes(2);
    const route = vi.fn();
    links.ready(route);
    expect(route.mock.calls).toEqual([["capybara://open?url=1"], ["capybara://open?url=2"]]);
    app.emit("open-url", { preventDefault }, "capybara://open?url=3");
    expect(route).toHaveBeenLastCalledWith("capybara://open?url=3");
  });

  test("a link in the launch arguments (Windows, Linux) is routed once ready", () => {
    const app = fakeApp();
    const links = installDeepLinks(app, { scheme: "capybara", argv: ["/app", AUTH] });
    const route = vi.fn();
    links.ready(route);
    expect(route).toHaveBeenCalledExactlyOnceWith(AUTH);
  });

  test("a second instance's link is routed; without one the caller focuses a window", () => {
    const app = fakeApp();
    const links = installDeepLinks(app, { scheme: "capybara", argv: ["/app"] });
    const route = vi.fn();
    links.ready(route);
    expect(links.fromSecondInstance(["/app", AUTH])).toBe(true);
    expect(route).toHaveBeenCalledWith(AUTH);
    expect(links.fromSecondInstance(["/app"])).toBe(false);
  });

  test("a development run registers with the interpreter and the entry script", () => {
    const app = fakeApp();
    installDeepLinks(app, {
      scheme: "capybara",
      argv: ["/electron", "/app/main.cjs"],
      defaultApp: { execPath: "/electron", args: ["/app/main.cjs"] },
    });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith("capybara", "/electron", [
      "/app/main.cjs",
    ]);
  });

  test("the queue before ready is bounded", () => {
    const app = fakeApp();
    const links = installDeepLinks(app, { scheme: "capybara", argv: ["/app"] });
    for (let i = 0; i < 50; i++) app.emit("open-url", { preventDefault() {} }, `capybara://x${i}`);
    const route = vi.fn();
    links.ready(route);
    expect(route.mock.calls.length).toBeLessThanOrEqual(16);
  });
});

describe("connect and open (spec 6.4)", () => {
  const a: Profile = {
    id: "a",
    base: "https://a.example.com",
    origin: "https://a.example.com",
    name: "A",
  };
  const team: Profile = {
    id: "team",
    base: "https://b.example.com/team",
    origin: "https://b.example.com",
    name: "Team",
  };
  const wide: Profile = {
    id: "wide",
    base: "https://b.example.com",
    origin: "https://b.example.com",
    name: "Wide",
  };

  function setup(over: Partial<Parameters<typeof createDeepLinkHandlers>[0]> = {}) {
    const actions = {
      profiles: () => [a, team, wide] as readonly Profile[],
      isAllowedAddress: () => true,
      openAddress: vi.fn(),
      showProfile: vi.fn(),
      ...over,
    };
    const handlers = createDeepLinkHandlers(actions);
    const router = createDeepLinkRouter({ onAuth: async () => undefined, ...handlers });
    return { actions, router };
  }

  test("connect prefills the address page and does nothing else", () => {
    const { actions, router } = setup();
    router.routeDeepLink("capybara://connect?url=new.example.com");
    expect(actions.openAddress).toHaveBeenCalledExactlyOnceWith("new.example.com");
    // Never a saved profile, never a window of a profile: only the address page.
    expect(actions.showProfile).not.toHaveBeenCalled();
  });

  test("connect to an address the lock does not allow is ignored", () => {
    const { actions, router } = setup({ isAllowedAddress: (addr) => addr === "ok.example.com" });
    router.routeDeepLink("capybara://connect?url=evil.example.com");
    expect(actions.openAddress).not.toHaveBeenCalled();
    router.routeDeepLink("capybara://connect?url=ok.example.com");
    expect(actions.openAddress).toHaveBeenCalledWith("ok.example.com");
  });

  test("an absurdly long connect address is ignored", () => {
    const { actions, router } = setup();
    router.routeDeepLink(`capybara://connect?url=${"a".repeat(3000)}.example.com`);
    expect(actions.openAddress).not.toHaveBeenCalled();
  });

  test("open focuses the profile of the URL's own origin and navigates to that URL", () => {
    const { actions, router } = setup();
    router.routeDeepLink(
      `capybara://open?url=${encodeURIComponent("https://a.example.com/chat/1?x=2#top")}`,
    );
    expect(actions.showProfile).toHaveBeenCalledExactlyOnceWith(
      a,
      "https://a.example.com/chat/1?x=2#top",
    );
  });

  test("open picks the profile whose base prefix the URL is under", () => {
    const { actions, router } = setup();
    router.routeDeepLink(
      `capybara://open?url=${encodeURIComponent("https://b.example.com/team/chat")}`,
    );
    expect(actions.showProfile).toHaveBeenLastCalledWith(team, "https://b.example.com/team/chat");
    router.routeDeepLink(
      `capybara://open?url=${encodeURIComponent("https://b.example.com/teammate")}`,
    );
    expect(actions.showProfile).toHaveBeenLastCalledWith(wide, "https://b.example.com/teammate");
  });

  test("open for any other origin, scheme or spelling is ignored", () => {
    const { actions, router } = setup();
    for (const target of [
      "https://evil.example.com/chat",
      "https://a.example.com.evil.com/chat",
      "http://a.example.com/chat",
      "https://a.example.com:8443/chat",
      "https://user:pw@a.example.com/chat",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "a.example.com/chat",
      "x",
    ]) {
      router.routeDeepLink(`capybara://open?url=${encodeURIComponent(target)}`);
    }
    expect(actions.showProfile).not.toHaveBeenCalled();
  });

  test("open never creates a profile: with none saved nothing happens", () => {
    const { actions, router } = setup({ profiles: () => [] });
    router.routeDeepLink(`capybara://open?url=${encodeURIComponent("https://a.example.com/")}`);
    expect(actions.showProfile).not.toHaveBeenCalled();
    expect(actions.openAddress).not.toHaveBeenCalled();
  });
});
