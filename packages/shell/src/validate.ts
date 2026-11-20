export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolves an absolute path (`/…`) on `origin`; null when it is not one or would leave the origin
 * (`//host`, `/\host`, which browsers read as another host).
 */
export function sameOriginUrl(path: string, origin: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  try {
    const u = new URL(path, origin);
    return u.origin === origin ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * `#rgb` or `#rrggbb` only: Electron reads 4 and 8 digits as alpha first while CSS reads alpha
 * last, so those forms would paint the wrong colour.
 */
export function isBackgroundColor(v: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
}
