// The address page (spec §4.1): the person types a platform address, discovery answers with the
// deployment's name and icon, and Sign in hands the address on. Plain DOM, no design package, the
// same layout as the desktop's connect page. The state machine is src/runtime/address-model.ts.
import { registerPlugin } from "@capacitor/core";
import { type Locale, t } from "@capybara-hq/shell";
import { brand } from "../../../brand.ts";
import {
  type AddressModel,
  type AddressState,
  createAddressModel,
  errorKey,
  type FoundDeployment,
} from "../../runtime/address-model.ts";
import { effectivePreset, type HttpGetNative, httpGetPortFrom } from "../../runtime/discovery.ts";

// ---- the page ----

type Handoff = (found: FoundDeployment) => void;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountAddressPage(
  root: HTMLElement,
  deps: { model: AddressModel; locale: Locale; onSignIn: Handoff },
): void {
  const { model, locale } = deps;
  const tr = (key: string, vars?: Record<string, string>) => t(locale, key, vars);
  let input: HTMLInputElement | null = null;

  const render = (state: AddressState) => {
    const typed = input?.value ?? "";
    root.replaceChildren();
    const page = el("main", "ad-page");
    if (state.phase === "found") {
      page.append(foundView(state.found));
      root.append(page);
      return;
    }
    const form = el("form", "ad-form");
    form.noValidate = true;
    const label = el("label", "ad-label", tr("address.label"));
    input = el("input", "ad-input");
    input.type = "url";
    input.inputMode = "url";
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = tr("address.placeholder");
    input.value = typed;
    input.disabled = state.phase === "checking";
    label.append(input);
    form.append(label);
    if (state.phase === "error") {
      const alert = el("p", "ad-alert", tr(errorKey(state.error), { host: state.host }));
      alert.setAttribute("role", "alert");
      form.append(alert);
    }
    const button = el(
      "button",
      "ad-button",
      tr(state.phase === "checking" ? "address.checking" : "address.continue"),
    );
    button.type = "submit";
    button.disabled = state.phase === "checking";
    form.append(button);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void model.submit(input?.value ?? "");
    });
    page.append(el("h1", "ad-title", tr("address.title")), el("p", "ad-lead", tr("address.lead")));
    page.append(form);
    root.append(page);
  };

  const foundView = (found: FoundDeployment) => {
    const box = el("section", "ad-found");
    if (found.iconUrl) {
      const img = el("img", "ad-icon");
      img.src = found.iconUrl;
      img.alt = "";
      img.width = 64;
      img.height = 64;
      box.append(img);
    }
    box.append(el("h1", "ad-title", found.name ?? new URL(found.base).host));
    box.append(el("p", "ad-host", new URL(found.base).host));
    const signIn = el("button", "ad-button", tr("address.found.signin"));
    signIn.type = "button";
    signIn.addEventListener("click", () => deps.onSignIn(found));
    const change = el("button", "ad-link", tr("address.found.change"));
    change.type = "button";
    change.addEventListener("click", () => model.reset());
    box.append(signIn, change);
    return box;
  };

  model.subscribe(render);
  render(model.state());
}

// Runs only inside the page (never under vitest, which has no document).
const appRoot = typeof document !== "undefined" ? document.getElementById("app") : null;
if (appRoot) {
  const native = registerPlugin<HttpGetNative>("CapybaraHost");
  const preset = effectivePreset(brand, null);
  const locale: Locale = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  mountAddressPage(appRoot, {
    model: createAddressModel({
      httpGet: httpGetPortFrom(native),
      lockedBase: preset?.locked ? preset.base : null,
    }),
    locale,
    // Sign-in is Task 17: until it lands the page only reports the choice.
    onSignIn: (found) =>
      window.dispatchEvent(new CustomEvent("capybara:address", { detail: found })),
  });
}
