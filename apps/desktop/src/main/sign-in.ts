// Sign-in through the system browser (spec §6.5): authorization code with PKCE for native apps
// (RFC 8252, RFC 7636), issuer checked on the callback (RFC 9207).
//
// The verifier and `state` live only in this process's memory, keyed by `state`, for 10 minutes and
// one use. The exchange runs through the profile partition's own `fetch`, so the kernel's
// `Set-Cookie` lands in that partition's cookie jar; from the response body only the account's
// display name and login (or email) are kept, validated as short strings. Nothing here writes a
// token anywhere, and a page learns only the outcome.
import { randomBytes } from "node:crypto";
import { type AuthCallback, checkCallback, createPkce, SIGN_IN_TTL_MS } from "@capybara-hq/shell";
import { brand } from "../../brand.ts";
import type { CallContext } from "./ipc.ts";
import type { Profile } from "./profiles.ts";
import { appVersionFrom, desktopUserAgent, machineNameFrom } from "./user-agent.ts";

/** Must be listed in the kernel's `auth.appRedirectUris`. The scheme is the brand's (spec §11). */
export const REDIRECT_URI = `${brand.scheme}://auth/callback`;

/** The result `signIn@1` gives a web page (spec §8): unchanged by the outcomes below. */
export type SignInResult = "signedIn" | "cancelled";

/** Why an attempt ended without a session (spec §6.6, sign-in stage). */
export type SignInFailure =
  | "timeout"
  | "cancelled"
  | "not_allowed"
  | "account_unusable"
  | "link_invalid";

export interface SignedInAccount {
  name: string;
  /** The account's login, else its email; empty when the kernel sent neither. */
  login: string;
}

export type SignInOutcome =
  | { ok: true; account: SignedInAccount }
  | { ok: false; reason: SignInFailure };

export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<ResponseLike>;

export interface SignInDeps {
  /** Opens the system browser (`shell.openExternal`); used by `signIn@1` only. */
  openExternal(url: string): Promise<unknown> | unknown;
  /** The profile partition's own fetch (`session.fromPartition(partition).fetch`). */
  fetchFor(profile: Profile): FetchLike;
  /** The profile as stored now; undefined once it was removed. Read for `signIn@1` only. */
  getProfile(id: string): Profile | undefined;
  /**
   * Signed in through `signIn@1` as `account`: store the account and reload the profile's windows
   * on its origin.
   */
  onSignedIn(profile: Profile, account: SignedInAccount): void;
  /**
   * Removes the kernel's session cookies (`cap_at`, `cap_rt`) from the profile's partition. Called
   * after a session the app did not want (a cancelled attempt whose exchange still succeeded) was
   * logged out, in case the logout did not clear them.
   */
  clearSessionCookies?(profile: Profile): Promise<unknown> | unknown;
  /**
   * Wraps the revoke's logout POST (sign-out.ts `suppress`): its completion on the partition is
   * the app's own, not the web's sign-out. Absent: run as is.
   */
  aroundLogout?<T>(profileId: string, run: () => Promise<T>): Promise<T>;
  /** Shown on the authorize page and recorded in the session's user agent. */
  machineName: string;
  appVersion: string;
  now?: () => number;
  pkce?: () => { verifier: string; challenge: string };
  newState?: () => string;
  /** One-shot timer; returns its cancel. A desktop app's main process may hold timers. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** A signal that aborts after `ms`; defaults to `AbortSignal.timeout` (injected in tests). */
  timeoutSignal?: (ms: number) => AbortSignal;
  log?: (message: string, err?: unknown) => void;
}

/** The token exchange may take this long; then the sign-in fails instead of hanging. */
export const EXCHANGE_TIMEOUT_MS = 30_000;

/** Kernel error codes of the token exchange that get their own message (spec §6.6). */
const REASON_BY_CODE: ReadonlyMap<string, SignInFailure> = new Map([
  ["app_auth.unavailable", "not_allowed"],
  ["app_auth.redirect_uri_invalid", "not_allowed"],
  ["auth.account_disabled", "account_unusable"],
]);

const MAX_NAME = 200;
const MAX_LOGIN = 254;
/** The longest `iss` looked at for a stale callback; anything longer is not parsed. */
const MAX_ISS = 2048;

interface Attempt {
  state: string;
  profile: Profile;
  base: string;
  verifier: string;
  url: string;
  createdAt: number;
  /** Started by `signIn@1`: on success the profile's windows reload (`onSignedIn`). */
  viaCapability: boolean;
  settled: boolean;
  /** Aborts the attempt's exchange once the attempt has settled. */
  abort: AbortController;
  cancelTimer: () => void;
  resolve(outcome: SignInOutcome): void;
}

const FAILED = Object.freeze({ code: "failed" as const });

function defaultSchedule(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
}

/** The kernel's error code (`{ error: { code } }`), only when it looks like one; never the body. */
async function errorCode(res: ResponseLike): Promise<string | undefined> {
  try {
    const body = await res.json();
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "string" && /^[a-z][a-z0-9_.]{0,63}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

// Control and format characters (bidirectional marks and overrides, zero-width characters, the
// BOM), line and paragraph separators, and lone surrogates: anything that could disguise a name.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** A short display string, trimmed; undefined for anything else. */
function shortText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length > max * 2) return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > max || UNSAFE_TEXT.test(text)) return undefined;
  return text;
}

/**
 * The account in the token response (kernel `Account`: `displayName`, `email`), reduced to a
 * display name and a login. Nothing else of the body is read.
 */
function accountFrom(body: unknown): SignedInAccount | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const account = (body as { account?: unknown }).account;
  if (typeof account !== "object" || account === null || Array.isArray(account)) return undefined;
  const a = account as { displayName?: unknown; login?: unknown; email?: unknown };
  const login = shortText(a.login, MAX_LOGIN) ?? shortText(a.email, MAX_LOGIN) ?? "";
  const name = shortText(a.displayName, MAX_NAME) ?? login;
  if (name === "") return undefined;
  return { name, login };
}

/** The origin of an `iss` that parses as an http(s) URL; undefined for anything else. */
function issuerOrigin(iss: unknown): string | undefined {
  if (typeof iss !== "string" || iss.length > MAX_ISS) return undefined;
  try {
    const url = new URL(iss);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function createSignIn(deps: SignInDeps) {
  const now = deps.now ?? Date.now;
  const pkce = deps.pkce ?? (() => createPkce());
  const newState = deps.newState ?? (() => randomBytes(32).toString("base64url"));
  const schedule = deps.schedule ?? defaultSchedule;
  const machineName = machineNameFrom(deps.machineName);
  const appVersion = appVersionFrom(deps.appVersion);
  // The kernel records the refresh request's user agent on the session: name the app from the
  // first request (the partition's header listener does the same for the web's own requests).
  const userAgent = desktopUserAgent(deps.appVersion, deps.machineName);
  const log = (message: string, err?: unknown) => deps.log?.(message, err);

  // Maps, so a `state` such as `__proto__` is just a key.
  /** Attempts waiting for their callback. */
  const pending = new Map<string, Attempt>();
  /** Attempts whose callback was taken and whose exchange is running. */
  const exchanging = new Map<string, Attempt>();
  const staleListeners = new Set<(origin: string) => void>();
  /** Per profile: the tail of its exchanges, in order (see `inSlot`). */
  const slots = new Map<string, Promise<void>>();
  const timeoutSignal = (ms: number) => (deps.timeoutSignal ?? AbortSignal.timeout)(ms);

  /** Ends the attempt with `outcome` once; later calls do nothing. */
  function settle(attempt: Attempt, outcome: SignInOutcome): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.cancelTimer();
    attempt.abort.abort();
    pending.delete(attempt.state);
    exchanging.delete(attempt.state);
    attempt.resolve(outcome);
  }

  const fail = (attempt: Attempt, reason: SignInFailure) => settle(attempt, { ok: false, reason });

  /** The profile's attempts, waiting or exchanging (at most one exists per profile). */
  function attemptsOf(profileId: string): Attempt[] {
    return [...pending.values(), ...exchanging.values()].filter((a) => a.profile.id === profileId);
  }

  function authorizeUrl(base: string, challenge: string, state: string): string {
    const q = new URLSearchParams({
      client: "desktop",
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      name: machineName,
      app_version: appVersion,
    });
    return `${base}/apps/authorize?${q.toString()}`;
  }

  /**
   * One exchange. `sessionSet`: the kernel answered 2xx, so its `Set-Cookie` may have reached the
   * partition even if the body then could not be read.
   */
  async function exchange(
    attempt: Attempt,
    profile: Profile,
    code: string,
  ): Promise<{ outcome: SignInOutcome; sessionSet: boolean }> {
    let sessionSet = false;
    const failed = (): { outcome: SignInOutcome; sessionSet: boolean } => ({
      outcome: { ok: false, reason: "link_invalid" },
      sessionSet,
    });
    try {
      const res = await deps.fetchFor(profile)(`${attempt.base}/api/v1/app-auth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The kernel's CSRF header, required on every non-safe public route.
          "X-Capybara-Csrf": "1",
          "User-Agent": userAgent,
        },
        body: JSON.stringify({ code, codeVerifier: attempt.verifier, redirectUri: REDIRECT_URI }),
        // Send and store the partition's cookies; never follow a redirect elsewhere.
        credentials: "include",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([timeoutSignal(EXCHANGE_TIMEOUT_MS), attempt.abort.signal]),
      });
      if (!res.ok) {
        // Only the status and the kernel's error code are logged (e.g. 503 app_auth.unavailable:
        // the deployment has no http.publicUrl; the browser's authorize page already said so).
        const errCode = await errorCode(res);
        log(`sign-in exchange refused (${res.status}${errCode ? ` ${errCode}` : ""})`);
        const reason = errCode === undefined ? undefined : REASON_BY_CODE.get(errCode);
        return { outcome: { ok: false, reason: reason ?? "link_invalid" }, sessionSet };
      }
      sessionSet = true;
      const account = accountFrom(await res.json());
      if (!account) {
        log("sign-in exchange answered without an account");
        return failed();
      }
      return { outcome: { ok: true, account }, sessionSet };
    } catch (err) {
      log("sign-in exchange failed", err instanceof Error ? err.name : undefined);
      return failed();
    }
  }

  /**
   * Ends a session the app did not want: the kernel's logout through the same partition (which
   * revokes the session and clears its cookies), then the cookies removed locally as well.
   */
  async function revoke(attempt: Attempt, profile: Profile): Promise<void> {
    const post = () =>
      deps.fetchFor(profile)(`${attempt.base}/api/v1/auth/logout`, {
        method: "POST",
        headers: { "X-Capybara-Csrf": "1", "User-Agent": userAgent },
        credentials: "include",
        redirect: "error",
        cache: "no-store",
        signal: timeoutSignal(EXCHANGE_TIMEOUT_MS),
      });
    try {
      const res = await (deps.aroundLogout ? deps.aroundLogout(profile.id, post) : post());
      if (!res.ok) log(`sign-in revoke refused (${res.status})`);
    } catch (err) {
      log("sign-in revoke failed", err instanceof Error ? err.name : undefined);
    }
    try {
      await deps.clearSessionCookies?.(profile);
    } catch (err) {
      log("could not clear the session cookies", err instanceof Error ? err.name : undefined);
    }
  }

  /**
   * Runs `work` in the profile's exchange slot: after every earlier exchange of the profile
   * (including its revoke) has finished, so two attempts never write the partition's cookies at
   * once. Never rejects.
   */
  async function inSlot(profileId: string, work: () => Promise<void>): Promise<void> {
    const run = (slots.get(profileId) ?? Promise.resolve()).then(work).catch((err: unknown) => {
      log("sign-in exchange slot failed", err instanceof Error ? err.name : undefined);
    });
    slots.set(profileId, run);
    try {
      await run;
    } finally {
      if (slots.get(profileId) === run) slots.delete(profileId);
    }
  }

  async function finish(attempt: Attempt, profile: Profile, code: string): Promise<void> {
    // Cancelled or replaced while an earlier exchange held the slot: nothing is sent.
    if (attempt.settled) return;
    const { outcome, sessionSet } = await exchange(attempt, profile, code);
    if (outcome.ok && !attempt.settled) {
      settle(attempt, outcome);
      if (attempt.viaCapability) {
        try {
          deps.onSignedIn(profile, outcome.account);
        } catch (err) {
          log("reloading after sign-in failed", err instanceof Error ? err.name : undefined);
        }
      }
      return;
    }
    // A failure stands; a cancel that came first stands too.
    if (!outcome.ok) fail(attempt, outcome.reason);
    // A session the person no longer wants (cancelled meanwhile, or an answer that could not be
    // used) is ended before the slot is released.
    if (sessionSet) await revoke(attempt, profile);
  }

  function notifyStale(iss: unknown): void {
    const origin = issuerOrigin(iss);
    if (origin === undefined) return;
    for (const listener of [...staleListeners]) {
      try {
        listener(origin);
      } catch (err) {
        log("stale sign-in callback listener failed", err instanceof Error ? err.name : undefined);
      }
    }
  }

  function start(profile: Profile, viaCapability: boolean) {
    for (const attempt of attemptsOf(profile.id)) fail(attempt, "cancelled");
    const { verifier, challenge } = pkce();
    const state = newState();
    const url = authorizeUrl(profile.base, challenge, state);
    let resolve: (outcome: SignInOutcome) => void = () => undefined;
    const outcome = new Promise<SignInOutcome>((r) => {
      resolve = r;
    });
    const attempt: Attempt = {
      state,
      profile,
      base: profile.base,
      verifier,
      url,
      createdAt: now(),
      viaCapability,
      settled: false,
      abort: new AbortController(),
      cancelTimer: () => undefined,
      resolve,
    };
    pending.set(state, attempt);
    attempt.cancelTimer = schedule(() => fail(attempt, "timeout"), SIGN_IN_TTL_MS);
    return { attempt, url, outcome };
  }

  const signIn = {
    /**
     * Starts (or restarts) the attempt for `profile`; an older attempt of the same profile ends as
     * `cancelled` (an exchange it has running is aborted, and the new exchange waits for it). The
     * caller opens `url` in the system browser, and calls `cancel()` if that fails. The attempt
     * keeps the profile it was given (it need not be stored yet); the caller abandons it with
     * `cancel()`. `outcome` resolves once and never rejects.
     */
    begin(profile: Profile): { url: string; outcome: Promise<SignInOutcome> } {
      const { url, outcome } = start(profile, false);
      return { url, outcome };
    },

    /** The waiting attempt's authorize URL (reopen / copy), undefined when none. */
    pendingUrl(profileId: string): string | undefined {
      for (const attempt of pending.values()) {
        if (attempt.profile.id === profileId) return attempt.url;
      }
      return undefined;
    },

    /**
     * Ends the profile's attempt as `cancelled`, whether it waits for its callback or its exchange
     * runs (the request is aborted; a session it still created is logged out). Await `quiesce()`
     * before clearing the partition.
     */
    cancel(profileId: string): void {
      for (const attempt of attemptsOf(profileId)) fail(attempt, "cancelled");
    },

    /** A `capybara://auth/callback` link. Anything not matching a pending attempt does nothing. */
    async handleCallback(cb: AuthCallback): Promise<void> {
      // A second delivery of a link whose exchange is still running: a duplicate, not stale.
      if (exchanging.has(cb.state)) return;
      const attempt = pending.get(cb.state);
      if (!attempt) {
        // Touches no attempt and calls nothing outside: listeners only learn the issuer's origin.
        notifyStale(cb.iss);
        return;
      }
      const verdict = checkCallback(cb, attempt, now());
      if (verdict === "unknown_state") return;
      // From here the attempt is used up, whatever happens next: a replay finds nothing.
      pending.delete(cb.state);
      attempt.cancelTimer();
      if (verdict === "expired") {
        log("sign-in callback refused (expired)");
        fail(attempt, "timeout");
        return;
      }
      if (verdict !== "ok") {
        log(`sign-in callback refused (${verdict})`);
        fail(attempt, "link_invalid");
        return;
      }
      if (cb.error !== undefined) {
        fail(attempt, cb.error === "access_denied" ? "cancelled" : "link_invalid");
        return;
      }
      let profile = attempt.profile;
      if (attempt.viaCapability) {
        // A web page's attempt is for a stored profile: removed or re-pointed meanwhile, it ends.
        const stored = deps.getProfile(attempt.profile.id);
        if (!stored || stored.base !== attempt.base) {
          fail(attempt, "cancelled");
          return;
        }
        profile = stored;
      }
      if (typeof cb.code !== "string") {
        fail(attempt, "link_invalid");
        return;
      }
      const code = cb.code;
      exchanging.set(cb.state, attempt);
      await inSlot(profile.id, () => finish(attempt, profile, code));
    },

    /**
     * Resolves once the profile has no exchange in flight (including the logout of a session a
     * cancelled attempt still created). The host awaits it before clearing the partition.
     */
    async quiesce(profileId: string): Promise<void> {
      for (let tail = slots.get(profileId); tail; tail = slots.get(profileId)) await tail;
    },

    /**
     * A callback whose `state` this app does not hold (expired, used, or another run's) and whose
     * `iss` parses as an http(s) URL: listeners get that URL's origin (link invalid, spec §6.6).
     * It never touches an attempt and makes no request; the listener decides whether it waited.
     * This module never cancels on such a link (anyone can send one). A host that shows the
     * message may end its own attempt (`cancel`), so its page tells the truth.
     */
    onStaleCallback(listener: (origin: string) => void): () => void {
      staleListeners.add(listener);
      return () => {
        staleListeners.delete(listener);
      };
    },

    /** Attempts waiting for their callback, for tests and diagnostics. */
    pendingCount(): number {
      return pending.size;
    },

    /**
     * `signIn@1`: always for the calling profile, never one the page names. Results as before:
     * `signedIn`, or `cancelled` (cancelled, replaced, timed out, profile removed); any other
     * failure rejects `{ code: "failed" }`.
     */
    capability: {
      start: async (ctx: CallContext): Promise<SignInResult> => {
        const { attempt, url, outcome } = start(ctx.profile, true);
        try {
          await deps.openExternal(url);
        } catch (err) {
          log(
            "could not open the browser for sign-in",
            err instanceof Error ? err.name : undefined,
          );
          fail(attempt, "link_invalid");
        }
        const result = await outcome;
        if (result.ok) return "signedIn";
        if (result.reason === "cancelled" || result.reason === "timeout") return "cancelled";
        throw FAILED;
      },
    },
  };
  return signIn;
}

export type SignIn = ReturnType<typeof createSignIn>;
