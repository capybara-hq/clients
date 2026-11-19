export type AddressResult =
  | { ok: true; origin: string; base: string }
  | { ok: false; reason: "invalid" | "insecure" };

// URL.hostname keeps the brackets of an IPv6 literal.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Turns what a person typed into a deployment address. `https://` is added when there is no
 * scheme; `http:` is accepted only for loopback hosts. Credentials make the address invalid; the
 * query and the fragment are dropped. `base` is the origin plus the path prefix without a
 * trailing slash.
 */
export function normalizeAddress(input: string): AddressResult {
  const raw = input.trim();
  if (raw === "") return { ok: false, reason: "invalid" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, reason: "invalid" };
  if (url.hostname === "" || url.username !== "" || url.password !== "") {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, reason: "insecure" };
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, origin: url.origin, base: `${url.origin}${path}` };
}
