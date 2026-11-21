// The Shell environment script (mobile spec §5.3, §15.2). Native injects this bundle at document
// start into profile WebViews, wrapped as `(function (__capybaraShellInit) { … })(<init JSON>)`:
// iOS as a main-frame-only `WKUserScript`, Android with `addDocumentStartJavaScript` limited to
// the profile origin. It defines `window.capybaraShell` only in the top frame of a document whose
// own origin (`self.origin`, "null" when opaque) is exactly the profile origin; everything else
// gets nothing. This is a convenience check: the boundary is native's frame and origin check on
// every post (OriginGate). Page scripts run after this one, so the native endpoints and the
// activation getter are captured before a page could patch them.
//
// The document id and the activation flag each call carries are asserted by this page: advisory
// for the runtime, never an authorization. The person's tap on a native dialog is the consent.
//
// Only node-free code may be imported here (the installer subpath of @capybara-hq/shell).
import {
  type CapabilityDescriptors,
  installShellEnvironment,
  type ShellBridge,
  type ShellInit,
  type ShellState,
} from "@capybara-hq/shell/install-shell";
import {
  ANDROID_PORT_NAME,
  IOS_HANDLER_NAME,
  isShellCallResult,
  type PagePost,
  type ShellCallResult,
} from "../runtime/protocol.ts";

export interface InjectInit extends ShellInit {
  platform: "ios" | "android";
}

/** How the script reaches native; built from the endpoints captured at document start. */
export interface NativeTransport {
  /** Posts a call; resolves the native result (a drop resolves `failed`, never hangs). */
  call(post: Extract<PagePost, { type: "call" }>): Promise<ShellCallResult>;
  /** Tells native which document is current, so it pushes changes and events to this one. */
  hello(docId: string): void;
  /** Native pushes (`state`, `event`) for this document. */
  onPush(listener: (push: { type: string; [k: string]: unknown }) => void): void;
  /**
   * The transport lost its push channel (a rejected listen): the script sends a fresh hello. The
   * transport bounds how often it asks in a row.
   */
  onRestart?(listener: () => void): void;
  /** The document came back from the back/forward cache: the restart budget starts again. */
  restored?(): void;
  /** Android: a new window's URL for the browser sheet (the wrapped `window.open`). */
  open?(post: Extract<PagePost, { type: "open" }>): void;
}

export interface InjectDeps {
  init: unknown;
  /** Where `capybaraShell` is defined: the page's `window`. */
  target: object;
  /** `window.top === window`, read at document start. */
  isTopFrame: boolean;
  /** `self.origin` at document start: "null" for an opaque origin (a sandbox CSP). */
  windowOrigin: string;
  randomId(): string;
  /** `navigator.userActivation.isActive`, through the getter captured at document start. */
  userActivation(): boolean;
  /** Null when the platform's endpoint is missing in this document. */
  transport: NativeTransport | null;
  /**
   * Calls the listener when the document comes back from the back/forward cache (`pageshow` with
   * `persisted`). Optional: tests and old hosts omit it.
   */
  onRestore?(listener: () => void): void;
  /** The document's URL at call time, to resolve a relative `window.open` URL. */
  baseUrl?(): string;
}

function isDescriptors(v: unknown): v is CapabilityDescriptors {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every(
      (names) => Array.isArray(names) && names.every((n) => typeof n === "string"),
    )
  );
}

function isInsets(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return ["top", "right", "bottom", "left"].every((k) => typeof r[k] === "number");
}

function isState(v: unknown): v is ShellState {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    isInsets(r.insets) &&
    isDescriptors(r.capabilities) &&
    (r.events === undefined || isDescriptors(r.events))
  );
}

export function isInjectInit(v: unknown): v is InjectInit {
  if (!isState(v)) return false;
  const r = v as unknown as Record<string, unknown>;
  return (
    typeof r.origin === "string" &&
    (r.platform === "ios" || r.platform === "android") &&
    typeof r.shellVersion === "string"
  );
}

/**
 * Installs the Shell environment when this document is the top frame on exactly the profile
 * origin and the native endpoint exists. Returns whether it installed. Never touches
 * `window.Capacitor`.
 */
export function bootShellEnvironment(deps: InjectDeps): boolean {
  if (!deps.isTopFrame) return false;
  if (!isInjectInit(deps.init)) return false;
  const init = deps.init;
  if (deps.windowOrigin === "null" || deps.windowOrigin !== init.origin) return false;
  const transport = deps.transport;
  if (!transport) return false;

  let docId = deps.randomId();
  let nextCall = 1;
  let changed: ((state: ShellState) => void) | undefined;
  const subscribers = new Map<string, Set<(payload: unknown) => void>>();

  transport.onPush((push) => {
    if (push.type === "state") {
      if (isState(push.state)) changed?.(push.state);
    } else if (push.type === "event") {
      if (typeof push.key !== "string" || typeof push.event !== "string") return;
      for (const listener of [...(subscribers.get(`${push.key} ${push.event}`) ?? [])]) {
        listener(push.payload);
      }
    }
  });

  const bridge: ShellBridge = {
    call(key, fn, args) {
      const activation = deps.userActivation();
      return transport
        .call({ type: "call", docId, callId: String(nextCall++), key, fn, args, activation })
        .catch(() => ({ ok: false, code: "failed" }) as const);
    },
    onChange(listener) {
      changed = listener;
    },
    subscribe(key, event, listener) {
      const name = `${key} ${event}`;
      let set = subscribers.get(name);
      if (!set) {
        set = new Set();
        subscribers.set(name, set);
      }
      const entry = (payload: unknown) => listener(payload);
      set.add(entry);
      return () => {
        set.delete(entry);
      };
    },
  };

  installShellEnvironment({ ...init, kind: "mobile" }, bridge, deps.target);
  const open = transport.open;
  if (init.platform === "android" && open) {
    // R14 on Android: multiple windows are on so links reach onCreateWindow, but a script's
    // window.open carries no URL there. Here it posts the URL (resolved against the document) to
    // native, which sends it to the browser sheet; nothing ever opens or navigates in place.
    const resolve = (url: unknown): string | null => {
      try {
        const u = new URL(String(url ?? ""), deps.baseUrl?.() || init.origin);
        return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
      } catch {
        return null;
      }
    };
    Object.defineProperty(deps.target, "open", {
      value: (url?: unknown) => {
        // An empty or non-http(s) URL opens nothing (the policy would block it anyway).
        const href = url === undefined || url === "" ? null : resolve(url);
        if (href) open({ type: "open", docId, url: href });
        return null;
      },
      writable: false,
      configurable: false,
    });
  }
  transport.hello(docId);
  // A restored page or a lost push channel gets a fresh hello, still through native's gate: a
  // document that is not the profile's gated main frame stays rejected.
  const rehello = (): void => {
    docId = deps.randomId();
    transport.hello(docId);
  };
  transport.onRestart?.(rehello);
  deps.onRestore?.(() => {
    transport.restored?.();
    rehello();
  });
  return true;
}

// ---- Platform transports, built from what exists at document start ----

interface IosHandler {
  postMessage(message: unknown): Promise<unknown>;
}

/**
 * iOS: `WKScriptMessageHandlerWithReply` answers each post. Pushes are pulled: after hello the
 * script keeps one `listen` post outstanding, native answers it with the pushes queued for this
 * document, and the script posts the next one. WebKit binds a reply to the document that posted,
 * so a push never reaches another document (the same property as Android's reply proxy). A
 * rejected listen (the document ended, a bfcache restore, or a drop) ends that loop and asks the
 * script for a fresh hello, at most `MAX_RESTARTS` times in a row (a listen that native answers,
 * or a restore from the back/forward cache, resets the count), so a document native keeps
 * rejecting stops asking.
 */
const MAX_RESTARTS = 3;

export function iosTransport(win: Record<string, unknown>): NativeTransport | null {
  const webkit = win.webkit as { messageHandlers?: Record<string, IosHandler> } | undefined;
  const handler = webkit?.messageHandlers?.[IOS_HANDLER_NAME];
  if (!handler || typeof handler.postMessage !== "function") return null;
  const post = handler.postMessage.bind(handler);
  const isArray = Array.isArray;
  let receiver: ((push: { type: string }) => void) | undefined;
  let restart: (() => void) | undefined;
  let current = "";
  let restarts = 0;
  const listen = (docId: string): void => {
    post({ type: "listen", docId }).then(
      (pushes) => {
        if (!isArray(pushes) || docId !== current) return;
        restarts = 0;
        for (const push of pushes) {
          if (typeof push === "object" && push !== null) receiver?.(push as { type: string });
        }
        listen(docId);
      },
      () => {
        if (docId !== current || restarts >= MAX_RESTARTS) return;
        restarts += 1;
        restart?.();
      },
    );
  };
  return {
    call(message) {
      return post(message).then(
        (value) => (isShellCallResult(value) ? value : ({ ok: false, code: "failed" } as const)),
        () => ({ ok: false, code: "failed" }) as const,
      );
    },
    hello(docId) {
      current = docId;
      post({ type: "hello", docId }).then(
        () => {
          if (docId === current) listen(docId);
        },
        () => {},
      );
    },
    onPush(listener) {
      receiver = listener;
    },
    onRestart(listener) {
      restart = listener;
    },
    restored() {
      restarts = 0;
    },
  };
}

interface AndroidPort {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<unknown>;
type Getter = (this: unknown) => unknown;

/**
 * Android: the web message port; replies, drops and pushes all arrive on it as JSON.
 *
 * Sign-in (Task 17 fix I1): the port is taken off `window` here, before any page script runs, so a
 * page can neither listen on it nor post through it; only this closure holds it. Native sends the
 * code exchange (and the logout of an unwanted session) as a `post` push, and this script runs it
 * with the `fetch` it captured at document start: a page that patches `fetch` later never sees the
 * code, the verifier or the redirect URI. Only `{ ok, status, hasAccount }` goes back.
 *
 * Android has no isolated world, so everything on the post's path is taken at document start
 * (fix round 2): the message data is read through the original `MessageEvent.prototype.data`
 * getter, the request init and headers have no prototype (a page getter on `Object.prototype` is
 * never asked for a missing member), and native's checked URL string goes to the saved `fetch`
 * as is (no `URL.prototype` getter re-derives it).
 *
 * The outcome is computed the same way (wave T2, N1), so a page cannot forge it (for example
 * `hasAccount` to skip the revoke of an unwanted session): promises are chained with the saved
 * `Promise.prototype.then`, each with an own `constructor` of undefined (no species lookup); the
 * response is read through `Response.prototype` getters and `text` saved at start; a response
 * whose URL is not the one posted (one a page's `Object.prototype.then` swapped in while fetch
 * resolved) is a failure; the body is text (a string resolves without a `then` lookup) parsed by
 * the saved `JSON.parse`, and `account` is read as an own value; the result native reads is a
 * record with no prototype (no `toJSON`). `Object.hasOwn` is not used: it needs Chromium 93, and
 * the saved `Object.prototype.hasOwnProperty` works on every WebView with the gate's features.
 */
export function androidTransport(win: Record<string, unknown>): NativeTransport | null {
  const port = win[ANDROID_PORT_NAME] as AndroidPort | undefined;
  if (!port || typeof port.postMessage !== "function") return null;
  const post = port.postMessage.bind(port);
  try {
    delete win[ANDROID_PORT_NAME];
  } catch {
    // Native checks the port is gone before it sends a post (`"capybaraShellPort" in window`).
  }
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const apply = Reflect.apply;
  const createObject = Object.create;
  const defineProperty = Object.defineProperty;
  const ownDescriptor = Object.getOwnPropertyDescriptor;
  const ownPropertyCheck = Object.prototype.hasOwnProperty;
  const hasOwn = (o: object, key: string): boolean => apply(ownPropertyCheck, o, [key]) === true;
  const promiseThen = Promise.prototype.then;
  const messageData =
    typeof MessageEvent === "function"
      ? Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")?.get
      : undefined;
  const fetchAtStart =
    typeof win.fetch === "function" ? (win.fetch as FetchLike).bind(win) : undefined;
  const responseClass = win.Response as ((...args: never[]) => unknown) | undefined;
  const responseProto =
    typeof responseClass === "function" ? (responseClass.prototype as object) : undefined;
  const getterAtStart = (name: string): Getter | undefined => {
    const d = responseProto ? ownDescriptor(responseProto, name) : undefined;
    return typeof d?.get === "function" ? (d.get as Getter) : undefined;
  };
  const responseOk = getterAtStart("ok");
  const responseStatus = getterAtStart("status");
  const responseUrl = getterAtStart("url");
  const textDescriptor = responseProto ? ownDescriptor(responseProto, "text") : undefined;
  const responseText =
    typeof textDescriptor?.value === "function" ? (textDescriptor.value as Getter) : undefined;
  const timeout =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout.bind(AbortSignal)
      : undefined;
  const pending = new Map<string, (result: ShellCallResult) => void>();
  let receiver: ((push: { type: string }) => void) | undefined;
  let docId = "";

  /** A record with no prototype: reading a member it lacks never reaches a page getter. */
  const bare = (): Record<string, unknown> => createObject(null) as Record<string, unknown>;

  /** `p.then(onOk, onErr)` with nothing looked up on the page's prototypes. */
  const chain = (p: unknown, onOk: (v: unknown) => void, onErr: () => void): void => {
    const noSpecies = bare();
    noSpecies.value = undefined;
    defineProperty(p, "constructor", noSpecies as PropertyDescriptor);
    apply(promiseThen, p, [onOk, onErr]);
  };

  /** Runs the post; `done` is called once with the outcome, never with a page-made value. */
  function runPost(
    url: string,
    body: string | null,
    done: (ok: boolean, status: number, hasAccount: boolean) => void,
  ): void {
    let finished = false;
    const finish = (ok: boolean, status: number, hasAccount: boolean) => {
      if (finished) return;
      finished = true;
      done(ok, status, hasAccount);
    };
    const fail = () => finish(false, 0, false);
    if (!fetchAtStart || !responseOk || !responseStatus || !responseUrl || !responseText) {
      fail();
      return;
    }
    const headers = bare();
    if (body !== null) headers["Content-Type"] = "application/json";
    headers["X-Capybara-Csrf"] = "1";
    const init = bare();
    init.method = "POST";
    init.headers = headers;
    init.credentials = "include";
    init.redirect = "error";
    init.cache = "no-store";
    if (body !== null) init.body = body;
    if (timeout) init.signal = timeout(30000);
    try {
      // Native checked `url` is on the profile origin; it goes to fetch as the string it sent.
      chain(
        fetchAtStart(url, init),
        (res) => {
          try {
            // `redirect: "error"`: the response fetch made carries the URL posted, one a page made
            // up carries none (the brand-checked getters throw on anything but a Response).
            if (apply(responseUrl, res, []) !== url) return fail();
            const status = apply(responseStatus, res, []);
            if (typeof status !== "number") return fail();
            if (apply(responseOk, res, []) !== true) return finish(false, status, false);
            chain(
              apply(responseText, res, []),
              (text) => {
                let hasAccount = false;
                try {
                  const data: unknown = typeof text === "string" ? parse(text) : null;
                  if (data !== null && typeof data === "object" && hasOwn(data, "account")) {
                    const own = ownDescriptor(data, "account");
                    const account = own && hasOwn(own, "value") ? own.value : null;
                    hasAccount = account !== null && typeof account === "object";
                  }
                } catch {}
                finish(true, status, hasAccount);
              },
              () => finish(true, status, false),
            );
          } catch {
            fail();
          }
        },
        fail,
      );
    } catch {
      fail();
    }
  }

  port.addEventListener("message", (event) => {
    let push: unknown;
    try {
      // Only the platform dispatches on this port. Its event carries `data` as an own value (read
      // from the descriptor, so no getter runs), or it is a MessageEvent whose `data` getter is
      // the one saved at document start: a page's later patch of either is never asked.
      const own = ownDescriptor(event, "data");
      let data: unknown;
      if (own) {
        if (!("value" in own)) return;
        data = own.value;
      } else if (messageData) {
        data = apply(messageData, event, []);
      } else {
        return;
      }
      push = typeof data === "string" ? parse(data) : undefined;
    } catch {
      return;
    }
    if (typeof push !== "object" || push === null) return;
    const p = push as Record<string, unknown>;
    // A sign-in post first, reading own members only: a lookup of a member it lacks would walk to
    // `Object.prototype`, where a page getter could read the body.
    if (hasOwn(p, "type") && p.type === "post") {
      const id = hasOwn(p, "id") ? p.id : undefined;
      const url = hasOwn(p, "url") ? p.url : undefined;
      const body = hasOwn(p, "body") ? p.body : undefined;
      if (typeof id !== "string" || typeof url !== "string") return;
      if (body !== null && typeof body !== "string") return;
      runPost(url, body, (ok, status, hasAccount) => {
        const result = bare();
        result.type = "post-result";
        result.docId = docId;
        result.id = id;
        result.ok = ok;
        result.status = status;
        result.hasAccount = hasAccount;
        post(stringify(result));
      });
      return;
    }
    if ((p.type === "reply" || p.type === "denied") && typeof p.callId === "string") {
      const resolve = pending.get(p.callId);
      if (!resolve) return;
      pending.delete(p.callId);
      resolve(
        p.type === "reply" && isShellCallResult(p.result)
          ? p.result
          : { ok: false, code: "failed" },
      );
      return;
    }
    receiver?.(p as { type: string });
  });
  return {
    call(message) {
      return new Promise((resolve) => {
        pending.set(message.callId, resolve);
        post(stringify(message));
      });
    },
    hello(id) {
      docId = id;
      post(stringify({ type: "hello", docId: id }));
    },
    open(message) {
      post(stringify(message));
    },
    onPush(listener) {
      receiver = listener;
    },
  };
}

declare const __capybaraShellInit: unknown;

/** The document-start entry: runs only when native wrapped the bundle with an init. */
function main(): void {
  if (typeof __capybaraShellInit === "undefined") return;
  const win = globalThis as unknown as Record<string, unknown> & Window;
  const init = __capybaraShellInit as { platform?: unknown };
  const nav = win.navigator as Navigator & { userActivation?: object };
  const activationObject = nav?.userActivation;
  const activationClass = (win as { UserActivation?: { prototype: object } }).UserActivation;
  const activationGetter =
    activationObject && activationClass
      ? Object.getOwnPropertyDescriptor(activationClass.prototype, "isActive")?.get
      : undefined;
  const randomUUID = crypto.randomUUID.bind(crypto);
  bootShellEnvironment({
    init,
    target: win,
    isTopFrame: win.top === win,
    windowOrigin: String(win.origin),
    randomId: () => randomUUID(),
    userActivation: () =>
      activationGetter && activationObject
        ? activationGetter.call(activationObject) === true
        : false,
    // Android: only the top frame takes its port (off its window); a same-origin frame keeps its
    // own, whose posts the gate drops and which never receives the top document's pushes.
    transport:
      init?.platform === "android"
        ? win.top === win
          ? androidTransport(win)
          : null
        : iosTransport(win),
    baseUrl: () => String((win.location as { href?: unknown } | undefined)?.href ?? ""),
    onRestore: (listener) => {
      const target = win as unknown as {
        addEventListener(type: "pageshow", fn: (event: { persisted?: boolean }) => void): void;
      };
      target.addEventListener("pageshow", (event) => {
        if (event.persisted === true) listener();
      });
    },
  });
}

main();
