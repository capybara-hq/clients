// The error state (mobile spec §4.3, §4.4): a local page shown instead of a profile page that could
// not load. It offers retry and the profile switcher; on a TLS error there is no way to proceed.
// The runtime frames it over its own document (index.html) and talks to it with `postMessage` on
// the local origin only: the runtime sends the state, the page sends the person's choice back. It
// has no Capacitor plugin of its own and no Shell environment: it is not a profile document.
import {
  type ErrorModel,
  type ErrorPageMessage,
  type ErrorStateMessage,
  errorModel,
} from "../../runtime/error-page.ts";

function render(doc: Document, model: ErrorModel, send: (m: ErrorPageMessage) => void): void {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const main = el("main");
  main.append(el("h1", model.title), el("p", model.lead, "lead"));
  if (model.code) main.append(el("p", model.code, "code"));
  const actions = el("div", undefined, "actions");
  const list = el("div", undefined, "switcher");
  list.hidden = true;
  for (const action of model.actions) {
    const button = el("button", action.label, action.id === "retry" ? "primary" : "secondary");
    button.type = "button";
    button.addEventListener("click", () => {
      if (action.id === "retry") send({ type: "error-action", action: "retry" });
      else list.hidden = !list.hidden;
    });
    actions.append(button);
  }
  list.append(el("h2", model.switcher.title));
  for (const item of model.switcher.items) {
    const button = el("button", item.label, item.current ? "item current" : "item");
    button.type = "button";
    button.addEventListener("click", () =>
      send(
        item.current
          ? { type: "error-action", action: "retry" }
          : { type: "error-action", action: "open", profileId: item.id },
      ),
    );
    list.append(button);
  }
  const add = el("button", model.switcher.add, "item add");
  add.type = "button";
  add.addEventListener("click", () => send({ type: "error-action", action: "add" }));
  list.append(add);
  main.append(actions, list);
  doc.body.replaceChildren(main);
}

function isErrorStateMessage(v: unknown): v is ErrorStateMessage {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.type === "error-state" &&
    (r.locale === "zh" || r.locale === "en") &&
    typeof r.state === "object" &&
    r.state !== null
  );
}

function boot(): void {
  const own = window.location.origin;
  const parent = window.parent;
  if (parent === window) return;
  const send = (m: ErrorPageMessage) => parent.postMessage(m, own);
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== own || !isErrorStateMessage(event.data)) return;
    document.documentElement.lang = event.data.locale === "zh" ? "zh-CN" : "en";
    render(document, errorModel(event.data.state, event.data.locale), send);
  });
  send({ type: "error-page-ready" });
}

if (typeof window !== "undefined" && typeof document !== "undefined") boot();
