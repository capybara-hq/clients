import { normalizeAddress } from "./address.js";

/** Versioned icon URLs of `GET /api/v1/meta`; null for the default icon. Relative: resolve against the base. */
export interface MetaIcons {
  app: string | null;
  maskable: string | null;
  favicon: string | null;
}

/** The shape of `GET /api/v1/meta`. A relative `icon` stays as returned: resolve it against the base. */
export interface Meta {
  name: string | null;
  /** Equals `icons.app` on a kernel that sends `icons`. */
  icon: string | null;
  /** Absent on a kernel that does not send it yet. */
  icons?: MetaIcons;
  protocols: { device: { min: number; max: number } };
  features: { localDevices: boolean; appSignIn: boolean };
  /** Redirect URIs the deployment accepts for app sign-in; absent on older kernels. */
  appRedirectUris?: string[];
}

/**
 * `sign_in_unavailable`: the deployment answers but has no public address (`http.publicUrl`), so
 * its app sign-in routes answer 503 `app_auth.unavailable`. `too_old`: a kernel whose meta has no
 * `features.appSignIn` yet.
 */
export type MetaError = {
  error: "unreachable" | "not_capybara" | "too_old" | "sign_in_unavailable" | "cert_invalid";
};

/** What `discover` can refuse with; `not_https` comes from address normalization. */
export type DiscoveryError =
  | "unreachable"
  | "not_capybara"
  | "too_old"
  | "not_https"
  | "cert_invalid";

export type DiscoveryResult =
  | { ok: true; base: string; meta: Meta }
  | { ok: false; error: DiscoveryError };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const nullableString = (v: unknown): v is string | null => v === null || typeof v === "string";

/** undefined when absent or malformed: an unexpected shape is ignored, for forward compatibility. */
function parseIcons(v: unknown): MetaIcons | undefined {
  if (!isRecord(v)) return undefined;
  const { app, maskable, favicon } = v;
  if (!nullableString(app) || !nullableString(maskable) || !nullableString(favicon)) {
    return undefined;
  }
  return { app, maskable, favicon };
}

/** undefined unless an array of strings. */
function parseRedirectUris(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return undefined;
  return v as string[];
}

/** A parsed meta; `appSignIn` is undefined when an older kernel leaves it out. */
type ParsedMeta = Omit<Meta, "features"> & {
  features: { localDevices: boolean; appSignIn: boolean | undefined };
};

function parseMeta(v: unknown): ParsedMeta | null {
  if (!isRecord(v)) return null;
  const { name, icon, protocols, features } = v;
  if (!nullableString(name) || !nullableString(icon)) return null;
  const icons = parseIcons(v.icons);
  if (!isRecord(protocols) || !isRecord(protocols.device)) return null;
  const { min, max } = protocols.device;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  if (!isRecord(features) || typeof features.localDevices !== "boolean") return null;
  const { appSignIn } = features;
  const appRedirectUris = parseRedirectUris(v.appRedirectUris);
  if (appSignIn !== undefined && typeof appSignIn !== "boolean") return null;
  return {
    name,
    icon,
    ...(icons ? { icons } : {}),
    protocols: { device: { min: min as number, max: max as number } },
    features: { localDevices: features.localDevices, appSignIn },
    ...(appRedirectUris ? { appRedirectUris } : {}),
  };
}

export const META_TIMEOUT_MS = 10_000;
export const META_MAX_BYTES = 64 * 1024;

/** Reads a body as text; null when it is larger than `limit` bytes. */
async function readCapped(res: Response, limit: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** True when a fetch error (or its cause chain) carries a certificate failure code. */
function isCertError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const o = e as { message?: unknown; code?: unknown; cause?: unknown };
    const text = `${typeof o.message === "string" ? o.message : ""} ${
      typeof o.code === "string" ? o.code : ""
    }`;
    if (/CERT_|SELF_SIGNED|UNABLE_TO_VERIFY/.test(text)) return true;
    e = o.cause;
  }
  return false;
}

type RawMeta = ParsedMeta | { error: "unreachable" | "not_capybara" | "cert_invalid" };

async function readMeta(
  base: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<RawMeta> {
  const timeout = AbortSignal.timeout(META_TIMEOUT_MS);
  let body: unknown;
  try {
    const res = await fetchFn(`${base}/api/v1/meta`, {
      cache: "no-store",
      redirect: "error",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!res.ok) return { error: "not_capybara" };
    const text = await readCapped(res, META_MAX_BYTES);
    if (text === null) return { error: "not_capybara" };
    try {
      body = JSON.parse(text);
    } catch {
      return { error: "not_capybara" };
    }
  } catch (err) {
    return { error: isCertError(err) ? "cert_invalid" : "unreachable" };
  }
  return parseMeta(body) ?? { error: "not_capybara" };
}

/**
 * Asks a deployment what it is. `base` comes from `normalizeAddress`. A stalled server (10 s,
 * or the caller's `signal`), a network error and a redirect (never followed: another host
 * must not answer) are `unreachable` (a certificate failure is `cert_invalid`); an oversized
 * body is `not_capybara`.
 */
export async function fetchMeta(
  base: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<Meta | MetaError> {
  const meta = await readMeta(base, fetchFn, signal);
  if ("error" in meta) return meta;
  const { appSignIn } = meta.features;
  if (appSignIn === undefined) return { error: "too_old" };
  if (!appSignIn) return { error: "sign_in_unavailable" };
  return { ...meta, features: { ...meta.features, appSignIn } };
}

/**
 * Discovery for onboarding: normalizes what a person typed, then asks the deployment. A
 * deployment with `appSignIn: false` is returned as is (see `appSignInBlocked`).
 *
 * An address that does not parse comes back as `not_capybara` here: this function has no
 * `invalid` result. A host that wants to show `invalid` for typos calls `normalizeAddress` first
 * and only passes a normalized address on.
 */
export async function discover(
  input: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<DiscoveryResult> {
  const address = normalizeAddress(input);
  if (!address.ok)
    return { ok: false, error: address.reason === "insecure" ? "not_https" : "not_capybara" };
  const meta = await readMeta(address.base, fetchFn, signal);
  if ("error" in meta) return { ok: false, error: meta.error };
  const { appSignIn } = meta.features;
  if (appSignIn === undefined) return { ok: false, error: "too_old" };
  return {
    ok: true,
    base: address.base,
    meta: { ...meta, features: { ...meta.features, appSignIn } },
  };
}

/** Sign-in-stage verdict before opening the browser: null = go. */
export function appSignInBlocked(meta: Meta, redirectUri: string): "not_allowed" | null {
  if (!meta.features.appSignIn) return "not_allowed";
  if (meta.appRedirectUris && !meta.appRedirectUris.includes(redirectUri)) return "not_allowed";
  return null;
}
