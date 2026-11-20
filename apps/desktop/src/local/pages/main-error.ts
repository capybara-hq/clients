// The main window's error overlay (desktop spec §6.8, board MainErrors): 「登录已过期」 and
// 「平台暂时连不上」. Everything shown comes from the state main built; the page sends the person's
// choices as actions and main decides (sign-in, probe, sign-out, the 「平台」 menu).
import {
  alert,
  button,
  heading,
  hostLine,
  lead,
  link,
  links,
  mount,
  page,
  platformIcon,
  stack,
} from "../kit.ts";
import { type MainErrorState, metaLine } from "../main-error-model.ts";
import { platformLabel, signInErrorKeys } from "../onboarding-model.ts";
import { type PageContext, startPage } from "../runtime.ts";

type Ctx = PageContext<MainErrorState>;

const act = (ctx: Ctx, action: string) => {
  void ctx.act(action).catch(() => undefined);
};

function primary(ctx: Ctx): HTMLButtonElement {
  const { state, t } = ctx;
  if (state.page === "unreachable") {
    return state.probing
      ? button(t("mainError.unreachable.checking"), { disabled: true })
      : button(t("mainError.unreachable.retry"), { onClick: () => act(ctx, "mainError.retry") });
  }
  const signIn = () => act(ctx, "mainError.signIn");
  if (state.waiting) {
    return button(t("mainError.expired.reopen"), { icon: "external", onClick: signIn });
  }
  if (state.error) return button(t(signInErrorKeys(state.error).action), { onClick: signIn });
  return button(t("mainError.expired.signIn"), { icon: "external", onClick: signIn });
}

function render(ctx: Ctx): void {
  const { state, t } = ctx;
  const label = platformLabel(state.platform);
  document.title = label || state.appName;
  const host = state.platform?.host ?? "";
  const expired = state.page !== "unreachable";
  const leadText = !expired
    ? t("mainError.unreachable.lead")
    : state.waiting
      ? t("mainError.expired.waiting")
      : t("mainError.expired.lead");
  const keys = expired && state.error && !state.waiting ? signInErrorKeys(state.error) : null;
  const el = page({
    layout: "wide",
    content: [
      platformIcon(state.platform),
      stack([
        hostLine(metaLine({ ...state, host }, t), { faint: true }),
        heading(t(expired ? "mainError.expired.title" : "mainError.unreachable.title")),
        lead(leadText),
      ]),
      keys ? alert(t(keys.message, { platform: label }), { box: true }) : null,
      primary(ctx),
      links([
        link(t("mainError.signOut"), () => act(ctx, "mainError.signOut")),
        link(t("mainError.switchPlatform"), () => act(ctx, "mainError.switchPlatform")),
      ]),
    ],
  });
  el.classList.add("me-page");
  mount(el);
}

void startPage<MainErrorState>(render);
