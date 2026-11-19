// TEMPORARY: mirror of @capybara-hq/plugin-sdk shell types until it is published; replace with the SDK import.
//
// Sources: the Shell environment shape of the mobile layout spec §9.1 and the capability types of
// the desktop plan's core Task 2. `chrome@1` is the mobile spec's (§9.2), defined locally here.

/** The Shell environment a native shell injects as `window.capybaraShell` (mobile spec §9.1). */
export interface CapybaraShell {
  /** The envelope version; bumped only on an incompatible change of this shape. */
  readonly version: 1;
  /** Which shell: drives nothing but the shell attributes. */
  readonly kind: "desktop" | "mobile";
  /** The operating system, for platform conventions only. */
  readonly platform: "macos" | "windows" | "linux" | "ios" | "android";
  /** The shell's own version, for reports and diagnostics; never parsed for features. */
  readonly shellVersion: string;
  /** CSS px the shell's own chrome covers at each edge of the web view. */
  readonly insets: { top: number; right: number; bottom: number; left: number };
  /** The window controls' rectangle in CSS px; null when hidden (fullscreen). */
  readonly controls?: { x: number; y: number; width: number; height: number } | null;
  /** Capabilities by `name@major`. */
  readonly capabilities: Readonly<Record<string, object>>;
  /** Insets, controls or capabilities changed. Returns unsubscribe. */
  on(event: "change", listener: () => void): () => void;
}

/** The registry of capability names (mobile spec §9.2). */
export const SHELL_CAPABILITIES = [
  "device@1",
  "notify@1",
  "openExternal@1",
  "signIn@1",
  "chrome@1",
] as const;
export type ShellCapabilityKey = (typeof SHELL_CAPABILITIES)[number];

export const SHELL_CAPABILITY_KEYS = {
  device: "device@1",
  notify: "notify@1",
  openExternal: "openExternal@1",
  signIn: "signIn@1",
  /** The mobile spec's key (§9.2), not in core Task 2's constant: local until the SDK has it. */
  chrome: "chrome@1",
} as const;

export type KeepAwakeMode = "off" | "while-busy" | "connected";
export type DeviceConnection = "starting" | "online" | "offline" | "draining" | "stopped";
export type ThisMachineStatus =
  | { state: "not_connected" }
  | { state: "connected_elsewhere"; origin: string }
  | {
      state: "connected";
      deviceId: string;
      orgId: string;
      mode: "os" | "docker";
      connection: DeviceConnection;
      offlineReason?: string;
      serviceInstalled: boolean;
      keepAwake: { mode: KeepAwakeMode; held: boolean; unavailable?: string };
      lastWakeAt?: string;
    };
export interface RunningOperationView {
  tag: string;
  conversationId: string | null;
  accountId: string | null;
  isolation: "restricted" | "full";
  startedAt: string;
}
/** A rejected capability promise carries `{ code: ShellCallError }`. */
export type ShellCallError = "busy" | "no_activation" | "cancelled" | "failed";
export const SHELL_CALL_ERRORS: readonly ShellCallError[] = [
  "busy",
  "no_activation",
  "cancelled",
  "failed",
];

export interface DeviceCapabilityV1 {
  status(): Promise<ThisMachineStatus>;
  onStatus(listener: (s: ThisMachineStatus) => void): () => void;
  running(): Promise<RunningOperationView[]>;
  connect(input: { orgId: string; deviceId?: string }): Promise<"connected" | "cancelled">;
  pause(): Promise<void>;
  resume(): Promise<"resumed" | "cancelled">;
  disconnect(): Promise<void>;
  requestCeiling(input: {
    fullAccess: boolean;
    projectReach: "workspace" | "os-user";
  }): Promise<"applied" | "cancelled">;
  setKeepAwake(mode: KeepAwakeMode): Promise<"applied" | "cancelled">;
}
export interface NotifyCapabilityV1 {
  notify(input: { title: string; body: string; path?: string }): Promise<void>;
}
export interface OpenExternalCapabilityV1 {
  open(url: string): Promise<void>;
}
export interface SignInCapabilityV1 {
  start(): Promise<"signedIn" | "cancelled">;
}
/** `chrome@1` (mobile spec §9.2): native chrome follows the web's theme. */
export interface ChromeCapabilityV1 {
  setAppearance(input: { scheme: "light" | "dark"; background: string }): Promise<void>;
}
