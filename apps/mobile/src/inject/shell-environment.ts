// The Shell environment script (mobile spec §5.3, §15.2). Native injects this bundle at document
// start into profile WebViews, wrapped as `(function (__capybaraShellInit) { … })(<init JSON>)`:
// iOS as a main-frame-only `WKUserScript`, Android with `addDocumentStartJavaScript` limited to
// the profile origin. It defines `window.capybaraShell` only in the top frame of a document whose
// own origin (`self.origin`, "null" when opaque) is exactly the profile origin; everything else
// gets nothing. This is a convenience check: the boundary is native's frame and origin check on
// every post (OriginGate). Page scripts run after this one, so the native endpoints and the
// activation getter are captured before a page could patch them.
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
  RECEIVER_NAME,
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

  const docId = deps.randomId();
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
  transport.hello(docId);
  return true;
}

// ---- Platform transports, built from what exists at document start ----

interface IosHandler {
  postMessage(message: unknown): Promise<unknown>;
}

/** iOS: `WKScriptMessageHandlerWithReply` answers each post; pushes arrive through the receiver. */
export function iosTransport(win: Record<string, unknown>, target: object): NativeTransport | null {
  const webkit = win.webkit as { messageHandlers?: Record<string, IosHandler> } | undefined;
  const handler = webkit?.messageHandlers?.[IOS_HANDLER_NAME];
  if (!handler || typeof handler.postMessage !== "function") return null;
  const post = handler.postMessage.bind(handler);
  let receiver: ((push: { type: string }) => void) | undefined;
  let ownDoc: string | undefined;
  return {
    call(message) {
      return post(message).then(
        (value) => (isShellCallResult(value) ? value : ({ ok: false, code: "failed" } as const)),
        () => ({ ok: false, code: "failed" }) as const,
      );
    },
    hello(docId) {
      ownDoc = docId;
      // Native pushes `window.__capybaraShellReceive(docId, push)` into the current document.
      Object.defineProperty(target, RECEIVER_NAME, {
        value: (doc: unknown, push: unknown) => {
          if (doc !== ownDoc || typeof push !== "object" || push === null) return;
          receiver?.(push as { type: string });
        },
        enumerable: false,
        configurable: false,
        writable: false,
      });
      post({ type: "hello", docId }).catch(() => {});
    },
    onPush(listener) {
      receiver = listener;
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
    transport: init?.platform === "android" ? androidTransport(win) : iosTransport(win, win),
  });
}

main();
