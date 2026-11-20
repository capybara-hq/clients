// The address page (spec §4.1): the person types a platform address, discovery answers with the
// deployment's name and icon, and Sign in hands the address on. Plain DOM, no design package, the
// same layout as the desktop's connect page. The state machine is src/runtime/address-model.ts.
//
// The page is framed over the runtime document and uses no Capacitor plugin (N1: iOS injects the
// bridge in the main frame only). It asks the runtime over its port (src/runtime/address-bridge.ts,
// local-channel.ts): the runtime discovers, adds the profile and opens it. Same-origin with the
// runtime, it is trusted bundled code, not isolated: remote data is rendered as text only.
import { type Locale, t } from "@capybara-hq/shell";
import { type AddressClient, createAddressClient } from "../../runtime/address-bridge.ts";
import {
  type AddressModel,
  type AddressState,
  createAddressModel,
  errorKey,
  type FoundDeployment,
} from "../../runtime/address-model.ts";
import { createRuntimeLink } from "../../runtime/local-channel.ts";

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
  deps: { model: AddressModel; locale: Locale; onSignIn: Handoff; onBack?: () => void },
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
    const { onBack } = deps;
    if (onBack) {
      const back = el("button", "ad-link", tr("dialog.cancel"));
      back.type = "button";
      back.addEventListener("click", () => onBack());
      page.append(back);
    }
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
if (appRoot && window.parent !== window) {
  let client: AddressClient | null = null;
  const link = createRuntimeLink({
    parent: window.parent,
    origin: location.origin,
    onMessage: (data) => client?.receive(data),
  });
  window.addEventListener("message", (event) => link.receive(event));
  client = createAddressClient({ post: (message) => link.post(message) });
  const runtime = client;
  const locale: Locale = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  // `?back=1`: the runtime framed the page over something to return to (the error page).
  const canGoBack = new URLSearchParams(location.search).get("back") === "1";
  mountAddressPage(appRoot, {
    model: createAddressModel({ discover: (input) => runtime.discover(input) }),
    locale,
    // Sign-in is Task 17: for now choosing the deployment adds it and opens it.
    onSignIn: (found) => runtime.choose(found.base),
    ...(canGoBack ? { onBack: () => runtime.close() } : {}),
  });
}
