// Sign-in through the system browser (mobile spec §4.3, desktop spec §6.5): the authorization code
// flow with PKCE for native apps (RFC 8252, RFC 7636), the issuer checked on the callback
// (RFC 9207). iOS shows `ASWebAuthenticationSession` (AuthSession.swift), Android Custom Tabs
// with the callback activity (AuthSession.kt); both hand back the `<scheme>://auth/callback` link
// of the attempt they started, or `cancelled`.
//
// The deployment's address is always the stored profile's, never a page's. The verifier and
// `state` live only in this document's memory, bound to the one attempt and the profile's base,
// for `SIGN_IN_TTL_MS` and one use (a used state is never accepted again). The code exchange runs
// in the profile's own WebView (`exchange`, decision 6: `callAsyncJavaScript` in the
// `.defaultClient` world on iOS, `evaluateJavascript` on Android), only while its top document is on
// the profile origin, so the session cookie lands in that profile's data store and nowhere else.
// Nothing here logs or keeps a code, a verifier or a token; a page learns only the outcome.
import { SHELL_CAPABILITY_KEYS } from "@capybara-hq/plugin-sdk";
import type { Meta } from "@capybara-hq/shell";
import { checkCallback, createPkceWeb, parseDeepLink, SIGN_IN_TTL_MS } from "@capybara-hq/shell";
import { discover, type HttpGetPort } from "./discovery.ts";
import type { ProfileRef } from "./protocol.ts";
import type { CapabilityImpl } from "./registry.ts";

export const SIGN_IN_KEY = SHELL_CAPABILITY_KEYS.signIn;

/** The token exchange route under the deployment's base. */
export const TOKEN_PATH = "/api/v1/app-auth/token";
/** The kernel's logout route under the base: ends a session the app did not want. */
export const LOGOUT_PATH = "/api/v1/auth/logout";

/** The fields of a stored profile sign-in reads (Task 14's `Profile` has them). */
export interface SignInProfile extends ProfileRef {
  base: string;
}

/** What the browser session hands back: the callback link it caught, or a dismissal. */
export type AuthAnswer = { callback: string } | { cancelled: true };

export interface ExchangeResult {
  ok: boolean;
  status: number;
  /** The response named an account (the body is read natively and never crosses further). */
  hasAccount: boolean;
}

export interface SignInDeps<P extends SignInProfile = SignInProfile> {
  /** The system browser session (`ASWebAuthenticationSession` / Custom Tabs). */
  auth: { start(url: string, scheme: string): Promise<AuthAnswer> };
  /** POSTs `body` to `url` from the profile WebView's top document (see the file comment). */
  exchange(profileId: string, req: { url: string; body: string }): Promise<ExchangeResult>;
  /** The profile WebView's top-level origin now; null when it has none. */
  currentOrigin(profileId: string): Promise<string | null>;
  reload(profileId: string): Promise<void>;
  /**
   * POSTs a logout to `url` from the profile's top document, the same path as `exchange`: ends a
   * session the app did not want (a 2xx exchange answer without an account, as the desktop does).
   */
  revoke(profileId: string, req: { url: string }): Promise<void>;
  /** Shown on the consent page and in the session's user agent (`Capybara Mobile/<v> (<name>)`). */
  deviceName: string;
  appVersion: string;
  now(): number;
  /** A fresh unguessable state (32 random bytes, base64url). */
  newState(): string;
  /** The brand's URL scheme; the redirect URI is `<scheme>://auth/callback`. */
  scheme: string;
  /** The stored profiles now: an attempt holds for its profile only while it is stored as it was. */
  profiles: { list(): P[] };
  pkce?: () => Promise<{ verifier: string; challenge: string }>;
  /** Only outcomes and statuses are logged, never a code, a verifier, a state or a token. */
  log?: (message: string) => void;
}

/** What `begin` resolves to; a page sees only `signedIn` or `cancelled` (else `failed`/`busy`). */
export type SignInOutcome = "signedIn" | "cancelled" | "failed" | "busy";

export interface SignIn<P extends SignInProfile = SignInProfile> {
  /** `signIn@1`: `start` is confirming (user activation and the per-profile dialog gate). */
  capability: CapabilityImpl<P>;
  /** The address page's Sign in: an attempt for a stored profile, without a page call. */
  begin(profileId: string): Promise<SignInOutcome>;
}

const NAME_MAX = 64;
const VERSION_MAX = 32;
/** What the kernel accepts in `name` / `app_version`: no control, format or unassigned chars. */
const NOT_PRINTABLE = /\p{C}/gu;

function printable(text: string, max: number, fallback: string): string {
  const clean = [...text.replace(NOT_PRINTABLE, "").trim()].slice(0, max).join("").trim();
  return clean === "" ? fallback : clean;
}

/** A state of 32 random bytes, base64url. */
export function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const failed = (code: "failed" | "busy" = "failed") => Object.freeze({ code });

export function createSignIn<P extends SignInProfile>(deps: SignInDeps<P>): SignIn<P> {
  const redirectUri = `${deps.scheme}://auth/callback`;
  const name = printable(deps.deviceName, NAME_MAX, "Mobile");
  const appVersion = printable(deps.appVersion, VERSION_MAX, "0.0.0");
  const pkce = deps.pkce ?? (() => createPkceWeb());
  const log = (message: string) => deps.log?.(message);
  /** States handed out, kept for one TTL: a state is used once, whatever came of it. */
  const used = new Map<string, number>();
  let running = false;

  const stored = (id: string) => deps.profiles.list().find((p) => p.id === id);

  function authorizeUrl(base: string, challenge: string, state: string): string {
    const q = new URLSearchParams({
      client: "mobile",
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      name,
      app_version: appVersion,
    });
    return `${base}/apps/authorize?${q.toString()}`;
  }

  function forgetOld(now: number): void {
    for (const [state, at] of used) if (now - at > SIGN_IN_TTL_MS) used.delete(state);
  }

  /** One attempt for the stored profile `profileId`; never rejects. */
  async function attempt(profileId: string): Promise<SignInOutcome> {
    const profile = stored(profileId);
    if (!profile) return "failed";
    const base = profile.base;
    const createdAt = deps.now();
    forgetOld(createdAt);
    const state = deps.newState();
    // A state seen before (a broken generator) never starts an attempt: its old link could match.
    if (state === "" || used.has(state)) {
      log("sign-in refused (state reused)");
      return "failed";
    }
    used.set(state, createdAt);
    let verifier: string;
    let challenge: string;
    try {
      ({ verifier, challenge } = await pkce());
    } catch {
      return "failed";
    }

    let answer: AuthAnswer;
    try {
      answer = await deps.auth.start(authorizeUrl(base, challenge, state), deps.scheme);
    } catch {
      log("sign-in could not open the browser");
      return "failed";
    }
    if ("cancelled" in answer) return "cancelled";

    const link =
      typeof answer.callback === "string" ? parseDeepLink(answer.callback, deps.scheme) : null;
    if (link?.kind !== "auth") {
      log("sign-in callback refused (not a callback link)");
      return "failed";
    }
    const verdict = checkCallback(link, { state, base, createdAt }, deps.now());
    if (verdict !== "ok") {
      log(`sign-in callback refused (${verdict})`);
      return "failed";
    }
    if (link.error !== undefined) return link.error === "access_denied" ? "cancelled" : "failed";
    if (typeof link.code !== "string") return "failed";

    // Removed or re-pointed meanwhile: the attempt belonged to the profile as it was.
    const now = stored(profileId);
    if (!now || now.base !== base || now.origin !== profile.origin) {
      log("sign-in callback refused (profile gone)");
      return "failed";
    }
    // The exchange runs in the profile's top document: only on its own origin.
    let origin: string | null;
    try {
      origin = await deps.currentOrigin(profileId);
    } catch {
      origin = null;
    }
    if (origin !== profile.origin) {
      log("sign-in callback refused (profile off its origin)");
      return "failed";
    }

    let result: ExchangeResult;
    try {
      result = await deps.exchange(profileId, {
        url: `${base}${TOKEN_PATH}`,
        body: JSON.stringify({ code: link.code, codeVerifier: verifier, redirectUri }),
      });
    } catch {
      log("sign-in exchange failed");
      return "failed";
    }
    if (!result.ok) {
      log(`sign-in exchange refused (${Number(result.status) || 0})`);
      return "failed";
    }
    if (!result.hasAccount) {
      // A 2xx may have set the session cookie: end that session before reporting the failure.
      log("sign-in exchange answered without an account");
      try {
        await deps.revoke(profileId, { url: `${base}${LOGOUT_PATH}` });
      } catch {
        log("sign-in revoke failed");
      }
      return "failed";
    }
    try {
      await deps.reload(profileId);
    } catch {
      log("reloading after sign-in failed");
    }
    return "signedIn";
  }

  /** One attempt in the whole app at a time: the system shows one browser session. */
  async function begin(profileId: string): Promise<SignInOutcome> {
    if (running) return "busy";
    running = true;
    try {
      return await attempt(profileId);
    } finally {
      running = false;
    }
  }

  return {
    begin,
    capability: {
      functions: {
        async start(ctx) {
          const outcome = await begin(ctx.profile.id);
          if (outcome === "signedIn" || outcome === "cancelled") return outcome;
          throw failed(outcome === "busy" ? "busy" : "failed");
        },
      },
      confirming: ["start"],
    },
  };
}

/** Whether a profile's deployment can do app sign-in, from its `GET /api/v1/meta`. */
export interface SignInSupport {
  /** Asks the deployment; `too_old` when its meta has no `features.appSignIn`. */
  check(profile: SignInProfile): Promise<"ok" | "too_old" | "unknown">;
  /** False only for a deployment known to be too old: `signIn@1` is then not offered. */
  available(profile: SignInProfile): boolean;
}

export function createSignInSupport(deps: {
  httpGet: HttpGetPort;
  /** The profile's deployment turned out too old: show the "too old" error state. */
  onTooOld(profileId: string): void;
  /**
   * Each meta read for a profile (push reads `features.push` from it, so it is read once); null
   * when the read failed or the deployment is too old.
   */
  onMeta?(profile: SignInProfile, meta: Meta | null): void;
}): SignInSupport {
  const tooOld = new Set<string>();
  return {
    async check(profile) {
      let result: Awaited<ReturnType<typeof discover>>;
      try {
        result = await discover(profile.base, { httpGet: deps.httpGet });
      } catch {
        deps.onMeta?.(profile, null);
        return "unknown";
      }
      if ("error" in result) {
        deps.onMeta?.(profile, null);
        if (result.error !== "too_old") return "unknown";
        tooOld.add(profile.id);
        deps.onTooOld(profile.id);
        return "too_old";
      }
      tooOld.delete(profile.id);
      deps.onMeta?.(profile, result.meta);
      return "ok";
    },
    available: (profile) => !tooOld.has(profile.id),
  };
}

/** The sign-in methods of the `CapybaraHost` plugin (AuthSession.swift / AuthSession.kt). */
export interface SignInNative {
  /** Shows the browser session; resolves `{ callback }` or `{ cancelled: true }`. */
  signInStart(options: { url: string; scheme: string }): Promise<unknown>;
  /** Runs the fixed exchange script in the profile WebView's top document. */
  signInExchange(options: { profileId: string; url: string; body: string }): Promise<unknown>;
  currentOrigin(options: { profileId: string }): Promise<unknown>;
  reload(options: { profileId: string }): Promise<void>;
  /** The logout POST from the profile's top document (same path as the exchange). */
  signInRevoke(options: { profileId: string; url: string }): Promise<unknown>;
  /** The device's name and the app's marketing version. */
  appInfo(): Promise<unknown>;
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** The ports `createSignIn` takes, over the plugin; a malformed answer is a failure. */
export function signInPortsFrom(
  native: SignInNative,
): Pick<SignInDeps, "auth" | "exchange" | "currentOrigin" | "reload" | "revoke"> {
  return {
    auth: {
      async start(url, scheme) {
        const r = record(await native.signInStart({ url, scheme }));
        if (r.cancelled === true) return { cancelled: true };
        if (typeof r.callback === "string") return { callback: r.callback };
        throw new Error("malformed sign-in answer");
      },
    },
    async exchange(profileId, req) {
      const r = record(await native.signInExchange({ profileId, ...req }));
      return {
        ok: r.ok === true,
        status: typeof r.status === "number" ? r.status : 0,
        hasAccount: r.hasAccount === true,
      };
    },
    async currentOrigin(profileId) {
      const origin = record(await native.currentOrigin({ profileId })).origin;
      return typeof origin === "string" ? origin : null;
    },
    reload: (profileId) => native.reload({ profileId }),
    async revoke(profileId, req) {
      await native.signInRevoke({ profileId, ...req });
    },
  };
}

/** The device name and app version native reports; empty strings when it cannot. */
export async function appInfoFrom(
  native: Pick<SignInNative, "appInfo">,
): Promise<{ deviceName: string; appVersion: string }> {
  try {
    const r = record(await native.appInfo());
    return {
      deviceName: typeof r.deviceName === "string" ? r.deviceName : "",
      appVersion: typeof r.appVersion === "string" ? r.appVersion : "",
    };
  } catch {
    return { deviceName: "", appVersion: "" };
  }
}
