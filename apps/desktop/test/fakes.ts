// Small in-memory stand-ins for the Electron and fs objects the main-process modules take.
import { vi } from "vitest";

export function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const open = new Map<number, { path: string; data: string; synced: boolean }>();
  /** The order of write, fsync, close and rename calls. */
  const log: string[] = [];
  let nextFd = 3;
  return {
    files,
    log,
    readFileSync: (path: string, _enc: "utf8") => {
      const v = files.get(path);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
    openSync: (path: string, _flags: "w") => {
      const fd = nextFd++;
      open.set(fd, { path, data: "", synced: false });
      return fd;
    },
    writeSync: (fd: number, data: string) => {
      const f = open.get(fd);
      if (!f) throw new Error("EBADF");
      f.data += data;
      log.push(`write ${f.path}`);
    },
    fsyncSync: (fd: number) => {
      const f = open.get(fd);
      if (!f) throw new Error("EBADF");
      f.synced = true;
      log.push(`fsync ${f.path}`);
    },
    closeSync: (fd: number) => {
      const f = open.get(fd);
      if (!f) throw new Error("EBADF");
      files.set(f.path, f.data);
      open.delete(fd);
      log.push(`close ${f.path}`);
    },
    renameSync: (from: string, to: string) => {
      const v = files.get(from);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.delete(from);
      files.set(to, v);
      log.push(`rename ${from} ${to}`);
    },
    mkdirSync: (_path: string, _opts: { recursive: true }) => undefined,
  };
}

type Listener = (...args: unknown[]) => void;

export function fakeEmitter() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(event: string, l: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), l]);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners.get(event) ?? []) l(...args);
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
  };
}

export function fakeFrame(origin: string, parent: unknown | null = null) {
  return { origin, parent };
}

let nextId = 1;

export function fakeWebContents(origin = "https://capybara.example.com") {
  const em = fakeEmitter();
  let openHandler: ((d: { url: string }) => unknown) | undefined;
  const wc = {
    id: nextId++,
    ...em,
    on: em.on,
    mainFrame: { origin, parent: null },
    send: vi.fn(),
    loadURL: vi.fn(async (_url: string) => undefined),
    reload: vi.fn(),
    isDestroyed: () => false,
    setWindowOpenHandler(h: (d: { url: string }) => unknown) {
      openHandler = h;
    },
    openWindow(url: string) {
      if (!openHandler) throw new Error("no window open handler");
      return openHandler({ url });
    },
  };
  return wc;
}

export function fakeSession() {
  let request:
    | ((
        wc: unknown,
        permission: string,
        cb: (granted: boolean) => void,
        details: { requestingUrl: string; isMainFrame: boolean },
      ) => void)
    | undefined;
  let check:
    | ((
        wc: unknown,
        permission: string,
        origin: string,
        details: { isMainFrame: boolean; requestingUrl?: string },
      ) => boolean)
    | undefined;
  let device: ((d: unknown) => boolean) | undefined;
  let beforeRequest:
    | ((
        details: { url: string; method: string },
        cb: (response: { cancel?: boolean }) => void,
      ) => void)
    | undefined;
  return {
    webRequest: {
      onBeforeRequest: vi.fn((l: typeof beforeRequest) => {
        beforeRequest = l;
      }),
    },
    /** Runs a request through the webRequest listener: true when cancelled, false otherwise. */
    beforeRequest(method: string, url: string): boolean {
      if (!beforeRequest) return false;
      let cancel = false;
      beforeRequest({ method, url }, (r) => {
        cancel = r.cancel === true;
      });
      return cancel;
    },
    setPermissionRequestHandler(h: typeof request) {
      request = h;
    },
    setPermissionCheckHandler(h: typeof check) {
      check = h;
    },
    setDevicePermissionHandler(h: typeof device) {
      device = h;
    },
    request(permission: string, requestingUrl: string, isMainFrame = true): Promise<boolean> {
      if (!request) throw new Error("no request handler");
      const handler = request;
      return new Promise((resolve) =>
        handler({}, permission, resolve, { requestingUrl, isMainFrame }),
      );
    },
    check(permission: string, origin: string, isMainFrame = true): boolean {
      if (!check) throw new Error("no check handler");
      return check({}, permission, origin, { isMainFrame });
    },
    device(d: unknown): boolean {
      if (!device) throw new Error("no device handler");
      return device(d);
    },
    clearStorageData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
  };
}
