// The app:// scheme serves the address page (app://address: three fixed files, looked up in an
// allowlist) and the local pages (app://local/<name>.html|.css|.js: flat names matched by a strict
// pattern, so no "/" or "." sequence from the URL ever reaches the file system), each with a
// strict CSP. Nothing else.
import { join } from "node:path";
import { ADDRESS_HOST, APP_SCHEME, LOCAL_HOST } from "../shared/protocol.ts";

/**
 * No network at all from the page (discovery runs in the main process); the meta icon arrives as
 * a data: URL fetched by main.
 */
export const ADDRESS_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The local pages (desktop spec §6.1): no network of their own, scripts only from the app, inline
 * styles allowed for the token custom properties the runtime sets, images only from the app or as
 * data: URLs (the platform icon, fetched by main).
 */
export const LOCAL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const LOCAL_FILE = /^\/([a-z0-9][a-z0-9-]{0,63})\.(html|css|js)$/;
const LOCAL_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
};

const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/address.css": { file: "address.css", type: "text/css; charset=utf-8" },
  "/address.js": { file: "address.js", type: "text/javascript; charset=utf-8" },
};

const notFound = () => new Response("Not found", { status: 404 });

function lookup(
  url: URL,
  deps: { dir: string; localDir?: string; host: string },
): { path: string; type: string; csp: string } | undefined {
  // The raw pathname, compared as is: "%2e%2e" or "..%2f" match no entry and no pattern.
  if (deps.host === ADDRESS_HOST && url.host === ADDRESS_HOST) {
    const entry = Object.hasOwn(FILES, url.pathname) ? FILES[url.pathname] : undefined;
    return entry
      ? { path: join(deps.dir, entry.file), type: entry.type, csp: ADDRESS_CSP }
      : undefined;
  }
  if (deps.host === LOCAL_HOST && url.host === LOCAL_HOST && deps.localDir !== undefined) {
    const m = LOCAL_FILE.exec(url.pathname);
    if (!m) return undefined;
    const [, name, ext] = m as unknown as [string, string, string];
    return {
      path: join(deps.localDir, `${name}.${ext}`),
      type: LOCAL_TYPES[ext] as string,
      csp: LOCAL_CSP,
    };
  }
  return undefined;
}

export function createAppProtocolHandler(deps: {
  /** The only host this registration serves: each partition serves its own pages. */
  host: typeof ADDRESS_HOST | typeof LOCAL_HOST;
  /** The directory holding the built address page files. */
  dir: string;
  /** The directory holding the built local pages (dist/local); absent = app://local is 404. */
  localDir?: string;
  readFile(path: string): Promise<Uint8Array>;
}): (request: { url: string }) => Promise<Response> {
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.protocol !== `${APP_SCHEME}:`) return notFound();
    const entry = lookup(url, deps);
    if (!entry) return notFound();
    let body: Uint8Array;
    try {
      body = await deps.readFile(entry.path);
    } catch {
      return notFound();
    }
    return new Response(body as unknown as ConstructorParameters<typeof Response>[0], {
      status: 200,
      headers: {
        "content-type": entry.type,
        "content-security-policy": entry.csp,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  };
}
