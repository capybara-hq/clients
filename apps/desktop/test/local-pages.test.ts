import { describe, expect, test, vi } from "vitest";
import { createLocalPages, LOCAL_PAGE_ACTIONS } from "../src/main/local-pages.ts";
import type { PageState } from "../src/shared/local-page.ts";
import { LOCAL_CHANNELS, LOCAL_ORIGIN } from "../src/shared/protocol.ts";

const STATE: PageState = {
  page: "connect",
  locale: "zh",
  appearance: { scheme: "dark" },
  controls: null,
  os: "macos",
  appName: "Capybara",
  version: "0.1.0",
};

function contents(id: number) {
  const destroyed: Array<() => void> = [];
  return {
    id,
    send: vi.fn((_channel: string, _payload: unknown) => undefined),
    isDestroyed: vi.fn(() => false),
    once: vi.fn((_event: "destroyed", l: () => void) => destroyed.push(l)),
    destroy: () => {
      for (const l of destroyed) l();
    },
  };
}

const TOP = { origin: LOCAL_ORIGIN, parent: null };
const event = (sender: unknown, ...frame: unknown[]) =>
  ({ sender, senderFrame: frame.length > 0 ? frame[0] : TOP }) as Parameters<
    ReturnType<typeof createLocalPages>["handleAct"]
  >[0];

describe("the local page registry", () => {
  test("answers state and dispatches an allowed action with checked args", async () => {
    const pages = createLocalPages();
    const wc = contents(1);
    pages.register(wc, { kind: "onboarding", profileId: "p1", state: () => STATE });
    const handler = vi.fn(async () => "done");
    pages.handle("onboarding", "prefs.setTheme", handler);

    expect(pages.handleState(event(wc))).toEqual(STATE);
    expect(
      await pages.handleAct(event(wc), { action: "prefs.setTheme", args: { theme: "light" } }),
    ).toEqual({ ok: true, value: "done" });
    expect(handler).toHaveBeenCalledWith(
      { contents: wc, kind: "onboarding", profileId: "p1" },
      { theme: "light" },
    );
  });

  test("refuses an unregistered sender, whatever it asks", async () => {
    const pages = createLocalPages();
    const handler = vi.fn();
    pages.handle("onboarding", "found.signIn", handler);
    const stranger = contents(9);
    expect(pages.handleState(event(stranger))).toBeNull();
    expect(await pages.handleAct(event(stranger), { action: "found.signIn" })).toEqual({
      ok: false,
      error: "refused",
    });
    expect(await pages.handleAct(event({}), { action: "found.signIn" })).toEqual({
      ok: false,
      error: "refused",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("refuses a registered id whose frame is not app://local's top frame", async () => {
    const pages = createLocalPages();
    const wc = contents(1);
    pages.register(wc, { kind: "dialog", state: () => STATE });
    const answer = vi.fn();
    pages.handle("dialog", "dialog.answer", answer);
    const req = { action: "dialog.answer", args: { index: 0 } };
    for (const frame of [
      { origin: "https://capybara.example.com", parent: null },
      { origin: LOCAL_ORIGIN, parent: {} },
      { origin: "app://address", parent: null },
      null,
      undefined,
    ]) {
      expect(await pages.handleAct(event(wc, frame), req)).toEqual({ ok: false, error: "refused" });
      expect(pages.handleState(event(wc, frame))).toBeNull();
    }
    const destroyedFrame = {
      get origin(): string {
        throw new Error("destroyed");
      },
      parent: null,
    };
    expect(await pages.handleAct(event(wc, destroyedFrame), req)).toEqual({
      ok: false,
      error: "refused",
    });
    expect(answer).not.toHaveBeenCalled();
  });

  test("refuses an action not allowed for the page's kind", async () => {
    const pages = createLocalPages();
    const dialog = contents(1);
    pages.register(dialog, { kind: "dialog", state: () => STATE });
    const signIn = vi.fn();
    pages.handle("onboarding", "found.signIn", signIn);
    for (const action of [
      "found.signIn",
      "prefs.setTheme",
      "mainError.signOut",
      "nope",
      "toString",
    ]) {
      expect(await pages.handleAct(event(dialog), { action })).toEqual({
        ok: false,
        error: "refused",
      });
    }
    expect(signIn).not.toHaveBeenCalled();
  });

  test("refuses malformed requests and arguments that fail the action's check", async () => {
    const pages = createLocalPages();
    const wc = contents(1);
    pages.register(wc, { kind: "onboarding", state: () => STATE });
    const setTheme = vi.fn();
    const signIn = vi.fn();
    pages.handle("onboarding", "prefs.setTheme", setTheme);
    pages.handle("onboarding", "found.signIn", signIn);
    for (const raw of [null, "prefs.setTheme", [], { action: 1 }]) {
      expect(await pages.handleAct(event(wc), raw)).toEqual({ ok: false, error: "refused" });
    }
    for (const args of [{ theme: "blue" }, { theme: 1 }, {}, ["light"], "light"]) {
      expect(await pages.handleAct(event(wc), { action: "prefs.setTheme", args })).toEqual({
        ok: false,
        error: "invalid",
      });
    }
    expect(await pages.handleAct(event(wc), { action: "found.signIn", args: { x: 1 } })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(
      await pages.handleAct(event(wc), {
        action: "connect.submit",
        args: { address: "x".repeat(2049) },
      }),
    ).toEqual({ ok: false, error: "invalid" });
    expect(setTheme).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });

  test("dialog answers are integers in range", async () => {
    const pages = createLocalPages();
    const wc = contents(1);
    pages.register(wc, { kind: "dialog", state: () => STATE });
    const answer = vi.fn(() => undefined);
    pages.handle("dialog", "dialog.answer", answer);
    for (const index of [-1, 1.5, 16, "0", Number.NaN]) {
      expect(
        await pages.handleAct(event(wc), { action: "dialog.answer", args: { index } }),
      ).toEqual({ ok: false, error: "invalid" });
    }
    expect(
      await pages.handleAct(event(wc), { action: "dialog.answer", args: { index: 1 } }),
    ).toEqual({ ok: true, value: null });
    expect(answer).toHaveBeenCalledTimes(1);
  });

  test("an allowed action without a handler is unavailable; a throwing one is failed", async () => {
    const log = vi.fn();
    const pages = createLocalPages({ log });
    const wc = contents(1);
    pages.register(wc, { kind: "main-error", state: () => STATE });
    expect(await pages.handleAct(event(wc), { action: "mainError.retry" })).toEqual({
      ok: false,
      error: "unavailable",
    });
    pages.handle("main-error", "mainError.retry", () => {
      throw new Error("boom");
    });
    expect(await pages.handleAct(event(wc), { action: "mainError.retry" })).toEqual({
      ok: false,
      error: "failed",
    });
    expect(log).toHaveBeenCalled();
  });

  test("handle refuses actions outside the allowlist and a second handler", () => {
    const pages = createLocalPages();
    expect(() =>
      pages.handle("dialog", "found.signIn" as "dialog.answer", () => undefined),
    ).toThrow();
    const off = pages.handle("dialog", "dialog.answer", () => undefined);
    expect(() => pages.handle("dialog", "dialog.answer", () => undefined)).toThrow();
    off();
    expect(() => pages.handle("dialog", "dialog.answer", () => undefined)).not.toThrow();
  });

  test("a destroyed or unregistered page is forgotten", async () => {
    const pages = createLocalPages();
    const a = contents(1);
    const b = contents(2);
    pages.register(a, { kind: "onboarding", state: () => STATE });
    const off = pages.register(b, { kind: "dialog", state: () => STATE });
    a.destroy();
    off();
    expect(pages.handleState(event(a))).toBeNull();
    expect(pages.handleState(event(b))).toBeNull();
    expect(pages.kindOf(a)).toBeUndefined();
    expect(pages.entries()).toEqual([]);
  });

  test("push sends a fresh state to the pages the filter picks", () => {
    const pages = createLocalPages();
    const a = contents(1);
    const b = contents(2);
    let locale: "zh" | "en" = "zh";
    pages.register(a, { kind: "onboarding", profileId: "p1", state: () => ({ ...STATE, locale }) });
    pages.register(b, { kind: "onboarding", profileId: "p2", state: () => STATE });
    locale = "en";
    pages.push((e) => e.profileId === "p1");
    expect(a.send).toHaveBeenCalledWith(LOCAL_CHANNELS.push, { ...STATE, locale: "en" });
    expect(b.send).not.toHaveBeenCalled();
    pages.push();
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  test("install wires both channels", async () => {
    const pages = createLocalPages();
    const handlers = new Map<string, (e: unknown, raw: unknown) => unknown>();
    pages.install({
      handle: (c, l) => handlers.set(c, l as (e: unknown, raw: unknown) => unknown),
    });
    expect([...handlers.keys()].sort()).toEqual([LOCAL_CHANNELS.act, LOCAL_CHANNELS.state].sort());
    expect(await handlers.get(LOCAL_CHANNELS.act)?.(event(contents(5)), { action: "x" })).toEqual({
      ok: false,
      error: "refused",
    });
  });

  test("every kind has its allowlist", () => {
    expect(Object.keys(LOCAL_PAGE_ACTIONS).sort()).toEqual(["dialog", "main-error", "onboarding"]);
  });
});
