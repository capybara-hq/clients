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

/** Android: the web message port; replies, drops and pushes all arrive on it as JSON. */
export function androidTransport(win: Record<string, unknown>): NativeTransport | null {
  const port = win[ANDROID_PORT_NAME] as AndroidPort | undefined;
  if (!port || typeof port.postMessage !== "function") return null;
  const post = port.postMessage.bind(port);
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const pending = new Map<string, (result: ShellCallResult) => void>();
  let receiver: ((push: { type: string }) => void) | undefined;
  port.addEventListener("message", (event) => {
    let push: unknown;
    try {
      push = typeof event.data === "string" ? parse(event.data) : undefined;
    } catch {
      return;
    }
    if (typeof push !== "object" || push === null) return;
    const p = push as Record<string, unknown>;
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
    hello(docId) {
      post(stringify({ type: "hello", docId }));
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
    transport: init?.platform === "android" ? androidTransport(win) : iosTransport(win),
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
