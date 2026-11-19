// Sign-in through the system browser (spec §6.5): authorization code with PKCE for native apps
// (RFC 8252, RFC 7636), issuer checked on the callback (RFC 9207).
//
// The verifier and `state` live only in this process's memory, keyed by `state`, for 10 minutes and
// one use. The exchange runs through the profile partition's own `fetch`, so the kernel's
// `Set-Cookie` lands in that partition's cookie jar; the response body is read only to see that an
// account came back. Nothing here writes a token anywhere, and the page learns only `signedIn`.
import { randomBytes } from "node:crypto";
import { type AuthCallback, checkCallback, createPkce, SIGN_IN_TTL_MS } from "@capybara-hq/shell";
import { brand } from "../../brand.ts";
import type { CallContext } from "./ipc.ts";
import type { Profile } from "./profiles.ts";
import { appVersionFrom, desktopUserAgent, machineNameFrom } from "./user-agent.ts";

/** Must be listed in the kernel's `auth.appRedirectUris`. The scheme is the brand's (spec §11). */
export const REDIRECT_URI = `${brand.scheme}://auth/callback`;

export type SignInResult = "signedIn" | "cancelled";

export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<ResponseLike>;

export interface SignInDeps {
  /** Opens the system browser (`shell.openExternal`). */
  openExternal(url: string): Promise<unknown> | unknown;
  /** The profile partition's own fetch (`session.fromPartition(partition).fetch`). */
  fetchFor(profile: Profile): FetchLike;
  /** The profile as stored now; undefined once it was removed. */
  getProfile(id: string): Profile | undefined;
  /** Signed in: reload the profile's windows on its origin. */
  onSignedIn(profile: Profile): void;
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

interface Pending {
  profile: Profile;
  base: string;
  verifier: string;
  createdAt: number;
  cancelTimer: () => void;
  resolve(result: SignInResult): void;
  reject(error: { code: "failed" }): void;
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

function hasAccount(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const account = (body as { account?: unknown }).account;
  return typeof account === "object" && account !== null;
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

  // A Map, so a `state` such as `__proto__` is just a key.
  const pending = new Map<string, Pending>();

  /** Removes the entry; returns it only if it was still pending (one use). */
  function take(state: string): Pending | undefined {
    const entry = pending.get(state);
    if (!entry) return undefined;
    pending.delete(state);
    entry.cancelTimer();
    return entry;
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

  async function exchange(entry: Pending, code: string): Promise<boolean> {
    try {
      const res = await deps.fetchFor(entry.profile)(`${entry.base}/api/v1/app-auth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The kernel's CSRF header, required on every non-safe public route.
          "X-Capybara-Csrf": "1",
          "User-Agent": userAgent,
        },
        body: JSON.stringify({ code, codeVerifier: entry.verifier, redirectUri: REDIRECT_URI }),
        // Send and store the partition's cookies; never follow a redirect elsewhere.
        credentials: "include",
        redirect: "error",
        cache: "no-store",
        signal: (deps.timeoutSignal ?? AbortSignal.timeout)(EXCHANGE_TIMEOUT_MS),
      });
      if (!res.ok) {
        // Only the status and the kernel's error code are logged (e.g. 503 app_auth.unavailable:
        // the deployment has no http.publicUrl; the browser's authorize page already said so).
        const code = await errorCode(res);
        log(`sign-in exchange refused (${res.status}${code ? ` ${code}` : ""})`);
        return false;
      }
      if (!hasAccount(await res.json())) {
        log("sign-in exchange answered without an account");
        return false;
      }
      return true;
    } catch (err) {
      log("sign-in exchange failed", err instanceof Error ? err.name : undefined);
      return false;
    }
  }

  const signIn = {
    /** Starts an attempt for `profile`; an older attempt of the same profile ends as cancelled. */
    async start(profile: Profile): Promise<SignInResult> {
      for (const [state, entry] of pending) {
        if (entry.profile.id === profile.id) take(state)?.resolve("cancelled");
      }
      const { verifier, challenge } = pkce();
      const state = newState();
      const result = new Promise<SignInResult>((resolve, reject) => {
        const cancelTimer = schedule(() => take(state)?.resolve("cancelled"), SIGN_IN_TTL_MS);
        pending.set(state, {
          profile,
          base: profile.base,
          verifier,
          createdAt: now(),
          cancelTimer,
          resolve,
          reject,
        });
      });
      try {
        await deps.openExternal(authorizeUrl(profile.base, challenge, state));
      } catch (err) {
        log("could not open the browser for sign-in", err instanceof Error ? err.name : undefined);
        take(state)?.reject(FAILED);
      }
      return result;
    },

    /** A `capybara://auth/callback` link. Anything not matching a pending attempt does nothing. */
    async handleCallback(cb: AuthCallback): Promise<void> {
      const entry = pending.get(cb.state);
      if (!entry) return;
      const verdict = checkCallback(cb, { state: cb.state, ...entry }, now());
      if (verdict === "unknown_state") return;
      // From here the attempt is used up, whatever happens next: a replay finds nothing.
      take(cb.state);
      if (verdict !== "ok") {
        log(`sign-in callback refused (${verdict})`);
        entry.reject(FAILED);
        return;
      }
      if (cb.error !== undefined) {
        if (cb.error === "access_denied") entry.resolve("cancelled");
        else entry.reject(FAILED);
        return;
      }
      const profile = deps.getProfile(entry.profile.id);
      if (!profile || profile.base !== entry.base) {
        entry.resolve("cancelled");
        return;
      }
      if (!(await exchange(entry, cb.code as string))) {
        entry.reject(FAILED);
        return;
      }
      deps.onSignedIn(profile);
      entry.resolve("signedIn");
    },

    /** Pending attempts, for tests and diagnostics. */
    pendingCount(): number {
      return pending.size;
    },

    /** `signIn@1`: always for the calling profile, never one the page names. */
    capability: {
      start: (ctx: CallContext) => signIn.start(ctx.profile),
    },
  };
  return signIn;
}

export type SignIn = ReturnType<typeof createSignIn>;
