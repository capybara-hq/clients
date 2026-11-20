// The shell dialog page's pure parts (no DOM), so they are unit-tested: which button looks how,
// and the height the window should take.
import type { PageState } from "../shared/local-page.ts";

export type DialogFields = {
  title: string;
  detail: string;
  buttons: string[];
  cancelId: number;
  /** The confirming button, which takes no answer in the first 500 ms; null when none. */
  confirmId: number | null;
  tone: "primary" | "danger";
};

/** Intersected with the default PageState, so it passes where a PageState is expected. */
export type DialogState = PageState & DialogFields;

export interface DialogButton {
  index: number;
  label: string;
  variant: "primary" | "secondary" | "danger";
  /** The focus starts here: always the cancel button (spec §7.4). */
  focus: boolean;
}

/** The buttons in the given order (cancel first, the confirming button last). */
export function dialogButtons(state: DialogState): DialogButton[] {
  const buttons = Array.isArray(state.buttons) ? state.buttons : [];
  return buttons.map((label, index) => ({
    index,
    label: String(label),
    variant:
      index === state.confirmId ? (state.tone === "danger" ? "danger" : "primary") : "secondary",
    focus: index === state.cancelId,
  }));
}

/**
 * The card's natural height: its laid-out height with the detail's visible part replaced by the
 * detail's full height (past the window's maximum the detail scrolls inside the card).
 */
export function naturalHeight(card: number, detailVisible: number, detailFull: number): number {
  return Math.ceil(card - detailVisible + Math.max(detailVisible, detailFull));
}
