import { describe, expect, test, vi } from "vitest";
import { isIconDataUrl } from "../src/local/icon-url.ts";
import {
  applyState,
  controlsProperties,
  createTranslate,
  startPage,
  tokenProperties,
} from "../src/local/runtime.ts";
import type { CapybaraLocal, PageState } from "../src/shared/local-page.ts";

const TOKENS = {
  bg: "#101820",
  panel: "#111111",
  ink: "#ffffff",
  muted: "rgb(1, 2, 3)",
  line: "#222",
  accent: "#00ffcc",
  onAccent: "#000000",
};

const STATE: PageState = {
  page: "connect",
  locale: "en",
  appearance: { scheme: "light" },
  controls: { x: 0, y: 0, width: 80, height: 28 },
  os: "macos",
  appName: "Capybara",
  version: "0.1.0",
};

function fakeRoot() {
  const attrs = new Map<string, string>();
  const props = new Map<string, string>();
  return {
    attrs,
    props,
    setAttribute: (n: string, v: string) => attrs.set(n, v),
    removeAttribute: (n: string) => attrs.delete(n),
    style: {
      setProperty: (n: string, v: string) => props.set(n, v),
      removeProperty: (n: string) => props.delete(n),
    },
  };
}

describe("tokenProperties", () => {
  test("all seven tokens as --cb-* properties", () => {
    expect(tokenProperties({ scheme: "dark", tokens: TOKENS })).toEqual([
      ["--cb-bg", "#101820"],
      ["--cb-panel", "#111111"],
      ["--cb-ink", "#ffffff"],
      ["--cb-muted", "rgb(1, 2, 3)"],
      ["--cb-line", "#222"],
      ["--cb-accent", "#00ffcc"],
      ["--cb-on-accent", "#000000"],
    ]);
  });
  test("nothing when any token is not a color", () => {
    expect(
      tokenProperties({ scheme: "dark", tokens: { ...TOKENS, bg: "red; color: blue" } }),
    ).toEqual([]);
    expect(tokenProperties({ scheme: "dark" })).toEqual([]);
    expect(tokenProperties(undefined)).toEqual([]);
  });
});

describe("controlsProperties", () => {
  test("px values for a sane rectangle, nothing otherwise", () => {
    expect(controlsProperties({ x: 0, y: 0, width: 80, height: 28 })).toEqual([
      ["--lp-controls-x", "0px"],
      ["--lp-controls-y", "0px"],
      ["--lp-controls-w", "80px"],
      ["--lp-controls-h", "28px"],
    ]);
    expect(controlsProperties(null)).toEqual([]);
    expect(controlsProperties({ x: -1, y: 0, width: 80, height: 28 })).toEqual([]);
    expect(
      controlsProperties({ x: Number.POSITIVE_INFINITY, y: 0, width: 80, height: 28 }),
    ).toEqual([]);
  });
});

describe("applyState", () => {
  test("theme, lang, os and no tokens for a built-in scheme", () => {
    const root = fakeRoot();
    applyState(root, STATE);
    expect(root.attrs.get("data-theme")).toBe("light");
    expect(root.attrs.get("lang")).toBe("en");
    expect(root.attrs.get("data-os")).toBe("macos");
    expect(root.attrs.has("data-tokens")).toBe(false);
    expect(root.props.get("--lp-controls-w")).toBe("80px");
  });

  test("reported tokens become properties and are cleared again", () => {
    const root = fakeRoot();
    applyState(root, {
      ...STATE,
      appearance: { scheme: "dark", tokens: TOKENS, singleScheme: true },
    });
    expect(root.props.get("--cb-bg")).toBe("#101820");
    expect(root.attrs.has("data-tokens")).toBe(true);
    expect(root.attrs.has("data-single-scheme")).toBe(true);
    applyState(root, { ...STATE, controls: null });
    expect(root.props.size).toBe(0);
    expect(root.attrs.has("data-tokens")).toBe(false);
    expect(root.attrs.has("data-single-scheme")).toBe(false);
  });

  test("unexpected values fall back", () => {
    const root = fakeRoot();
    applyState(root, {
      ...STATE,
      locale: "fr" as "zh",
      os: "beos" as "macos",
      appearance: { scheme: "sepia" as "dark" },
    });
    expect(root.attrs.get("data-theme")).toBe("dark");
    expect(root.attrs.get("lang")).toBe("zh-CN");
    expect(root.attrs.get("data-os")).toBe("macos");
  });
});

describe("createTranslate", () => {
  test("uses the shell catalog with placeholders", () => {
    expect(createTranslate("zh")("onboarding.found.title", { platform: "Meta1" })).toBe(
      "登录到 Meta1",
    );
    expect(createTranslate("en")("onboarding.footer", { name: "Capybara", version: "1.2.3" })).toBe(
      "Capybara Desktop 1.2.3",
    );
    expect(createTranslate("xx")("prefs.theme.dark")).toBe("深色");
  });
});

describe("startPage", () => {
  test("renders the first state, then every pushed one", async () => {
    let push: ((s: PageState) => void) | undefined;
    const bridge: CapybaraLocal = {
      state: vi.fn(async () => STATE),
      onState: (cb) => {
        push = cb;
        return () => undefined;
      },
      act: vi.fn(async () => "ok"),
    };
    const root = fakeRoot();
    const doc = { documentElement: root, querySelectorAll: () => [] };
    const render = vi.fn();
    await startPage(render, { bridge, doc });
    expect(render).toHaveBeenCalledTimes(1);
    const ctx = render.mock.calls[0]?.[0];
    expect(ctx.state).toEqual(STATE);
    expect(ctx.t("prefs.theme.dark")).toBe("Dark");
    await ctx.act("found.signIn");
    expect(bridge.act).toHaveBeenCalledWith("found.signIn", undefined);
    push?.({ ...STATE, locale: "zh", appearance: { scheme: "dark" } });
    expect(render).toHaveBeenCalledTimes(2);
    expect(root.attrs.get("data-theme")).toBe("dark");
    expect(render.mock.calls[1]?.[0].t("prefs.theme.dark")).toBe("深色");
  });

  test("a push that beat the first state wins", async () => {
    let push: ((s: PageState) => void) | undefined;
    let resolve: ((s: PageState) => void) | undefined;
    const bridge: CapybaraLocal = {
      state: () =>
        new Promise<PageState>((r) => {
          resolve = r;
        }),
      onState: (cb) => {
        push = cb;
        return () => undefined;
      },
      act: async () => null,
    };
    const doc = { documentElement: fakeRoot(), querySelectorAll: () => [] };
    const render = vi.fn();
    const started = startPage(render, { bridge, doc });
    push?.({ ...STATE, page: "found" });
    resolve?.(STATE);
    await started;
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[0].state.page).toBe("found");
  });
});

describe("isIconDataUrl", () => {
  test("accepts base64 PNG, JPEG and WebP data URLs only", () => {
    expect(isIconDataUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isIconDataUrl("data:image/webp;base64,AAAA")).toBe(true);
    expect(isIconDataUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isIconDataUrl("data:image/png;base64,AA AA")).toBe(false);
    expect(isIconDataUrl("https://x.example/icon.png")).toBe(false);
    expect(isIconDataUrl(`data:image/png;base64,${"A".repeat(1_500_000)}`)).toBe(false);
    expect(isIconDataUrl(42)).toBe(false);
  });
});
