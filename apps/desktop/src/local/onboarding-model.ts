// The onboarding page's state and its pure parts (no DOM), shared by the main process (which builds
// the state) and the page (which renders it): the views of the small window (spec §6.1, boards
// Main, Found, Waiting, Errors, ErrorsSignIn, SignedOut) and which catalog keys an error uses.
import type { PageState } from "../shared/local-page.ts";

/** The views of the small window, in the order a first launch meets them. */
export type OnboardingPage = "connect" | "found" | "waiting" | "signedOut";

/** Connect-stage errors (spec §6.6): discovery's verdicts plus the host's own. */
export type ConnectError =
  | "unreachable"
  | "not_capybara"
  | "too_old"
  | "not_https"
  | "cert_invalid"
  | "invalid"
  | "locked"
  | "failed";

/** Sign-in-stage errors (spec §6.6), the same codes as the sign-in module's failures. */
export type SignInError =
  | "timeout"
  | "cancelled"
  | "not_allowed"
  | "account_unusable"
  | "link_invalid";

export const CONNECT_ERRORS: readonly ConnectError[] = [
  "unreachable",
  "not_capybara",
  "too_old",
  "not_https",
  "cert_invalid",
  "invalid",
  "locked",
  "failed",
];

export const SIGN_IN_ERRORS: readonly SignInError[] = [
  "timeout",
  "cancelled",
  "not_allowed",
  "account_unusable",
  "link_invalid",
];

export type OnboardingFields = {
  page: OnboardingPage;
  /** The connect field's text (what was typed, or a deep link's address). */
  address: string;
  /**
   * Bumped whenever main sets `address` (a prefill, back from 换一个地址): the page writes the field
   * only then, so a push for any other reason never overwrites what the person is typing.
   */
  prefill: number;
  /** A `ConnectError` on the connect page, a `SignInError` on the found page; else null. */
  error: string | null;
  /** The host the connect error names (`连接不上 <host>`). */
  errorHost: string | null;
  /** Discovery is running (the connect button shows 正在连接…). */
  busy: boolean;
  /** This machine's name, as the authorize page shows it (the waiting page's lead). */
  machine: string;
  /** The signed-out page's account (display name and login). */
  account: { name: string; login: string } | null;
  /** The signed-out page: this machine has a connection into that deployment. */
  deviceConnected: boolean;
  /** Whether 「移除这个平台」 is offered (never under a managed lock). */
  canRemove: boolean;
};

/** Intersected with the default PageState, so it passes where a PageState is expected. */
export type OnboardingState = PageState & OnboardingFields;

function isConnectError(v: unknown): v is ConnectError {
  return typeof v === "string" && (CONNECT_ERRORS as readonly string[]).includes(v);
}

function isSignInError(v: unknown): v is SignInError {
  return typeof v === "string" && (SIGN_IN_ERRORS as readonly string[]).includes(v);
}

/** The message and the button label of a connect error (an unknown code reads as `failed`). */
export function connectErrorKeys(error: unknown): { message: string; action: string } {
  const code = isConnectError(error) ? error : "failed";
  return {
    message: `onboarding.connect.error.${code}`,
    action: `onboarding.connect.action.${code}`,
  };
}

/** The message and the button label of a sign-in error (an unknown code reads as link invalid). */
export function signInErrorKeys(error: unknown): { message: string; action: string } {
  const code = isSignInError(error) ? error : "link_invalid";
  return {
    message: `onboarding.signIn.error.${code}`,
    action: `onboarding.signIn.action.${code}`,
  };
}

/** The platform as the pages name it: its name, else its host. */
export function platformLabel(platform: { name?: string; host?: string } | undefined): string {
  return platform?.name?.trim() || platform?.host || "";
}

/** The signed-out page's account line: the login (else the name), with the device note. */
export function accountLine(
  account: { name: string; login: string } | null,
  t: (key: string, vars?: Record<string, string>) => string,
  deviceConnected = false,
): string {
  const who = account ? account.login || account.name : "";
  if (who && deviceConnected) return t("onboarding.signedOut.accountDevice", { account: who });
  if (who) return t("onboarding.signedOut.account", { account: who });
  return deviceConnected ? t("onboarding.signedOut.device") : "";
}
