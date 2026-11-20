import { describe, expect, test } from "vitest";
import {
  type Appearance,
  BUILTIN_TOKENS,
  backgroundOf,
  electronColor,
  isColor,
  isOpaque,
  overlayColors,
  resolveAppearance,
  type Tokens,
  validTokens,
} from "../src/main/appearance.ts";

const TOKENS: Tokens = {
  bg: "#101820",
  panel: "rgb(20, 30, 40)",
  ink: "#fff",
  muted: "rgba(255, 255, 255, 0.6)",
  line: "#333333",
  accent: "#00ffcc",
  onAccent: "#000",
};

describe("isColor", () => {
  test("accepts hex 3/6 and rgb()/rgba()", () => {
    for (const v of [
      "#abc",
      "#AABBCC",
      "rgb(0,0,0)",
      "rgb( 255 , 255 , 255 )",
      "rgba(10, 20, 30, 0.5)",
      "rgba(10,20,30,1)",
      "rgba(10,20,30,0)",
      "rgba(10,20,30,.25)",
    ]) {
      expect(isColor(v), v).toBe(true);
    }
  });
  test("refuses everything else", () => {
    for (const v of [
      "#abcd",
      "#aabbccdd",
      "red",
      "rgb(256,0,0)",
      "rgb(0,0)",
      "rgba(0,0,0,1.5)",
      "rgba(0,0,0)",
      "color-mix(in srgb, red, blue)",
      "var(--x)",
      "#abc; background: url(x)",
      "rgb(0,0,0) ",
      "",
      42,
      null,
      undefined,
      {},
    ]) {
      expect(isColor(v), String(v)).toBe(false);
    }
  });
  test("the built-in tokens are colors", () => {
    for (const scheme of ["light", "dark"] as const) {
      expect(validTokens(BUILTIN_TOKENS[scheme])).toEqual(BUILTIN_TOKENS[scheme]);
    }
    expect(BUILTIN_TOKENS.dark.bg).toBe("#0A0A0A");
    expect(BUILTIN_TOKENS.light.accent).toBe("#CC4609");
  });
});

describe("validTokens", () => {
  test("all seven or nothing", () => {
    expect(validTokens(TOKENS)).toEqual(TOKENS);
    expect(validTokens({ ...TOKENS, accent: "orange" })).toBeUndefined();
    const { line: _line, ...missing } = TOKENS;
    expect(validTokens(missing)).toBeUndefined();
    expect(validTokens({ ...TOKENS, extra: "<b>" })).toEqual(TOKENS);
    expect(validTokens(null)).toBeUndefined();
  });
});

describe("resolveAppearance", () => {
  const dark: Appearance = { scheme: "dark", tokens: TOKENS };
  const single: Appearance = { scheme: "dark", tokens: TOKENS, singleScheme: true };
  const cases: Array<[string, boolean, Appearance | undefined, string | undefined, Appearance]> = [
    ["OS dark, nothing else", true, undefined, undefined, { scheme: "dark" }],
    ["OS light, nothing else", false, undefined, undefined, { scheme: "light" }],
    ["cookie beats the OS", true, undefined, "light", { scheme: "light" }],
    ["report beats the OS", false, dark, undefined, dark],
    ["cookie matching the report keeps its tokens", false, dark, "dark", dark],
    ["cookie for the other scheme drops the tokens", true, dark, "light", { scheme: "light" }],
    ["single scheme wins over the cookie", false, single, "light", single],
    ["a bad cookie is ignored", false, undefined, "blue", { scheme: "light" }],
    [
      "malformed tokens are dropped",
      false,
      { scheme: "dark", tokens: { ...TOKENS, bg: "url(x)" } },
      undefined,
      { scheme: "dark" },
    ],
    [
      "a malformed report is ignored",
      true,
      { scheme: "sepia" } as unknown as Appearance,
      undefined,
      { scheme: "dark" },
    ],
    [
      "singleScheme must be true to count",
      false,
      { scheme: "dark", singleScheme: "yes" } as unknown as Appearance,
      "light",
      { scheme: "light" },
    ],
  ];
  for (const [name, osDark, report, cookie, expected] of cases) {
    test(name, () => {
      expect(resolveAppearance(osDark, report, cookie)).toEqual(expected);
    });
  }

  test("backgroundOf: reported bg, else the built-in one", () => {
    expect(backgroundOf(dark)).toBe("#101820");
    expect(backgroundOf({ scheme: "light" })).toBe("#FAF9F6");
    expect(backgroundOf({ scheme: "dark" })).toBe("#0A0A0A");
  });
});

describe("electronColor", () => {
  test("hex stays; rgb() and rgba() become #rrggbb with the alpha dropped", () => {
    expect(electronColor("#abc")).toBe("#abc");
    expect(electronColor("#A0B1C2")).toBe("#A0B1C2");
    expect(electronColor("rgb(16, 20, 24)")).toBe("#101418");
    expect(electronColor("rgb(0,0,0)")).toBe("#000000");
    expect(electronColor("rgba(255, 255, 255, 0.5)")).toBe("#ffffff");
    expect(electronColor("rgba( 1 , 2 , 3 , 1 )")).toBe("#010203");
  });

  test("anything that is not a color is undefined", () => {
    for (const v of ["red", "#11223344", "rgb(256,0,0)", "var(--x)", "", 5, null]) {
      expect(electronColor(v)).toBeUndefined();
    }
  });

  test("the window background and the overlay colors are Electron colors", () => {
    const rgb: Appearance = { scheme: "dark", tokens: { ...TOKENS, bg: "rgb(1, 2, 3)" } };
    expect(backgroundOf(rgb)).toBe("#010203");
    expect(overlayColors(rgb)).toEqual({ color: "#010203", symbolColor: "#ffffff" });
    expect(overlayColors({ scheme: "light" })).toEqual({
      color: BUILTIN_TOKENS.light.bg,
      symbolColor: BUILTIN_TOKENS.light.muted,
    });
  });
});

describe("isOpaque", () => {
  test("hex, rgb() and rgba() with alpha 1 only", () => {
    for (const v of ["#fff", "#101418", "rgb(1, 2, 3)", "rgba(1, 2, 3, 1)", "rgba(1,2,3,1.0)"]) {
      expect(isOpaque(v), v).toBe(true);
    }
    for (const v of ["rgba(1, 2, 3, 0.99)", "rgba(1,2,3,0)", "rgba(1,2,3,.5)", "red"]) {
      expect(isOpaque(v), v).toBe(false);
    }
  });
});
