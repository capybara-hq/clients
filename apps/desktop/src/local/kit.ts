// The local pages' building blocks (boards in apps/desktop/design/onboarding): the page frame with
// its drag band, the preference bar, the footer, the platform icon, buttons, links, the field, the
// alerts and the step list. Everything is built with createElement and textContent: no markup
// strings, so nothing from a state (a platform name, a host) is ever parsed as HTML.
import type { PagePlatform } from "../shared/local-page.ts";
import { isIconDataUrl } from "./icon-url.ts";
import type { PageContext } from "./runtime.ts";

type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  attrs?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
  hidden?: boolean;
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

function setAttrs(el: Element, attrs: Record<string, string> | undefined): void {
  for (const [name, value] of Object.entries(attrs ?? {})) {
    // Event handler attributes and inline styles are never set from here.
    if (/^on/i.test(name) || name.toLowerCase() === "style") {
      throw new Error(`attribute ${name} is not allowed`);
    }
    el.setAttribute(name, value);
  }
}

/** An HTML element with text children (strings become text nodes). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  setAttrs(el, props.attrs);
  if (props.hidden) el.hidden = true;
  for (const [event, handler] of Object.entries(props.on ?? {})) {
    el.addEventListener(event, handler as EventListener);
  }
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

interface Shape {
  d?: string;
  circle?: [number, number, number];
}

function svg(shapes: Shape[], o: { stroke?: number; fill?: boolean; crisp?: boolean } = {}) {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("focusable", "false");
  if (o.fill) el.setAttribute("fill", "currentColor");
  else {
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "currentColor");
    el.setAttribute("stroke-width", String(o.stroke ?? 1.6));
  }
  if (o.crisp) el.setAttribute("shape-rendering", "crispEdges");
  for (const s of shapes) {
    if (s.circle) {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", String(s.circle[0]));
      c.setAttribute("cy", String(s.circle[1]));
      c.setAttribute("r", String(s.circle[2]));
      el.append(c);
    }
    if (s.d) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", s.d);
      el.append(p);
    }
  }
  return el;
}

export const icons = {
  external: () => svg([{ d: "M9 3h4v4M13 3L7 9M12 9.5V13H3V4h3.5" }]),
  chevron: () => svg([{ d: "M4 6l4 4 4-4" }]),
  sun: () =>
    svg(
      [
        { circle: [8, 8, 3] },
        {
          d: "M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1",
        },
      ],
      { stroke: 1.5 },
    ),
  moon: () => svg([{ d: "M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" }], { stroke: 1.5 }),
  alert: () => svg([{ circle: [8, 8, 6.2] }, { d: "M8 4.8v3.6M8 10.8v.4" }]),
  mark: () =>
    svg(
      [
        {
          d: "M11 3h1v1h-1zM10 4h3v1h-3zM4 5h11v1H4zM3 6h9v1H3zM13 6h2v1h-2zM2 7h13v1H2zM2 8h13v1H2zM2 9h12v1H2zM3 10h10v1H3zM3 11h2v2H3zM7 11h1v2H7zM10 11h2v2h-2z",
        },
      ],
      { fill: true, crisp: true },
    ),
};

/** The full-width top band that drags the window (nothing else sits in the top corners). */
export function dragBand(): HTMLElement {
  return h("div", { class: "lp-drag", attrs: { "aria-hidden": "true" } });
}

/**
 * The page frame: drag band, the centered content column, the preference bar and the footer.
 * `center` for the icon pages, `left` for connect, `wide` for the main window's error pages.
 */
export function page(o: {
  layout?: "left" | "center" | "wide";
  content: Child[];
  prefs?: Node | null;
  footer?: Node | null;
}): HTMLElement {
  const layout = o.layout ?? "center";
  const cls = layout === "left" ? "lp-page" : `lp-page lp-page--${layout}`;
  return h(
    "div",
    { class: cls },
    dragBand(),
    h("main", { class: "lp-content" }, ...o.content),
    o.prefs,
    o.footer,
  );
}

/** Replaces the body's content with `el`. */
export function mount(el: Node, root: HTMLElement = document.body): void {
  root.replaceChildren(el);
}

/**
 * Language menu (中文 / English) and the light / dark toggle; the toggle is left out under a
 * single-scheme theme. Choices go to main as `prefs.setLocale` / `prefs.setTheme`.
 */
export function preferenceBar(ctx: PageContext): HTMLElement {
  const { state, t } = ctx;
  const select = h(
    "select",
    {
      attrs: { "aria-label": t("prefs.language") },
      on: {
        change: () => {
          void ctx.act("prefs.setLocale", { locale: select.value }).catch(() => undefined);
        },
      },
    },
    h("option", { attrs: { value: "zh" } }, t("prefs.language.zh")),
    h("option", { attrs: { value: "en" } }, t("prefs.language.en")),
  );
  select.value = state.locale === "en" ? "en" : "zh";
  const lang = h("label", { class: "lp-lang" }, select, icons.chevron());

  const themeButton = (scheme: "light" | "dark") =>
    h(
      "button",
      {
        attrs: {
          type: "button",
          "aria-label": t(`prefs.theme.${scheme}`),
          "aria-pressed": String(state.appearance.scheme === scheme),
        },
        on: {
          click: () => {
            void ctx.act("prefs.setTheme", { theme: scheme }).catch(() => undefined);
          },
        },
      },
      scheme === "light" ? icons.sun() : icons.moon(),
    );
  const theme = state.appearance.singleScheme
    ? null
    : h(
        "div",
        { class: "lp-theme", attrs: { role: "group", "aria-label": t("prefs.appearance") } },
        themeButton("light"),
        themeButton("dark"),
      );
  return h("div", { class: "lp-prefs" }, lang, theme);
}

/** Bottom-centered footer: `Capybara 桌面端 <version>` with the mark, or a bare host line. */
export function footer(text: string, o: { mark?: boolean } = {}): HTMLElement {
  return h("footer", { class: "lp-footer" }, o.mark ? icons.mark() : null, h("span", {}, text));
}

/** The app footer of the connect and found pages. */
export function appFooter(ctx: PageContext): HTMLElement {
  return footer(
    ctx.t("onboarding.footer", { name: ctx.state.appName, version: ctx.state.version }),
    { mark: true },
  );
}

/** The platform icon (72 px rounded, 40 px in dialogs), or the default icon when none or invalid. */
export function platformIcon(
  platform: PagePlatform | undefined,
  o: { size?: "large" | "small"; dim?: boolean } = {},
): HTMLElement {
  const cls = ["lp-icon", o.size === "small" ? "lp-icon--small" : "", o.dim ? "lp-icon--dim" : ""]
    .filter(Boolean)
    .join(" ");
  const iconUrl = platform?.iconUrl;
  if (isIconDataUrl(iconUrl)) {
    const img = h("img", { class: cls, attrs: { alt: "", draggable: "false" } });
    img.src = iconUrl;
    // A broken image falls back to the default icon.
    img.addEventListener("error", () => img.replaceWith(defaultIcon(cls)), { once: true });
    return img;
  }
  return defaultIcon(cls);
}

function defaultIcon(cls: string): HTMLElement {
  return h(
    "div",
    { class: `${cls} lp-icon--default`, attrs: { "aria-hidden": "true" } },
    icons.mark(),
  );
}

export function heading(text: string, o: { large?: boolean; id?: string } = {}): HTMLElement {
  return h(
    "h1",
    { class: o.large ? "lp-h1 lp-h1--large" : "lp-h1", attrs: o.id ? { id: o.id } : {} },
    text,
  );
}

export function lead(text: string, o: { large?: boolean } = {}): HTMLElement {
  return h("p", { class: o.large ? "lp-lead lp-lead--large" : "lp-lead" }, text);
}

/** A vertical group (title + lead, host line, …). */
export function stack(children: Child[], o: { loose?: boolean } = {}): HTMLElement {
  return h("div", { class: o.loose ? "lp-stack lp-stack--loose" : "lp-stack" }, ...children);
}

export interface ButtonOptions {
  variant?: "primary" | "secondary" | "danger";
  /** Compact, content width (dialogs). */
  small?: boolean;
  icon?: "external";
  /** A key hint after the label (`↵`). */
  kbd?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
}

export function button(label: string, o: ButtonOptions = {}): HTMLButtonElement {
  const variant = o.variant ?? "primary";
  const cls = [
    "lp-btn",
    variant === "primary" ? "" : `lp-btn--${variant}`,
    o.small ? "lp-btn--sm" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const b = h(
    "button",
    {
      class: cls,
      attrs: { type: o.type ?? "button" },
      ...(o.onClick ? { on: { click: o.onClick } } : {}),
    },
    h("span", {}, label),
    o.kbd ? h("span", { class: "lp-kbd", attrs: { "aria-hidden": "true" } }, o.kbd) : null,
    o.icon === "external" ? icons.external() : null,
  );
  b.disabled = o.disabled === true;
  return b;
}

/** A text action styled as a muted link (it is a button: nothing navigates). */
export function link(
  label: string,
  onClick: () => void,
  o: { underline?: boolean; block?: boolean } = {},
): HTMLButtonElement {
  const cls = ["lp-link", o.underline ? "lp-link--underline" : "", o.block ? "lp-link--block" : ""]
    .filter(Boolean)
    .join(" ");
  return h(
    "button",
    { class: cls, attrs: { type: "button" }, on: { click: () => onClick() } },
    label,
  );
}

/** Links side by side with a `|` between them (「退出登录 | 切换平台」). */
export function links(items: HTMLElement[]): HTMLElement {
  const children: Child[] = [];
  items.forEach((item, i) => {
    if (i > 0) children.push(h("span", { class: "lp-sep", attrs: { "aria-hidden": "true" } }, "|"));
    children.push(item);
  });
  return h("div", { class: "lp-links" }, ...children);
}

/** Children side by side, equal widths (the waiting page's two secondary buttons). */
export function row(children: Child[]): HTMLElement {
  return h("div", { class: "lp-row" }, ...children);
}

/** The host in mono, with an optional green dot (reachable) and trailing nodes (· 换一个地址). */
export function hostLine(
  host: string,
  o: { dot?: string; after?: Node; faint?: boolean } = {},
): HTMLElement {
  return h(
    "div",
    { class: o.faint ? "lp-host lp-host--faint" : "lp-host" },
    o.dot !== undefined
      ? h("span", { class: "lp-dot", attrs: { role: "img", "aria-label": o.dot } })
      : null,
    h("span", {}, host),
    o.after ? h("span", { class: "lp-sep-dot", attrs: { "aria-hidden": "true" } }, "·") : null,
    o.after,
  );
}

/** An error message: inline under a field (connect stage) or a box (sign-in stage). */
export function alert(text: string, o: { box?: boolean; id?: string } = {}): HTMLElement {
  return h(
    "div",
    {
      class: o.box ? "lp-alert lp-alert--box" : "lp-alert",
      attrs: { role: "alert", ...(o.id ? { id: o.id } : {}) },
    },
    icons.alert(),
    h("span", {}, text),
  );
}

export interface Field {
  root: HTMLElement;
  input: HTMLInputElement;
  /** Shows the error under the box (and marks it invalid), or clears it with null. */
  setError(text: string | null): void;
}

/** Label, a 44 px box with an optional mono prefix (`https://`), and room for an inline error. */
export function field(o: {
  id: string;
  label: string;
  prefix?: string;
  value?: string;
  placeholder?: string;
  error?: string | null;
}): Field {
  const errorId = `${o.id}-error`;
  const input = h("input", {
    class: "lp-input",
    attrs: {
      id: o.id,
      type: "text",
      inputmode: "url",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      ...(o.placeholder ? { placeholder: o.placeholder } : {}),
    },
  });
  input.value = o.value ?? "";
  const box = h(
    "div",
    { class: "lp-input-box" },
    o.prefix ? h("span", { class: "lp-prefix", attrs: { "aria-hidden": "true" } }, o.prefix) : null,
    input,
  );
  const slot = h("div", {});
  const root = h(
    "div",
    { class: "lp-field" },
    h("label", { class: "lp-label", attrs: { for: o.id } }, o.label),
    box,
    slot,
  );
  const setError = (text: string | null) => {
    if (text) {
      slot.replaceChildren(alert(text, { id: errorId }));
      box.setAttribute("data-invalid", "");
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", errorId);
    } else {
      slot.replaceChildren();
      box.removeAttribute("data-invalid");
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  };
  setError(o.error ?? null);
  return { root, input, setError };
}

export type StepState = "done" | "active" | "todo";

/** The waiting page's list: ✓ for done, the blinking block cursor for the active step. */
export function steps(items: Array<{ label: string; state: StepState }>): HTMLElement {
  return h(
    "ol",
    { class: "lp-steps" },
    ...items.map((item) =>
      h(
        "li",
        { class: "lp-step", attrs: { "data-state": item.state } },
        h(
          "span",
          { class: "lp-step-mark", attrs: { "aria-hidden": "true" } },
          item.state === "done"
            ? "✓"
            : item.state === "active"
              ? h("span", { class: "lp-cursor" })
              : "·",
        ),
        item.label,
      ),
    ),
  );
}
