// The small window's pages (desktop spec §6.1, §6.6): connect, found, waiting and signed-out, with
// the errors inline. Everything shown comes from the state main built; the page sends the person's
// choices as actions and main decides what happens (discovery, sign-in, saving).

import {
  alert,
  appFooter,
  button,
  field,
  footer,
  h,
  heading,
  hostLine,
  lead,
  link,
  links,
  mount,
  page,
  platformIcon,
  preferenceBar,
  row,
  stack,
  steps,
} from "../kit.ts";
import {
  accountLine,
  connectErrorKeys,
  type OnboardingState,
  platformLabel,
  signInErrorKeys,
} from "../onboarding-model.ts";
import { type PageContext, startPage } from "../runtime.ts";

type Ctx = PageContext<OnboardingState>;

const act = (ctx: Ctx, action: string, args?: Record<string, unknown>) => {
  void ctx.act(action, args).catch(() => undefined);
};

/** The connect field across re-renders: what the person typed survives a push. */
let connectInput: HTMLInputElement | null = null;
let renderedPrefill = -1;

const SCHEME = /^(https?:\/\/)(.*)$/i;

/** Splits an address into the prefix shown before the field and the field's text. */
function splitAddress(address: string): { prefix: string; text: string } {
  const m = SCHEME.exec(address.trim());
  return m
    ? { prefix: (m[1] as string).toLowerCase(), text: m[2] as string }
    : { prefix: "https://", text: address };
}

function connectView(ctx: Ctx): HTMLElement {
  const { state, t } = ctx;
  // Main set the address (a prefill, back from 换一个地址): write it; else keep the typed text.
  const keep = connectInput !== null && state.prefill === renderedPrefill;
  const typed = keep ? (connectInput as HTMLInputElement).value : null;
  const hadFocus = keep && document.activeElement === connectInput;
  renderedPrefill = state.prefill;
  // The prefix shows the address's scheme (https:// unless one was typed), the field the rest; a
  // kept field whose text still carries the prefix it shows keeps that prefix too.
  const typedSplit = typed !== null && SCHEME.test(typed.trim()) ? splitAddress(typed) : null;
  const shownPrefix = keep
    ? (connectInput?.parentElement?.querySelector(".lp-prefix")?.textContent ?? "https://")
    : null;
  const split =
    typedSplit ??
    (typed !== null
      ? { prefix: shownPrefix ?? "https://", text: typed }
      : splitAddress(state.address));
  const value = split.text;

  const errorKeys = state.error ? connectErrorKeys(state.error) : null;
  const errorText = errorKeys ? t(errorKeys.message, { host: state.errorHost ?? "" }) : null;
  const f = field({
    id: "address",
    label: t("onboarding.connect.label"),
    prefix: split.prefix,
    value,
    placeholder: t("onboarding.connect.placeholder"),
    error: errorText,
  });
  const prefixEl = f.root.querySelector(".lp-prefix");
  // A scheme typed into the field replaces the one shown before it.
  const syncPrefix = () => prefixEl?.toggleAttribute("hidden", SCHEME.test(f.input.value.trim()));
  syncPrefix();
  connectInput = f.input;

  const idle = () => button(t("onboarding.connect.continue"), { type: "submit", kbd: "↵" });
  let submit = state.busy
    ? button(t("onboarding.connect.checking"), { type: "submit", disabled: true })
    : errorKeys
      ? button(t(errorKeys.action), { type: "submit" })
      : idle();
  f.input.disabled = state.busy;
  // Typing clears a shown error here; main keeps it until the next submit.
  f.input.addEventListener("input", () => {
    syncPrefix();
    if (!errorKeys || state.busy) return;
    f.setError(null);
    f.input.closest(".lp-page")?.classList.remove("ob-error");
    const next = idle();
    submit.replaceWith(next);
    submit = next;
  });

  const form = h(
    "form",
    {
      class: "ob-form",
      attrs: { novalidate: "" },
      on: {
        submit: (event) => {
          event.preventDefault();
          if (state.busy) return;
          const text = f.input.value.trim();
          const shown = prefixEl && !prefixEl.hasAttribute("hidden") ? split.prefix : "";
          const address = text === "" || SCHEME.test(text) ? text : `${shown}${text}`;
          act(ctx, "connect.submit", { address });
        },
      },
    },
    f.root,
    submit,
  );
  const el = page({
    layout: "left",
    content: [
      stack(
        [
          heading(t("onboarding.connect.title"), { large: true }),
          lead(t("onboarding.connect.lead"), { large: true }),
        ],
        {
          loose: true,
        },
      ),
      form,
    ],
    prefs: preferenceBar(ctx),
    footer: appFooter(ctx),
  });
  // Boards Errors: the content block sits higher while an error shows.
  if (errorKeys) el.classList.add("ob-error");
  queueMicrotask(() => {
    if (state.busy) return;
    if (!keep || hadFocus || errorKeys) {
      f.input.focus();
      if (!keep) f.input.select();
    }
  });
  return el;
}

function foundView(ctx: Ctx): HTMLElement {
  const { state, t } = ctx;
  const title = t("onboarding.found.title", { platform: platformLabel(state.platform) });
  const host = state.platform?.host ?? "";
  const change = () => act(ctx, "found.changeAddress");
  if (state.error) {
    // Board ErrorsSignIn: the host without the dot, the alert box, the error's own button.
    const keys = signInErrorKeys(state.error);
    const el = page({
      layout: "center",
      content: [
        platformIcon(state.platform),
        stack([heading(title), hostLine(host)]),
        alert(t(keys.message, { platform: platformLabel(state.platform) }), { box: true }),
        button(t(keys.action), { onClick: () => act(ctx, "found.signIn") }),
        link(t("onboarding.found.change"), change),
      ],
      prefs: preferenceBar(ctx),
      footer: appFooter(ctx),
    });
    el.classList.add("ob-found", "ob-error");
    return el;
  }
  const el = page({
    layout: "center",
    content: [
      platformIcon(state.platform),
      stack([
        heading(title),
        hostLine(host, {
          dot: t("onboarding.found.reachable"),
          after: link(t("onboarding.found.change"), change, { underline: true }),
        }),
      ]),
      button(t("onboarding.found.signIn"), {
        icon: "external",
        onClick: () => act(ctx, "found.signIn"),
      }),
      lead(t("onboarding.found.hint")),
    ],
    prefs: preferenceBar(ctx),
    footer: appFooter(ctx),
  });
  el.classList.add("ob-found");
  return el;
}

function waitingView(ctx: Ctx): HTMLElement {
  const { state, t } = ctx;
  const copy = button(t("onboarding.waiting.copy"), {
    variant: "secondary",
    onClick: () => {
      void ctx.act("waiting.copyLink").then(
        (ok) => {
          if (ok !== true) return;
          const label = copy.querySelector("span");
          if (label) label.textContent = t("onboarding.waiting.copied");
          setTimeout(() => {
            if (label) label.textContent = t("onboarding.waiting.copy");
          }, 2000);
        },
        () => undefined,
      );
    },
  });
  return page({
    layout: "center",
    content: [
      platformIcon(state.platform),
      stack([
        heading(t("onboarding.waiting.title")),
        lead(t("onboarding.waiting.lead", { machine: state.machine })),
      ]),
      steps([
        { label: t("onboarding.waiting.step.opened"), state: "done" },
        { label: t("onboarding.waiting.step.confirm"), state: "active" },
        { label: t("onboarding.waiting.step.return"), state: "todo" },
      ]),
      h(
        "div",
        { class: "ob-actions" },
        row([
          button(t("onboarding.waiting.reopen"), {
            variant: "secondary",
            onClick: () => act(ctx, "waiting.reopen"),
          }),
          copy,
        ]),
        link(t("onboarding.waiting.cancel"), () => act(ctx, "waiting.cancel"), { block: true }),
      ),
    ],
    prefs: preferenceBar(ctx),
    footer: footer(state.platform?.host ?? ""),
  });
}

function signedOutView(ctx: Ctx): HTMLElement {
  const { state, t } = ctx;
  const line = accountLine(state.account, t);
  const actions = [link(t("onboarding.signedOut.addOther"), () => act(ctx, "signedOut.addOther"))];
  if (state.canRemove) {
    actions.push(link(t("onboarding.signedOut.remove"), () => act(ctx, "signedOut.remove")));
  }
  // A sign-in started here that failed: the error box above the button (ErrorsSignIn's form).
  const keys = state.error ? signInErrorKeys(state.error) : null;
  const signIn = () => act(ctx, "signedOut.signIn");
  const el = page({
    layout: "center",
    content: [
      platformIcon(state.platform, { dim: true }),
      stack([
        heading(t("onboarding.signedOut.title", { platform: platformLabel(state.platform) })),
        line ? lead(line) : null,
      ]),
      keys
        ? alert(t(keys.message, { platform: platformLabel(state.platform) }), { box: true })
        : null,
      keys
        ? button(t(keys.action), { onClick: signIn })
        : button(t("onboarding.signedOut.signIn"), { icon: "external", onClick: signIn }),
      links(actions),
    ],
    prefs: preferenceBar(ctx),
    footer: footer(state.platform?.host ?? ""),
  });
  if (keys) el.classList.add("ob-error");
  return el;
}

function render(ctx: Ctx): void {
  const { state } = ctx;
  document.title = platformLabel(state.platform) || state.appName;
  if (state.page !== "connect") connectInput = null;
  switch (state.page) {
    case "found":
      mount(foundView(ctx));
      return;
    case "waiting":
      mount(waitingView(ctx));
      return;
    case "signedOut":
      mount(signedOutView(ctx));
      return;
    default:
      mount(connectView(ctx));
  }
}

void startPage<OnboardingState>(render);
