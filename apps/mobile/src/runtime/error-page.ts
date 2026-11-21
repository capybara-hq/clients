// The error state's model and messages (the page is src/local/error/error.ts): what the local
// error page shows for a profile that could not load, and the postMessage shapes between it and
// the runtime. Pure, so vitest reads it without a DOM.
import { type Locale, t } from "@capybara-hq/shell";
import type { ErrorState } from "./loader.ts";

export interface ErrorModel {
  title: string;
  lead: string;
  code: string | null;
  actions: { id: "retry" | "switch"; label: string }[];
  switcher: {
    title: string;
    items: { id: string; label: string; current: boolean }[];
    add: string;
  };
}

export function errorModel(state: ErrorState, locale: Locale): ErrorModel {
  return {
    title: t(locale, "error.title"),
    lead: t(locale, `error.lead.${state.kind}`, { host: state.host }),
    code: state.code ? t(locale, "error.code", { code: state.code }) : null,
    actions: [
      { id: "retry", label: t(locale, "error.retry") },
      { id: "switch", label: t(locale, "error.switch_platform") },
    ],
    switcher: {
      title: t(locale, "profile.switcher.title"),
      items: state.profiles.map((p) => ({ id: p.id, label: p.label, current: p.current })),
      add: t(locale, "profile.switcher.add"),
    },
  };
}

/** The page to runtime messages. */
export type ErrorPageMessage =
  | { type: "error-page-ready" }
  | { type: "error-action"; action: "retry" | "add" }
  | { type: "error-action"; action: "open"; profileId: string };

/** The runtime to page message. */
export interface ErrorStateMessage {
  type: "error-state";
  state: ErrorState;
  locale: Locale;
}

export function isErrorPageMessage(v: unknown): v is ErrorPageMessage {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.type === "error-page-ready") return true;
  if (r.type !== "error-action") return false;
  if (r.action === "retry" || r.action === "add") return true;
  return r.action === "open" && typeof r.profileId === "string";
}
