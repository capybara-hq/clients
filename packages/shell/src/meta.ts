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
}

/**
 * `sign_in_unavailable`: the deployment answers but has no public address (`http.publicUrl`), so
 * its app sign-in routes answer 503 `app_auth.unavailable`. `too_old`: a kernel whose meta has no
 * `features.appSignIn` yet.
 */
export type MetaError = {
  error: "unreachable" | "not_capybara" | "too_old" | "sign_in_unavailable";
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const nullableString = (v: unknown): v is string | null => v === null || typeof v === "string";

/** undefined when absent, null when malformed. */
function parseIcons(v: unknown): MetaIcons | undefined | null {
  if (v === undefined) return undefined;
  if (!isRecord(v)) return null;
  const { app, maskable, favicon } = v;
  if (!nullableString(app) || !nullableString(maskable) || !nullableString(favicon)) return null;
  return { app, maskable, favicon };
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
  if (icons === null) return null;
  if (!isRecord(protocols) || !isRecord(protocols.device)) return null;
  const { min, max } = protocols.device;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  if (!isRecord(features) || typeof features.localDevices !== "boolean") return null;
  const { appSignIn } = features;
  if (appSignIn !== undefined && typeof appSignIn !== "boolean") return null;
  return {
    name,
    icon,
    ...(icons ? { icons } : {}),
    protocols: { device: { min: min as number, max: max as number } },
    features: { localDevices: features.localDevices, appSignIn },
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

/**
 * Asks a deployment what it is. `base` comes from `normalizeAddress`. A stalled server (10 s,
 * or the caller's `signal`), a network error and a redirect (never followed: another host
 * must not answer) are `unreachable`; an oversized body is `not_capybara`.
 */
export async function fetchMeta(
  base: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<Meta | MetaError> {
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
  } catch {
    return { error: "unreachable" };
  }
  const meta = parseMeta(body);
  if (meta === null) return { error: "not_capybara" };
  const { appSignIn } = meta.features;
  if (appSignIn === undefined) return { error: "too_old" };
  if (!appSignIn) return { error: "sign_in_unavailable" };
  return { ...meta, features: { ...meta.features, appSignIn } };
}
