// The messages between a profile page, the native gate and the TypeScript runtime (mobile spec §5,
// decision 5). The page posts `PagePost`s to the one native endpoint; native checks the frame and
// the origin, validates the shape, adds the profile and the frame's origin, and forwards a
// `ShellCallMessage` to the runtime in the local Capacitor WebView. The runtime answers a
// `ShellCallResult` that native hands back to the posting document only.
import type { ShellCallError } from "@capybara-hq/plugin-sdk";

/** The fields of a profile the runtime reads (Task 14's `Profile` has these and more). */
export interface ProfileRef {
  id: string;
  /**
   * The origin as `normalizeAddress` serializes it (WHATWG: lower case host, punycode, no default
   * port); native serializes a frame's origin the same way.
   */
  origin: string;
}

export interface ShellCallMessage {
  /** Added by native: the profile of the WebView the post came from, never named by the page. */
  profileId: string;
  /** Added by native: the posting frame's security origin. */
  origin: string;
  /** Page-asserted: advisory, see `CallContext`. */
  docId: string;
  /** Assigned by native, unique per WebView instance. */
  callId: string;
  key: string;
  fn: string;
  args: unknown[];
  /** Page-asserted `navigator.userActivation.isActive`: advisory, see `CallContext`. */
  activation: boolean;
}

// A Record, so this fails to compile when the SDK adds a code it lacks.
const CALL_ERRORS: Record<ShellCallError, true> = {
  busy: true,
  no_activation: true,
  cancelled: true,
  failed: true,
};
/** Every `ShellCallError`, as a runtime list: the codes a call result may carry. */
export const SHELL_CALL_ERRORS: readonly ShellCallError[] = Object.keys(
  CALL_ERRORS,
) as ShellCallError[];

export type { ShellCallError };
export type ShellCallResult = { ok: true; value: unknown } | { ok: false; code: ShellCallError };

/**
 * What an implementation learns about a call. `profile` and `origin` come from native (the WebView
 * the post came from and the frame's checked origin). `docId` and `activation` are asserted by the
 * page itself and are advisory only: the registry uses `activation` to refuse confirming calls
 * early, but an implementation must never use either for authorization. The only real consent is
 * the person's tap on the native dialog a confirming function shows.
 */
export interface CallContext<P extends ProfileRef = ProfileRef> {
  profile: P;
  origin: string;
  /** Page-asserted, advisory. */
  docId: string;
  /** Page-asserted, advisory. */
  activation: boolean;
  /**
   * Aborts when the profile's document ends (native's `document` event, M3): a function that
   * waits on the person settles then; the registry answers the call `cancelled` either way.
   */
  signal: AbortSignal;
}

/** What a page posts to the native endpoint (`webkit.messageHandlers` / the web message port). */
export type PagePost =
  | { type: "hello"; docId: string }
  /** iOS: one outstanding post per document; native answers it with the queued pushes. */
  | { type: "listen"; docId: string }
  | {
      type: "call";
      docId: string;
      callId: string;
      key: string;
      fn: string;
      args: unknown[];
      activation: boolean;
    };

/**
 * What native delivers to a document: Android over the hello document's reply proxy, iOS as the
 * answer to that document's outstanding `listen` post (an array of pushes). Both are bound by the
 * platform to the document that posted, so no other document can receive them.
 */
export type NativePush =
  | { type: "reply"; callId: string; result: ShellCallResult }
  | { type: "denied"; callId: string }
  | { type: "state"; state: unknown }
  | { type: "event"; key: string; event: string; payload: unknown };

/** The shapes native accepts too (`ShellMessageHandler.swift`, `ShellMessageListener.kt`). */
export const DOC_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
export const CALL_ID_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;
export const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}@[0-9]{1,4}$/;
export const FN_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** The largest post native forwards, in bytes of its JSON. */
export const MAX_POST_BYTES = 65536;

/** The iOS script message handler and the Android web message listener. */
export const IOS_HANDLER_NAME = "capybaraShell";
export const ANDROID_PORT_NAME = "capybaraShellPort";

export function isShellCallMessage(v: unknown): v is ShellCallMessage {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.profileId === "string" &&
    typeof r.origin === "string" &&
    typeof r.docId === "string" &&
    DOC_ID_PATTERN.test(r.docId) &&
    typeof r.callId === "string" &&
    CALL_ID_PATTERN.test(r.callId) &&
    typeof r.key === "string" &&
    KEY_PATTERN.test(r.key) &&
    typeof r.fn === "string" &&
    FN_PATTERN.test(r.fn) &&
    Array.isArray(r.args) &&
    typeof r.activation === "boolean"
  );
}

export function isShellCallResult(v: unknown): v is ShellCallResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.ok === true) return "value" in r;
  return r.ok === false && SHELL_CALL_ERRORS.includes(r.code as ShellCallError);
}
