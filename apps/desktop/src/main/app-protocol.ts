// The app:// scheme serves the address page and nothing else: three fixed files, looked up in an
// allowlist (so no path from the URL ever reaches the file system), with a strict CSP.
import { join } from "node:path";
import { ADDRESS_HOST, APP_SCHEME } from "../shared/protocol.ts";

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

const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/address.css": { file: "address.css", type: "text/css; charset=utf-8" },
  "/address.js": { file: "address.js", type: "text/javascript; charset=utf-8" },
};

const notFound = () => new Response("Not found", { status: 404 });

export function createAppProtocolHandler(deps: {
  /** The directory holding the built address page files. */
  dir: string;
  readFile(path: string): Promise<Uint8Array>;
}): (request: { url: string }) => Promise<Response> {
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.protocol !== `${APP_SCHEME}:` || url.host !== ADDRESS_HOST) return notFound();
    // The raw pathname, compared as is: "%2e%2e" or "..%2f" match no entry.
    const entry = Object.hasOwn(FILES, url.pathname) ? FILES[url.pathname] : undefined;
    if (!entry) return notFound();
    let body: Uint8Array;
    try {
      body = await deps.readFile(join(deps.dir, entry.file));
    } catch {
      return notFound();
    }
    return new Response(body as unknown as ConstructorParameters<typeof Response>[0], {
      status: 200,
      headers: {
        "content-type": entry.type,
        "content-security-policy": ADDRESS_CSP,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  };
}
