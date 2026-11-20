// The local pages' runtime (bundled into each page's script): reads `window.capybaraLocal`,
// applies the appearance (data-theme, the token custom properties, validated values only, set
// through style.setProperty and never as markup), the locale and the window controls, and hands
// the page a translator and `act`. Strings come from the packages/shell catalog, bundled in.
import { type Locale, t } from "@capybara-hq/shell/i18n";
import {
  type Appearance,
  TOKEN_NAMES,
  TOKEN_PROPERTIES,
  validTokens,
} from "../shared/appearance.ts";
import type { CapybaraLocal, PageState } from "../shared/local-page.ts";
import type { Controls } from "../shared/protocol.ts";

export type Translate = (key: string, vars?: Record<string, string>) => string;

export interface PageContext<S extends PageState = PageState> {
  state: S;
  t: Translate;
  /** Sends an action to main; rejects with the error code (`refused`, `invalid`, …). */
  act(action: string, args?: Record<string, unknown>): Promise<unknown>;
}

export function localeOf(v: unknown): Locale {
  return v === "en" ? "en" : "zh";
}

export function createTranslate(locale: unknown): Translate {
  const l = localeOf(locale);
  return (key, vars) => t(l, key, vars);
}

/**
 * The inline custom properties for an appearance: the seven tokens when all of them are valid
 * colors, else none (the stylesheet's built-in values for the scheme apply).
 */
export function tokenProperties(appearance: Appearance | undefined): Array<[string, string]> {
  const tokens = validTokens(appearance?.tokens);
  if (!tokens) return [];
  return TOKEN_NAMES.map((name) => [TOKEN_PROPERTIES[name], tokens[name]]);
}

const CONTROL_PROPERTIES = [
  "--lp-controls-x",
  "--lp-controls-y",
  "--lp-controls-w",
  "--lp-controls-h",
];

/** The controls rectangle as px custom properties; finite, non-negative, bounded numbers only. */
export function controlsProperties(controls: Controls | null | undefined): Array<[string, string]> {
  if (!controls) return [];
  const values = [controls.x, controls.y, controls.width, controls.height];
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 4096)) {
    return [];
  }
  return values.map((v, i) => [CONTROL_PROPERTIES[i] as string, `${Math.round(v)}px`]);
}

export interface StyleTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
}

/** Applies scheme, tokens, locale, OS and controls to the document element. */
export function applyState(root: StyleTarget, state: PageState): void {
  const scheme = state.appearance?.scheme === "light" ? "light" : "dark";
  root.setAttribute("data-theme", scheme);
  root.setAttribute("lang", localeOf(state.locale) === "zh" ? "zh-CN" : "en");
  root.setAttribute(
    "data-os",
    ["macos", "windows", "linux"].includes(state.os) ? state.os : "macos",
  );
  for (const name of [...Object.values(TOKEN_PROPERTIES), ...CONTROL_PROPERTIES]) {
    root.style.removeProperty(name);
  }
  const tokens = tokenProperties(state.appearance);
  for (const [name, value] of tokens) root.style.setProperty(name, value);
  if (tokens.length > 0) root.setAttribute("data-tokens", "");
  else root.removeAttribute("data-tokens");
  if (state.appearance?.singleScheme === true) root.setAttribute("data-single-scheme", "");
  else root.removeAttribute("data-single-scheme");
  for (const [name, value] of controlsProperties(state.controls))
    root.style.setProperty(name, value);
}

/** The few DOM members the runtime touches, so it type-checks and tests without the DOM lib. */
export interface I18nElement {
  dataset: Record<string, string | undefined>;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
}

export interface PageDocument {
  documentElement: StyleTarget;
  querySelectorAll(selector: string): Iterable<I18nElement>;
}

/**
 * Fills static markup: `data-i18n` → text, `data-i18n-aria-label` / `-placeholder` / `-title` →
 * that attribute. Text only (textContent / setAttribute), never markup.
 */
export function translateDom(root: PageDocument, translate: Translate): void {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = translate(el.dataset.i18n ?? "");
  }
  for (const [data, attr] of [
    ["i18nAriaLabel", "aria-label"],
    ["i18nPlaceholder", "placeholder"],
    ["i18nTitle", "title"],
  ] as const) {
    const selector = `[data-${data.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`;
    for (const el of root.querySelectorAll(selector)) {
      el.setAttribute(attr, translate(el.dataset[data] ?? ""));
    }
  }
}

export function localBridge(): CapybaraLocal | undefined {
  return (globalThis as { capybaraLocal?: CapybaraLocal }).capybaraLocal;
}

/**
 * Runs a page: fetches the state, applies it and calls `render`; then again on every state main
 * pushes. `render` gets a context with the translator for the state's locale and `act`.
 */
export async function startPage<S extends PageState>(
  render: (page: PageContext<S>) => void,
  o: { bridge?: CapybaraLocal; doc?: PageDocument } = {},
): Promise<void> {
  const bridge = o.bridge ?? localBridge();
  const doc = o.doc ?? (globalThis as unknown as { document: PageDocument }).document;
  if (!bridge) return;
  const show = (state: PageState) => {
    applyState(doc.documentElement, state);
    const translate = createTranslate(state.locale);
    translateDom(doc, translate);
    render({
      state: state as S,
      t: translate,
      act: (action, args) => bridge.act(action, args),
    });
  };
  let pushed = false;
  bridge.onState((state) => {
    pushed = true;
    show(state);
  });
  const initial = await bridge.state();
  // A push that arrived while the first state was on its way is newer.
  if (!pushed) show(initial);
}
