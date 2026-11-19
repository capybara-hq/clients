import { describe, expect, test, vi } from "vitest";
import type { DeviceCliOptions } from "../../src/main/device/cli.ts";
import { createConnect, verificationUrl } from "../../src/main/device/connect.ts";
import {
  carriesSecret,
  ctxFor,
  fakeCli,
  fakeDialogs,
  fakeService,
  fakeVerification,
  loggedIn,
  profileA,
} from "./fake-device.ts";

/** A login the test drives: `verification`, then `done` or an error, then the exit. */
function scriptedLogin() {
  let opts: DeviceCliOptions | undefined;
  let finish: ((r: { code: number }) => void) | undefined;
  let started: () => void = () => {};
  const startedP = new Promise<void>((r) => {
    started = r;
  });
  const handler = (_args: string[], o: DeviceCliOptions | undefined) => {
    opts = o;
    started();
    return new Promise<{ code: number }>((resolve) => {
      finish = resolve;
      o?.signal?.addEventListener("abort", () => resolve({ code: 143 }));
    });
  };
  return {
    handler,
    started: startedP,
    emit: (line: unknown) => opts?.onLine?.(line),
    exit: (code: number) => finish?.({ code }),
    get opts() {
      return opts;
    },
  };
}

const LOGIN = "login --json --url https://a.example.com/team";
const VERIFY = "https://a.example.com/team/devices/link?code=ABCD-EFGH";

function setup(
  o: { status?: Record<string, unknown>; answer?: Parameters<typeof fakeDialogs>[0] } = {},
) {
  const login = scriptedLogin();
  const cli = fakeCli(
    { ...(o.status && { status: o.status }), service: { installed: true, loaded: true } },
    { [LOGIN]: login.handler },
  );
  const dialogs = fakeDialogs(o.answer ?? true);
  const service = fakeService();
  const verification = fakeVerification();
  const connect = createConnect({
    cli: cli.cli,
    service,
    dialogs: dialogs.dialogs,
    openVerification: verification.open,
  });
  return { connect, login, cli, dialogs, service, verification };
}

describe("the verification URL", () => {
  test("appends org= with the URL API, keeping the code", () => {
    expect(verificationUrl(VERIFY, profileA, "org_1")).toBe(
      "https://a.example.com/team/devices/link?code=ABCD-EFGH&org=org_1",
    );
    // An org= the program printed is replaced, not doubled.
    expect(verificationUrl(`${VERIFY}&org=other`, profileA, "org_1")?.match(/org=/g)?.length).toBe(
      1,
    );
  });

  test("refuses a URL on any other origin", () => {
    for (const url of [
      "https://evil.example.com/devices/link?code=X",
      "http://a.example.com/team/devices/link?code=X",
      "https://a.example.com:8443/devices/link?code=X",
      "https://a.example.com.evil.com/devices/link?code=X",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(verificationUrl(url, profileA, "org_1")).toBeNull();
    }
  });
});

describe("connect", () => {
  test("取消: cancelled, and login never runs", async () => {
    const s = setup({ answer: false });
    const ctx = ctxFor();
    expect(await s.connect(ctx, { orgId: "org_1" })).toBe("cancelled");
    expect(s.dialogs.asked[0]).toEqual({ name: "confirmConnect", args: [ctx.window, profileA] });
    expect(s.cli.writes()).toEqual([]);
    expect(s.verification.open).not.toHaveBeenCalled();
  });

  test("允许: login, the child window with org=, done closes it, service, connected", async () => {
    const s = setup();
    const ctx = ctxFor();
    const result = s.connect(ctx, { orgId: "org_1" });
    await s.login.started;
    expect(s.cli.writes()).toEqual([LOGIN]);
    // A person reads and confirms: no 60 s default may end it.
    expect(s.login.opts?.timeoutMs).toBe(0);
    s.login.emit({ event: "verification", url: VERIFY, userCode: "ABCD-EFGH", expiresIn: 600 });
    expect(s.verification.opened).toEqual([
      {
        url: "https://a.example.com/team/devices/link?code=ABCD-EFGH&org=org_1",
        parent: ctx.window,
      },
    ]);
    s.login.emit({ event: "done", deviceId: "dev_9", orgId: "org_1", dir: "/x" });
    expect(s.verification.close).toHaveBeenCalled();
    s.login.exit(0);
    expect(await result).toBe("connected");
    expect(s.service.ensureService).toHaveBeenCalledOnce();
    expect(s.cli.writes()).toEqual([LOGIN, "service start"]);
  });

  test("closing the verification window ends the login: cancelled, no service", async () => {
    const s = setup();
    const result = s.connect(ctxFor(), { orgId: "org_1" });
    await s.login.started;
    s.login.emit({ event: "verification", url: VERIFY, userCode: "X", expiresIn: 600 });
    s.verification.userCloses();
    expect(s.login.opts?.signal?.aborted).toBe(true);
    expect(await result).toBe("cancelled");
    expect(s.service.ensureService).not.toHaveBeenCalled();
    expect(s.cli.writes()).toEqual([LOGIN]);
  });

  test("a verification URL on another origin is never opened and fails the connect", async () => {
    const s = setup();
    const result = s.connect(ctxFor(), { orgId: "org_1" });
    await s.login.started;
    s.login.emit({ event: "verification", url: "https://evil.example.com/x?code=1" });
    expect(s.login.opts?.signal?.aborted).toBe(true);
    await expect(result).rejects.toMatchObject({ code: "failed" });
    expect(s.verification.open).not.toHaveBeenCalled();
  });

  test("denied in the browser is cancelled; another error fails", async () => {
    const denied = setup();
    const r1 = denied.connect(ctxFor(), { orgId: "org_1" });
    await denied.login.started;
    denied.login.emit({ event: "verification", url: VERIFY });
    denied.login.emit({ event: "error", code: "device_sign_in.denied", message: "denied" });
    denied.login.exit(1);
    expect(await r1).toBe("cancelled");
    expect(denied.verification.close).toHaveBeenCalled();

    const expired = setup();
    const r2 = expired.connect(ctxFor(), { orgId: "org_1" });
    await expired.login.started;
    expired.login.emit({ event: "error", code: "device_sign_in.expired", message: "expired" });
    expired.login.exit(1);
    await expect(r2).rejects.toMatchObject({ code: "failed" });
    expect(expired.service.ensureService).not.toHaveBeenCalled();
  });

  test("a failed service start fails the connect", async () => {
    const login = scriptedLogin();
    const cli = fakeCli({}, { [LOGIN]: login.handler, "service start": () => ({ code: 1 }) });
    const connect = createConnect({
      cli: cli.cli,
      service: fakeService(),
      dialogs: fakeDialogs(true).dialogs,
      openVerification: fakeVerification().open,
    });
    const result = connect(ctxFor(), { orgId: "org_1" });
    await login.started;
    login.emit({ event: "done", deviceId: "d", orgId: "org_1", dir: "/x" });
    login.exit(0);
    await expect(result).rejects.toMatchObject({ code: "failed" });
  });

  test("already connected to this deployment: connected, no dialog, no login", async () => {
    const s = setup({ status: loggedIn() });
    expect(await s.connect(ctxFor(), { orgId: "org_1" })).toBe("connected");
    expect(s.dialogs.asked).toEqual([]);
    expect(s.cli.writes()).toEqual([]);
  });

  test("logged in elsewhere: asks to disconnect it first (service stop, logout), then logs in", async () => {
    const s = setup({ status: loggedIn({ url: "https://other.example.com" }) });
    const ctx = ctxFor();
    const result = s.connect(ctx, { orgId: "org_1" });
    await s.login.started;
    expect(s.dialogs.names()).toEqual(["confirmConnect", "confirmDisconnectOther"]);
    expect(s.dialogs.asked[1]?.args).toEqual([ctx.window, "https://other.example.com"]);
    expect(s.cli.writes()).toEqual(["service stop", "logout", LOGIN]);
    s.login.emit({ event: "done", deviceId: "d", orgId: "org_1", dir: "/x" });
    s.login.exit(0);
    expect(await result).toBe("connected");
  });

  test("refusing to disconnect the other deployment stops: cancelled, nothing changed", async () => {
    const s = setup({
      status: loggedIn({ url: "https://other.example.com" }),
      answer: (name) => name !== "confirmDisconnectOther",
    });
    expect(await s.connect(ctxFor(), { orgId: "org_1" })).toBe("cancelled");
    expect(s.cli.writes()).toEqual([]);
  });

  test("a terminal runner of the other deployment is ended by logout alone", async () => {
    const login = scriptedLogin();
    const cli = fakeCli(
      { status: loggedIn({ url: "https://other.example.com" }), service: { installed: false } },
      { [LOGIN]: login.handler },
    );
    const connect = createConnect({
      cli: cli.cli,
      service: fakeService(),
      dialogs: fakeDialogs(true).dialogs,
      openVerification: fakeVerification().open,
    });
    const result = connect(ctxFor(), { orgId: "org_1" });
    await login.started;
    expect(cli.writes()).toEqual(["logout", LOGIN]);
    login.emit({ event: "done", deviceId: "d", orgId: "org_1", dir: "/x" });
    login.exit(0);
    await result;
  });

  test("ids are checked before anything runs", async () => {
    const s = setup();
    for (const input of [
      undefined,
      null,
      "org_1",
      {},
      { orgId: "" },
      { orgId: 7 },
      { orgId: "org 1" },
      { orgId: "org_1&x=1" },
      { orgId: "a".repeat(200) },
      { orgId: "org_1", deviceId: "../x" },
      { orgId: "org_1", deviceId: 3 },
    ]) {
      await expect(s.connect(ctxFor(), input)).rejects.toMatchObject({ code: "failed" });
    }
    expect(s.dialogs.asked).toEqual([]);
    expect(s.cli.calls).toEqual([]);
  });

  test("no result carries the credential", async () => {
    const s = setup({ status: loggedIn() });
    const r = await s.connect(ctxFor(), { orgId: "org_1" });
    expect(carriesSecret(r)).toBe(false);
  });

  test("the login's lines are never logged", async () => {
    const log = vi.fn();
    const login = scriptedLogin();
    const cli = fakeCli({}, { [LOGIN]: login.handler });
    const connect = createConnect({
      cli: cli.cli,
      service: fakeService(),
      dialogs: fakeDialogs(true).dialogs,
      openVerification: fakeVerification().open,
      log,
    });
    const result = connect(ctxFor(), { orgId: "org_1" });
    await login.started;
    login.emit({ event: "verification", url: "https://evil.example.com/?code=SECRETCODE" });
    await expect(result).rejects.toMatchObject({ code: "failed" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRETCODE");
  });
});
