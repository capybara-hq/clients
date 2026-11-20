// The shell dialogs (desktop spec §7.4): every confirmation the app shows is drawn by the app in a
// separate, shell-owned window loading the local page app://local/dialog.html, which the remote
// page can neither draw nor click. Its content comes from the main process only; the answer comes
// back only as `dialog.answer` from that dialog's own webContents (the local page registry checks
// the sender), with the index checked against the dialog's buttons. The first answer wins; Esc,
// closing the window and the parent closing answer `cancelId`; the confirming button takes no
// answer in the first 500 ms after the window shows (enforced here, not only in the page).
// Electron objects come in as parameters.
import { type Locale, t } from "@capybara-hq/shell";
import type { DialogState } from "../local/dialog-model.ts";
import { isIconDataUrl } from "../local/icon-url.ts";
import type { BasePageState, PagePlatform } from "../shared/local-page.ts";
import { localPageUrl } from "../shared/protocol.ts";
import type { LocalPages } from "./local-pages.ts";
import { type ContentsLike, hardenLocalContents, localWebPreferences } from "./security.ts";

/** The contract of Electron's native message box (buttons, defaultId, cancelId), extended. */
export interface ShellDialogOptions {
  title: string;
  detail: string;
  /** In visual order: cancel first, the confirming button last (spec §7.4). */
  buttons: string[];
  /**
   * Kept for the native message box contract; the dialog always starts with the focus on `cancelId`,
   * so a stray Enter never confirms (spec §7.4).
   */
  defaultId: number;
  cancelId: number;
  /** Index of the confirming button and how it looks. */
  confirmId?: number;
  tone?: "primary" | "danger";
  platform?: { name: string; host: string; iconUrl?: string };
}

export type ShowShellDialog = (
  parent: unknown,
  o: ShellDialogOptions,
) => Promise<{ response: number }>;

export const DIALOG_WIDTH = 400;
export const DIALOG_MIN_HEIGHT = 160;
export const DIALOG_MAX_HEIGHT = 560;
/** The confirming button takes no answer this long after the dialog shows. */
export const CONFIRM_LOCKOUT_MS = 500;
export const MAX_BUTTONS = 16;

export interface DialogContents extends ContentsLike {
  id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
}

export interface DialogWindow {
  webContents: DialogContents;
  once(event: "ready-to-show" | "closed", listener: () => void): unknown;
  show(): void;
  close(): void;
  isDestroyed(): boolean;
  setContentSize(width: number, height: number): void;
  setPosition(x: number, y: number): void;
  loadURL(url: string): Promise<void>;
}

/** A calling window that still lives. */
export interface DialogParent {
  once(event: "closed", listener: () => void): unknown;
  removeListener(event: "closed", listener: () => void): unknown;
}

export interface DialogWindowOptions {
  width: number;
  height: number;
  useContentSize: true;
  show: false;
  frame: false;
  title: string;
  parent?: unknown;
  modal: boolean;
  alwaysOnTop: boolean;
  resizable: false;
  minimizable: false;
  maximizable: false;
  fullscreenable: false;
  skipTaskbar: true;
  backgroundColor?: string;
  webPreferences: ReturnType<typeof localWebPreferences>;
}

export interface ShellDialogDeps {
  createWindow(options: DialogWindowOptions): DialogWindow;
  localPages: Pick<LocalPages, "register" | "handle">;
  preloadPath: string;
  /** `parent` as a live window to attach the dialog to, else undefined (standalone). */
  liveParent(parent: unknown): DialogParent | undefined;
  /** Every field of the page state but the page and the platform: locale, appearance, … */
  pageBase(): Omit<BasePageState, "page" | "platform">;
  /** The work area of the active display, for a standalone dialog. */
  workArea?(): { x: number; y: number; width: number; height: number };
  backgroundColor?(): string;
  now?(): number;
  log?: (message: string, err?: unknown) => void;
}

/** The platform as the dialog shows it; an icon that is not a data: image URL is dropped. */
export function dialogPlatform(o: {
  name: string;
  host: string;
  iconUrl?: string | undefined;
}): PagePlatform {
  return {
    name: o.name,
    host: o.host,
    ...(isIconDataUrl(o.iconUrl) ? { iconUrl: o.iconUrl } : {}),
  };
}

function isIndex(v: unknown, count: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < count;
}

/** Throws on options the dialog cannot show faithfully (a caller bug, never page input). */
export function checkOptions(o: ShellDialogOptions): void {
  if (!Array.isArray(o.buttons) || o.buttons.length < 1 || o.buttons.length > MAX_BUTTONS) {
    throw new Error("a shell dialog needs 1 to 16 buttons");
  }
  if (!o.buttons.every((b) => typeof b === "string" && b.length > 0)) {
    throw new Error("a shell dialog button needs a label");
  }
  if (!isIndex(o.cancelId, o.buttons.length)) throw new Error("cancelId is not a button");
  if (!isIndex(o.defaultId, o.buttons.length)) throw new Error("defaultId is not a button");
  if (o.confirmId !== undefined) {
    if (!isIndex(o.confirmId, o.buttons.length)) throw new Error("confirmId is not a button");
    if (o.confirmId === o.cancelId) throw new Error("confirmId cannot be the cancel button");
  }
}

export function clampHeight(height: number): number {
  return Math.min(DIALOG_MAX_HEIGHT, Math.max(DIALOG_MIN_HEIGHT, Math.round(height)));
}

interface OpenDialog {
  window: DialogWindow;
  options: ShellDialogOptions;
  shownAt: number | undefined;
  parent: DialogParent | undefined;
  height: number;
  settle(response: number): void;
}

export function createShellDialogs(deps: ShellDialogDeps) {
  const now = deps.now ?? Date.now;
  /** Open dialogs by their webContents id. */
  const open = new Map<number, OpenDialog>();
  /** Parents with a dialog showing: a second dialog for one of them is refused. */
  const busyParents = new Set<DialogParent>();

  function place(d: OpenDialog): void {
    if (d.window.isDestroyed()) return;
    d.window.setContentSize(DIALOG_WIDTH, d.height);
    const area = d.parent ? undefined : deps.workArea?.();
    if (area) {
      d.window.setPosition(
        Math.round(area.x + (area.width - DIALOG_WIDTH) / 2),
        Math.round(area.y + (area.height - d.height) / 3),
      );
    }
  }

  deps.localPages.handle("dialog", "dialog.answer", (ctx, args) => {
    const d = open.get(ctx.contents.id);
    if (!d || d.window.webContents !== ctx.contents) return false;
    const index = args.index;
    if (!isIndex(index, d.options.buttons.length)) return false;
    if (index === d.options.confirmId) {
      // Not shown yet, or shown less than 500 ms ago: a click aimed at the page lands here.
      if (d.shownAt === undefined || now() - d.shownAt < CONFIRM_LOCKOUT_MS) return false;
    }
    d.settle(index);
    return true;
  });

  deps.localPages.handle("dialog", "dialog.resize", (ctx, args) => {
    const d = open.get(ctx.contents.id);
    if (!d || d.window.webContents !== ctx.contents || typeof args.height !== "number") return null;
    d.height = clampHeight(args.height);
    place(d);
    return null;
  });

  const show: ShowShellDialog = (parentArg, options) => {
    checkOptions(options);
    const parent = deps.liveParent(parentArg);
    if (parent && busyParents.has(parent)) {
      deps.log?.("a shell dialog is already open for this window");
      return Promise.resolve({ response: options.cancelId });
    }

    const state = (): DialogState => ({
      ...deps.pageBase(),
      page: "dialog",
      ...(options.platform ? { platform: dialogPlatform(options.platform) } : {}),
      title: options.title,
      detail: options.detail,
      buttons: [...options.buttons],
      cancelId: options.cancelId,
      confirmId: options.confirmId ?? null,
      tone: options.tone ?? "primary",
    });

    let window: DialogWindow;
    try {
      const bg = deps.backgroundColor?.();
      window = deps.createWindow({
        width: DIALOG_WIDTH,
        height: DIALOG_MIN_HEIGHT,
        useContentSize: true,
        show: false,
        frame: false,
        title: options.title,
        ...(parent ? { parent: parentArg } : {}),
        // On macOS a modal child is a sheet under the parent's title bar.
        modal: parent !== undefined,
        alwaysOnTop: parent === undefined,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        ...(bg ? { backgroundColor: bg } : {}),
        webPreferences: localWebPreferences({ preload: deps.preloadPath }),
      });
    } catch (err) {
      deps.log?.("the shell dialog window could not be created", err);
      return Promise.resolve({ response: options.cancelId });
    }

    return new Promise<{ response: number }>((resolve) => {
      const contents = window.webContents;
      let settled = false;
      let unregister: () => void = () => undefined;
      const onParentClosed = () => d.settle(options.cancelId);
      const d: OpenDialog = {
        window,
        options,
        shownAt: undefined,
        parent,
        height: DIALOG_MIN_HEIGHT,
        settle(response) {
          if (settled) return;
          settled = true;
          open.delete(contents.id);
          if (parent) {
            busyParents.delete(parent);
            try {
              parent.removeListener("closed", onParentClosed);
            } catch {
              // A destroyed parent has no listeners left to remove.
            }
          }
          unregister();
          if (!window.isDestroyed()) window.close();
          resolve({ response });
        },
      };
      open.set(contents.id, d);
      if (parent) {
        busyParents.add(parent);
        parent.once("closed", onParentClosed);
      }

      hardenLocalContents(contents);
      unregister = deps.localPages.register(contents, { kind: "dialog", state });
      // Esc cancels in main, whatever the page's script does.
      contents.on(
        "before-input-event",
        (_e: unknown, input: { type?: string; key?: string } | undefined) => {
          if (input?.type === "keyDown" && input.key === "Escape") d.settle(options.cancelId);
        },
      );
      contents.once("destroyed", () => d.settle(options.cancelId));
      window.once("closed", () => d.settle(options.cancelId));
      window.once("ready-to-show", () => {
        if (settled || window.isDestroyed()) return;
        place(d);
        window.show();
        d.shownAt = now();
      });
      window.loadURL(localPageUrl("dialog")).catch((err: unknown) => {
        deps.log?.("the shell dialog page did not load", err);
        d.settle(options.cancelId);
      });
    });
  };

  return {
    show,
    /** Board `SignOut` on a shell dialog: true only when the person chose 退出登录. */
    confirmSignOut: createConfirmSignOut(show, () => deps.pageBase().locale),
    /** The number of dialogs open now (tests, diagnostics). */
    openCount: () => open.size,
  };
}

export type ShellDialogs = ReturnType<typeof createShellDialogs>;

/** Board `SignOut`: 「退出 <平台>？」, the device note, 取消 then 退出登录 (primary). */
export function signOutDialogOptions(
  locale: Locale,
  platform: { name: string; host: string; iconUrl?: string },
): ShellDialogOptions {
  const tr = (key: string, vars?: Record<string, string>) => t(locale, key, vars);
  return {
    title: tr("signOut.title", { platform: platform.name || platform.host }),
    detail: tr("signOut.detail"),
    buttons: [tr("signOut.cancel"), tr("signOut.confirm")],
    defaultId: 0,
    cancelId: 0,
    confirmId: 1,
    tone: "primary",
    platform,
  };
}

/**
 * The sign-out confirmation (K7's 「平台」 menu entry): true only when the person chose 退出登录.
 * Built on a shell dialog; `parent` is the profile's window or null.
 */
export function createConfirmSignOut(show: ShowShellDialog, locale: () => Locale) {
  return async function confirmSignOut(
    parent: unknown,
    platform: { name: string; host: string; iconUrl?: string },
  ): Promise<boolean> {
    const options = signOutDialogOptions(locale(), platform);
    const { response } = await show(parent, options);
    return response === options.confirmId;
  };
}
