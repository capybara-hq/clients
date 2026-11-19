// A fake Capybara deployment for the desktop end-to-end test: a plain Node HTTP server (no
// dependencies) that answers what the desktop app asks of a real kernel and web:
//   GET  /api/v1/meta                current shape (icons, appSignIn true), cache-control: no-store
//   GET  /apps/authorize             records the query (the test reads state and challenge)
//   POST /api/v1/app-auth/token      X-Capybara-Csrf: 1, PKCE S256, one use; sets a cookie
//   POST /api/v1/auth/login          counts the hit (the app must never let it reach here)
//   GET  /                           prints the Shell environment the page sees, signed in or out
//   GET  /frame, /plugin-ui/x/frame  iframes that report whether they see window.capybaraShell
//   GET  /ua, /hop?to=<url>          the user agent the server saw; a redirect to another origin
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_ACCOUNT = { id: "acc_1", name: "Fake Person" };
const COOKIE_NAME = "cap_at";
// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export interface AuthorizeRequest {
  query: Record<string, string>;
}

export interface SeenRequest {
  method: string;
  path: string;
  userAgent: string;
}

export interface FakeDeployment {
  /** `http://127.0.0.1:<port>` */
  base: string;
  /** Every request, in order. */
  requests: SeenRequest[];
  /** The `/apps/authorize` queries received. */
  authorize: AuthorizeRequest[];
  /** Token exchanges that were accepted. */
  accepted: number;
  /** Token exchanges that were refused, with the reason. */
  refused: string[];
  /** `POST /api/v1/auth/login` requests that arrived. */
  loginHits: number;
  /** Issues a one-use code bound to the `state` of a recorded authorize request. */
  issueCode(state: string): string;
  close(): Promise<void>;
}

function html(body: string, script = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>fake</title></head><body>${body}<script>${script}</script></body></html>`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const ROOT_SCRIPT = `
const out = document.getElementById("shell");
const render = () => {
  const s = window.capybaraShell;
  out.textContent = JSON.stringify({
    type: typeof s,
    kind: s && s.kind,
    platform: s && s.platform,
    version: s && s.version,
    capabilities: s ? Object.keys(s.capabilities).sort() : [],
  });
};
render();
if (window.capybaraShell) window.capybaraShell.on("change", render);
document.getElementById("signin").addEventListener("click", () => {
  const result = document.getElementById("signin-result");
  result.textContent = "pending";
  window.capybaraShell.capabilities["signIn@1"].start().then(
    (r) => { result.textContent = "result:" + r; },
    (e) => { result.textContent = "error:" + (e && e.code); },
  );
});
document.getElementById("login").addEventListener("click", () => {
  const result = document.getElementById("login-result");
  fetch("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Capybara-Csrf": "1" },
    body: "{}",
  }).then(
    (r) => { result.textContent = "status:" + r.status; },
    () => { result.textContent = "blocked"; },
  );
});
document.getElementById("hop").addEventListener("click", () => {
  window.location.href = "/hop?to=" + encodeURIComponent(window.__peer || "");
});
`;

function rootPage(signedIn: boolean, peer: string): string {
  return html(
    `<h1 id="auth">${signedIn ? `signed-in:${FAKE_ACCOUNT.name}` : "signed-out"}</h1>
<pre id="shell"></pre>
<button id="signin">sign in</button><span id="signin-result"></span>
<button id="login">login</button><span id="login-result"></span>
<button id="hop">hop</button>
<iframe id="same" src="/frame"></iframe>
<iframe id="plugin" src="/plugin-ui/x/frame"></iframe>`,
    `window.__peer = ${JSON.stringify(peer)};${ROOT_SCRIPT}`,
  );
}

const FRAME_PAGE = html(
  `<p id="frame-shell"></p>`,
  `document.getElementById("frame-shell").textContent = typeof window.capybaraShell;`,
);

export async function startFakeDeployment(
  options: { peer?: string; port?: number } = {},
): Promise<FakeDeployment> {
  const peer = options.peer ?? "";
  const codes = new Map<string, { challenge: string; used: boolean }>();
  const challenges = new Map<string, string>();
  const sessions = new Set<string>();
  const fake: FakeDeployment = {
    base: "",
    requests: [],
    authorize: [],
    accepted: 0,
    refused: [],
    loginHits: 0,
    issueCode(state) {
      const challenge = challenges.get(state);
      if (challenge === undefined) throw new Error(`no authorize request with state ${state}`);
      const code = randomBytes(16).toString("base64url");
      codes.set(code, { challenge, used: false });
      return code;
    },
    close: () => closeServer(server),
  };

  const send = (
    res: ServerResponse,
    status: number,
    body: string | Buffer,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, headers);
    res.end(body);
  };

  const token = async (req: IncomingMessage, res: ServerResponse) => {
    const refuse = (reason: string, status = 400) => {
      fake.refused.push(reason);
      send(res, status, JSON.stringify({ error: { code: reason } }), {
        "content-type": "application/json",
      });
    };
    if (req.headers["x-capybara-csrf"] !== "1") return refuse("csrf");
    let body: { code?: unknown; codeVerifier?: unknown; redirectUri?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return refuse("bad_body");
    }
    if (body.redirectUri !== "capybara://auth/callback") return refuse("redirect_uri");
    const entry = typeof body.code === "string" ? codes.get(body.code) : undefined;
    if (!entry) return refuse("unknown_code");
    if (entry.used) return refuse("code_used");
    entry.used = true;
    const verifier = typeof body.codeVerifier === "string" ? body.codeVerifier : "";
    if (createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) {
      return refuse("pkce");
    }
    const session = randomBytes(16).toString("base64url");
    sessions.add(session);
    fake.accepted += 1;
    send(res, 200, JSON.stringify({ account: FAKE_ACCOUNT }), {
      "content-type": "application/json",
      "set-cookie": `${COOKIE_NAME}=${session}; Path=/; HttpOnly; SameSite=Lax`,
    });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    fake.requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      userAgent: String(req.headers["user-agent"] ?? ""),
    });
    const cookie = String(req.headers.cookie ?? "");
    const signedIn = [...sessions].some((s) => cookie.includes(`${COOKIE_NAME}=${s}`));

    if (url.pathname === "/api/v1/meta") {
      return send(
        res,
        200,
        JSON.stringify({
          name: "Fake Deployment",
          icon: "/icon.png?v=abc123",
          icons: { app: "/icon.png?v=abc123", maskable: null, favicon: null },
          protocols: { device: { min: 3, max: 3 } },
          features: { localDevices: true, appSignIn: true },
        }),
        { "content-type": "application/json", "cache-control": "no-store" },
      );
    }
    if (url.pathname === "/icon.png") return send(res, 200, PNG, { "content-type": "image/png" });
    if (url.pathname === "/apps/authorize") {
      const query = Object.fromEntries(url.searchParams);
      fake.authorize.push({ query });
      if (query.state && query.code_challenge) challenges.set(query.state, query.code_challenge);
      return send(res, 200, html("<p>authorize</p>"), { "content-type": "text/html" });
    }
    if (url.pathname === "/api/v1/app-auth/token" && method === "POST") {
      void token(req, res);
      return;
    }
    if (url.pathname === "/api/v1/auth/login") {
      fake.loginHits += 1;
      return send(res, 200, "{}", { "content-type": "application/json" });
    }
    if (url.pathname === "/ua") {
      return send(res, 200, String(req.headers["user-agent"] ?? ""), {
        "content-type": "text/plain",
      });
    }
    if (url.pathname === "/hop") {
      const to = url.searchParams.get("to") ?? "";
      return send(res, 302, "", { location: `${to}/ua` });
    }
    if (url.pathname === "/frame" || url.pathname === "/plugin-ui/x/frame") {
      return send(res, 200, FRAME_PAGE, { "content-type": "text/html" });
    }
    if (url.pathname === "/") {
      return send(res, 200, rootPage(signedIn, peer), {
        "content-type": "text/html",
        "cache-control": "no-store",
      });
    }
    send(res, 404, "not found");
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
