// The shell dialog (desktop spec §7.4, board SignOut). Everything shown comes from the state main
// built; the page only reports a click as `dialog.answer` and its height as `dialog.resize`. Main
// decides what an answer means: it drops an early click on the confirming button and handles Esc.
import { type DialogState, dialogButtons, naturalHeight } from "../dialog-model.ts";
import { button, h, mount, platformIcon } from "../kit.ts";
import { type PageContext, startPage } from "../runtime.ts";

function render(ctx: PageContext<DialogState>): void {
  const { state } = ctx;
  document.title = state.title;
  const answer = (index: number) => {
    void ctx.act("dialog.answer", { index }).catch(() => undefined);
  };
  const buttons = dialogButtons(state).map((b) => ({
    spec: b,
    el: button(b.label, { variant: b.variant, small: true, onClick: () => answer(b.index) }),
  }));
  const detail = h("p", { class: "dlg-detail", attrs: { id: "dlg-detail" } }, state.detail);
  const card = h(
    "div",
    {
      class: "dlg",
      attrs: {
        role: "alertdialog",
        "aria-labelledby": "dlg-title",
        "aria-describedby": "dlg-detail",
      },
    },
    h(
      "div",
      { class: "dlg-head" },
      state.platform ? platformIcon(state.platform, { size: "small" }) : null,
      h(
        "div",
        { class: "dlg-heading" },
        h("h1", { class: "dlg-title", attrs: { id: "dlg-title" } }, state.title),
        state.platform?.host ? h("div", { class: "dlg-host" }, state.platform.host) : null,
      ),
    ),
    detail,
    h("div", { class: "dlg-actions" }, ...buttons.map((b) => b.el)),
  );
  mount(card);
  buttons.find((b) => b.spec.focus)?.el.focus();
  requestAnimationFrame(() => {
    const height = naturalHeight(card.offsetHeight, detail.clientHeight, detail.scrollHeight);
    void ctx.act("dialog.resize", { height }).catch(() => undefined);
  });
}

void startPage<DialogState>(render);
