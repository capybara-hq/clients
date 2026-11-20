// The main side of the local pages (desktop spec §6.1, §6.8, §7.4): a registry of the webContents
// that show a local page (the small window, the main window's error overlay, a shell dialog), each
// with a kind. A page asks for its state and sends actions; main answers only a registered
// webContents whose top frame is app://local, and only for an action allowed for that kind, with
// arguments checked before any handler sees them. Handlers are installed by the features that own
// them (onboarding, sign-out, dialogs, preferences). Electron objects come in as parameters.
import type { LocalActResult, PageState } from "../shared/local-page.ts";
import { LOCAL_CHANNELS, LOCAL_ORIGIN } from "../shared/protocol.ts";
import type { FrameLike } from "./ipc.ts";
import { webContentsId } from "./windows.ts";

export type LocalPageKind = "onboarding" | "main-error" | "dialog";

export type LocalArgs = Record<string, unknown>;

/** Returns the clean arguments, or null to refuse the call as `invalid`. */
type ArgCheck = (args: LocalArgs) => LocalArgs | null;

const noArgs: ArgCheck = (args) => (Object.keys(args).length === 0 ? {} : null);

function oneOf(key: string, values: readonly string[]): ArgCheck {
  return (args) => {
    const v = args[key];
    return typeof v === "string" && values.includes(v) ? { [key]: v } : null;
  };
}

function text(key: string, max: number): ArgCheck {
  return (args) => {
    const v = args[key];
    return typeof v === "string" && v.length <= max ? { [key]: v } : null;
  };
}

function int(key: string, min: number, max: number): ArgCheck {
  return (args) => {
    const v = args[key];
    return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
      ? { [key]: v }
      : null;
  };
}

/**
 * Every action a page of each kind may send, with its argument check. A feature that needs a new
 * action adds it here, so the allowlist stays one reviewable table.
 */
export const LOCAL_PAGE_ACTIONS = {
  onboarding: {
    "prefs.setTheme": oneOf("theme", ["light", "dark"]),
    "prefs.setLocale": oneOf("locale", ["zh", "en"]),
    "connect.submit": text("address", 2048),
    "found.signIn": noArgs,
    "found.changeAddress": noArgs,
    "waiting.reopen": noArgs,
    "waiting.copyLink": noArgs,
    "waiting.cancel": noArgs,
    "signedOut.signIn": noArgs,
    "signedOut.addOther": noArgs,
    "signedOut.remove": noArgs,
  },
  "main-error": {
    "mainError.signIn": noArgs,
    "mainError.retry": noArgs,
    "mainError.signOut": noArgs,
    "mainError.switchPlatform": noArgs,
  },
  dialog: {
    "dialog.answer": int("index", 0, 15),
    /** The page's content height, so the window fits it (main clamps it). */
    "dialog.resize": int("height", 0, 4000),
  },
} as const satisfies Record<LocalPageKind, Record<string, ArgCheck>>;

export type LocalPageAction<K extends LocalPageKind> = keyof (typeof LOCAL_PAGE_ACTIONS)[K] &
  string;

export interface LocalContents {
  id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed?(): boolean;
  once?(event: "destroyed", listener: () => void): unknown;
}

export interface LocalPageRegistration {
  kind: LocalPageKind;
  /** The profile the page is about; absent for app-level pages (connect before any profile). */
  profileId?: string;
  /** The page's state now; called on every `state()` and push. */
  state(): PageState;
}

export interface LocalPageEntry extends LocalPageRegistration {
  contents: LocalContents;
}

export interface LocalActContext {
  contents: LocalContents;
  kind: LocalPageKind;
  profileId?: string;
}

export type LocalActHandler = (ctx: LocalActContext, args: LocalArgs) => unknown;

interface LocalEvent {
  sender: unknown;
  senderFrame?: FrameLike | null | undefined;
}

function isPlainObject(v: unknown): v is LocalArgs {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isAllowed(kind: LocalPageKind, action: string): boolean {
  return Object.hasOwn(LOCAL_PAGE_ACTIONS[kind], action);
}

export function createLocalPages(deps: { log?: (message: string, err?: unknown) => void } = {}) {
  const pages = new Map<number, LocalPageEntry>();
  const handlers = new Map<string, LocalActHandler>();
  const handlerKey = (kind: LocalPageKind, action: string) => `${kind}\u0000${action}`;

  /** The registered entry of a message from a local page's top frame, else undefined. */
  function sender(event: LocalEvent): LocalPageEntry | undefined {
    const id = webContentsId(event.sender);
    if (id === undefined) return undefined;
    const entry = pages.get(id);
    if (!entry) return undefined;
    try {
      // Reading a destroyed frame's properties throws in Electron.
      const frame = event.senderFrame;
      return frame && frame.parent === null && frame.origin === LOCAL_ORIGIN ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  function stateOf(entry: LocalPageEntry): PageState | null {
    try {
      return entry.state();
    } catch (err) {
      deps.log?.("local page state failed", err);
      return null;
    }
  }

  function send(entry: LocalPageEntry): void {
    if (entry.contents.isDestroyed?.()) return;
    const state = stateOf(entry);
    if (!state) return;
    try {
      entry.contents.send(LOCAL_CHANNELS.push, state);
    } catch (err) {
      deps.log?.("local page push failed", err);
    }
  }

  const registry = {
    /** Marks `contents` as a local page of `kind`; ends with the contents or the returned call. */
    register(contents: LocalContents, page: LocalPageRegistration): () => void {
      const entry: LocalPageEntry = { ...page, contents };
      pages.set(contents.id, entry);
      contents.once?.("destroyed", () => registry.unregister(contents));
      return () => registry.unregister(contents);
    },

    unregister(contents: LocalContents): void {
      if (pages.get(contents.id)?.contents === contents) pages.delete(contents.id);
    },

    /** The kind of a registered sender (for other main-side checks), else undefined. */
    kindOf(contents: unknown): LocalPageKind | undefined {
      const id = webContentsId(contents);
      return id === undefined ? undefined : pages.get(id)?.kind;
    },

    entries(filter?: (entry: LocalPageEntry) => boolean): LocalPageEntry[] {
      const all = [...pages.values()];
      return filter ? all.filter(filter) : all;
    },

    /**
     * Installs the handler of one action for one kind; the action must be in
     * `LOCAL_PAGE_ACTIONS[kind]` and have no handler yet. Returns the uninstall.
     */
    handle<K extends LocalPageKind>(
      kind: K,
      action: LocalPageAction<K>,
      handler: LocalActHandler,
    ): () => void {
      if (!isAllowed(kind, action)) throw new Error(`${action} is not an action of ${kind} pages`);
      const key = handlerKey(kind, action);
      if (handlers.has(key)) throw new Error(`${kind} ${action} already has a handler`);
      handlers.set(key, handler);
      return () => {
        if (handlers.get(key) === handler) handlers.delete(key);
      };
    },

    /** Sends a fresh state to every registered page the filter accepts (all when absent). */
    push(filter?: (entry: LocalPageEntry) => boolean): void {
      for (const entry of registry.entries(filter)) send(entry);
    },

    handleState(event: LocalEvent): PageState | null {
      const entry = sender(event);
      return entry ? stateOf(entry) : null;
    },

    async handleAct(event: LocalEvent, raw: unknown): Promise<LocalActResult> {
      const entry = sender(event);
      if (!entry || !isPlainObject(raw) || typeof raw.action !== "string") {
        return { ok: false, error: "refused" };
      }
      const { action } = raw;
      if (!isAllowed(entry.kind, action)) return { ok: false, error: "refused" };
      const rawArgs = raw.args === undefined ? {} : raw.args;
      if (!isPlainObject(rawArgs)) return { ok: false, error: "invalid" };
      const checks: Record<string, ArgCheck> = LOCAL_PAGE_ACTIONS[entry.kind];
      const args = (checks[action] as ArgCheck)(rawArgs);
      if (!args) return { ok: false, error: "invalid" };
      const handler = handlers.get(handlerKey(entry.kind, action));
      if (!handler) return { ok: false, error: "unavailable" };
      try {
        const value = await handler(
          {
            contents: entry.contents,
            kind: entry.kind,
            ...(entry.profileId === undefined ? {} : { profileId: entry.profileId }),
          },
          args,
        );
        return { ok: true, value: value === undefined ? null : value };
      } catch (err) {
        deps.log?.(`local page action ${action} failed`, err);
        return { ok: false, error: "failed" };
      }
    },

    install(ipcMain: {
      handle(channel: string, listener: (event: LocalEvent, raw: unknown) => unknown): unknown;
    }): void {
      ipcMain.handle(LOCAL_CHANNELS.state, (event) => registry.handleState(event));
      ipcMain.handle(LOCAL_CHANNELS.act, (event, raw) => registry.handleAct(event, raw));
    },
  };
  return registry;
}

export type LocalPages = ReturnType<typeof createLocalPages>;
