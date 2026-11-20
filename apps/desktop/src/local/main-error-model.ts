// The main window's error overlay (desktop spec §6.8, board MainErrors): its state and the pure
// parts shared by the main process (which builds the state) and the page (which renders it).
import type { PageState } from "../shared/local-page.ts";

/** The two pages that cover a main window's web contents. */
export type MainErrorPage = "expired" | "unreachable";

export type MainErrorFields = {
  page: MainErrorPage;
  /** Expired: the failure of the last re-sign-in (a sign-in error code, spec §6.6); else null. */
  error: string | null;
  /** Expired: a sign-in in the browser is pending (the button reopens its authorize URL). */
  waiting: boolean;
  /** Unreachable: a probe of `/api/v1/meta` is running (重试 shows it is busy). */
  probing: boolean;
  /**
   * Unreachable: when the window first failed to load (epoch ms); null on the expired page. The
   * page ticks the elapsed time itself from it.
   */
  downSince: number | null;
};

export type MainErrorState = PageState & MainErrorFields;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** How long, in the largest whole unit: `5 分钟`, `40 秒`, `2 小时`. */
export function duration(
  ms: number,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  const elapsed = Math.max(0, ms);
  if (elapsed < MINUTE) {
    return t("mainError.duration.seconds", { count: String(Math.floor(elapsed / SECOND)) });
  }
  if (elapsed < HOUR) {
    return t("mainError.duration.minutes", { count: String(Math.floor(elapsed / MINUTE)) });
  }
  return t("mainError.duration.hours", { count: String(Math.floor(elapsed / HOUR)) });
}

/**
 * The line above the title: the host, and on the unreachable page how long it has not answered
 * (board MainErrors: `capybara.meta1.top · 5 分钟无响应`).
 */
export function metaLine(
  state: Pick<MainErrorFields, "page" | "downSince"> & { host: string; now: number },
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  if (state.page !== "unreachable" || state.downSince === null) return state.host;
  return t("mainError.unreachable.meta", {
    host: state.host,
    duration: duration(state.now - state.downSince, t),
  });
}
