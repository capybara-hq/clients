// The app:// scheme serves the local pages (app://local/<name>.html|.css|.js: flat names matched
// by a strict pattern, so no "/" or "." sequence from the URL ever reaches the file system), with a
// strict CSP. Nothing else. Only the local partition registers it.
import { join } from "node:path";
import { APP_SCHEME, LOCAL_HOST } from "../shared/protocol.ts";

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

const notFound = () => new Response("Not found", { status: 404 });

function lookup(url: URL, localDir: string): { path: string; type: string } | undefined {
  // The raw pathname, compared as is: "%2e%2e" or "..%2f" match no pattern.
  if (url.host !== LOCAL_HOST) return undefined;
  const m = LOCAL_FILE.exec(url.pathname);
  if (!m) return undefined;
  const [, name, ext] = m as unknown as [string, string, string];
  return { path: join(localDir, `${name}.${ext}`), type: LOCAL_TYPES[ext] as string };
}

export function createAppProtocolHandler(deps: {
  /** The directory holding the built local pages (dist/local). */
  localDir: string;
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
    const entry = lookup(url, deps.localDir);
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
        "content-security-policy": LOCAL_CSP,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  };
}
