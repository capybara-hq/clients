import { describe, expect, test, vi } from "vitest";
import { createDeviceDialogs, platformLabel } from "../../src/main/device/dialogs.ts";
import type { Profile } from "../../src/main/profiles.ts";
import type { ShellDialogOptions } from "../../src/main/shell-dialog.ts";

const named: Profile = {
  id: "p1",
  signedIn: true,
  base: "https://a.example.com/team",
  origin: "https://a.example.com",
  name: "Acme 平台",
};
// Discovery without a platform name stores the host as the profile name.
const unnamed: Profile = {
  id: "p2",
  signedIn: true,
  base: "https://b.example.com:8443",
  origin: "https://b.example.com:8443",
  name: "b.example.com:8443",
};

const ICON = "data:image/png;base64,iVBORw0KGgo=";

// `allow` answers the confirming (last) button, else the cancel button.
function setup(allow = true, locale: "zh" | "en" = "zh", platform = "darwin") {
  const shown: { parent: unknown; options: ShellDialogOptions }[] = [];
  const showDialog = vi.fn(async (parent: unknown, options: ShellDialogOptions) => {
    shown.push({ parent, options });
    return { response: allow ? (options.confirmId ?? -1) : options.cancelId };
  });
  const iconFor = (p: Profile) => (p.id === "p1" ? ICON : undefined);
  return { dialogs: createDeviceDialogs({ showDialog, locale, platform, iconFor }), shown };
}

describe("the platform label", () => {
  test("the discovery name and the host; only the host when there is no name", () => {
    expect(platformLabel(named)).toEqual({ name: "Acme 平台", host: "a.example.com" });
    expect(platformLabel(unnamed)).toEqual({ name: null, host: "b.example.com:8443" });
    expect(platformLabel({ ...named, name: "  " })).toEqual({ name: null, host: "a.example.com" });
    // Control and bidi characters never reach a confirmation.
    expect(platformLabel({ ...named, name: "Ac\u202Eme" }).name).toBe("Acme");
    expect(platformLabel({ ...named, name: "a.example.com" })).toEqual({
      name: null,
      host: "a.example.com",
    });
  });
});

describe("the connect dialog", () => {
  test("the exact zh copy with the platform name and the host, buttons 允许 / 取消", async () => {
    const { dialogs, shown } = setup(true);
    const parent = { id: "win" };
    expect(await dialogs.confirmConnect(parent, named)).toBe(true);
    const box = shown[0];
    expect(box?.parent).toBe(parent);
    expect(box?.options.title).toBe("允许 Acme 平台（a.example.com）在这台电脑上运行命令吗？");
    // Cancel first, the confirming button last; the focus starts on 取消, Escape answers it.
    expect(box?.options.buttons).toEqual(["取消", "允许"]);
    expect(box?.options.defaultId).toBe(0);
    expect(box?.options.cancelId).toBe(0);
    expect(box?.options.confirmId).toBe(1);
    expect(box?.options.tone).toBe("primary");
    expect(box?.options.platform).toEqual({
      name: "Acme 平台",
      host: "a.example.com",
      iconUrl: ICON,
    });
    expect(box?.options.detail).toContain("本地设备");
    // the starting state as the device program sets it up: in the sandbox, the open network
    expect(box?.options.detail).toContain("沙箱内运行");
    expect(box?.options.detail).toContain("公共互联网");
    expect(box?.options.detail).not.toContain("完全访问");
    expect(box?.options.detail).toContain("登录服务");
    expect(box?.options.detail).toContain("唤醒");
    expect(box?.options.detail).not.toMatch(/企业|agent/i);
  });

  test("only the host when the platform has no name", async () => {
    const { dialogs, shown } = setup(true);
    await dialogs.confirmConnect(null, unnamed);
    expect(shown[0]?.options.title).toBe("允许 b.example.com:8443 在这台电脑上运行命令吗？");
    // No cached icon: the page shows the default icon.
    expect(shown[0]?.options.platform).toEqual({
      name: "b.example.com:8443",
      host: "b.example.com:8443",
    });
  });

  test("取消 (or Escape, which answers the cancel id) is false", async () => {
    const { dialogs } = setup(false);
    expect(await dialogs.confirmConnect(null, named)).toBe(false);
  });

  test("English copy", async () => {
    const { dialogs, shown } = setup(true, "en");
    await dialogs.confirmConnect(null, named);
    expect(shown[0]?.options.title).toBe(
      "Allow Acme 平台 (a.example.com) to run commands on this computer?",
    );
    expect(shown[0]?.options.buttons).toEqual(["Cancel", "Allow"]);
  });
});

describe("the other confirmations", () => {
  test("every one defaults to and cancels with its first button, confirms with its last", async () => {
    const { dialogs, shown } = setup(false);
    expect(await dialogs.confirmResume(null, named)).toBe(false);
    expect(
      await dialogs.confirmWidenCeiling(
        null,
        { outsideSandbox: true, network: false, projectReach: false },
        ["W."],
      ),
    ).toBe(false);
    expect(await dialogs.confirmRaiseKeepAwake(null, "connected")).toBe(false);
    expect(await dialogs.confirmRemoveDevice(null, named, 1)).toBe(false);
    for (const { options } of shown) {
      expect(options.buttons).toHaveLength(2);
      expect(options.defaultId).toBe(0);
      expect(options.cancelId).toBe(0);
      expect(options.confirmId).toBe(1);
      expect(options.buttons[0]).toMatch(/^(取消|否)$/);
    }
  });

  test("the widening dialog names each widened item, then the program's own texts", async () => {
    const cases = [
      [{ outsideSandbox: true, network: false, projectReach: false }, "沙箱外运行：允许"],
      [{ outsideSandbox: false, network: true, projectReach: false }, "网络：开放（公共互联网）"],
      [
        { outsideSandbox: false, network: false, projectReach: "paths" },
        "项目范围：列出的项目路径（paths）",
      ],
      [
        { outsideSandbox: false, network: false, projectReach: "machine" },
        "项目范围：整台机器，密钥和其他连接除外（machine）",
      ],
      [
        { outsideSandbox: true, network: true, projectReach: "machine" },
        "沙箱外运行：允许\n网络：开放（公共互联网）\n项目范围：整台机器，密钥和其他连接除外（machine）",
      ],
    ] as const;
    for (const [widened, lines] of cases) {
      const { dialogs, shown } = setup(true);
      await dialogs.confirmWidenCeiling(null, widened, ["Widening text.", "Risk text."], named);
      expect(shown[0]?.options.platform?.name).toBe("Acme 平台");
      expect(shown[0]?.options.detail).toBe(`${lines}\n\nWidening text.\n\nRisk text.`);
    }
  });

  test("the widened items in English", async () => {
    const { dialogs, shown } = setup(true, "en");
    await dialogs.confirmWidenCeiling(
      null,
      { outsideSandbox: true, network: true, projectReach: "paths" },
      ["W."],
    );
    expect(shown[0]?.options.detail).toBe(
      "Running outside the sandbox: allowed\nNetwork: open (the public internet)\n" +
        "Project reach: the listed project paths (paths)\n\nW.",
    );
  });

  test("the keep-awake dialog says what it cannot prevent", async () => {
    const { dialogs, shown } = setup(true);
    await dialogs.confirmRaiseKeepAwake(null, "while-busy");
    await dialogs.confirmRaiseKeepAwake(null, "connected");
    expect(shown[0]?.options.detail).not.toBe(shown[1]?.options.detail);
    for (const { options } of shown) expect(options.detail).toContain("合上");
  });

  test("on Linux the keep-awake limits name the lid switch instead", async () => {
    const { dialogs, shown } = setup(true, "zh", "linux");
    await dialogs.confirmRaiseKeepAwake(null, "connected");
    expect(shown[0]?.options.detail).toContain("盖子开关");
    expect(shown[0]?.options.detail).not.toContain("Mac");
    const en = setup(true, "en", "linux");
    await en.dialogs.confirmRaiseKeepAwake(null, "connected");
    expect(en.shown[0]?.options.detail).toContain("lid switch");
  });

  test("profile removal asks 是 / 否 about the platform's devices, naming how many", async () => {
    const { dialogs, shown } = setup(true);
    expect(await dialogs.confirmRemoveDevice(null, named, 2)).toBe(true);
    expect(shown[0]?.options.buttons).toEqual(["否", "是"]);
    expect(shown[0]?.options.tone).toBe("danger");
    expect(shown[0]?.options.title).toBe("同时断开本机在这个平台上的 2 个设备并退出登录？");
    expect(shown[0]?.options.detail).toContain("Acme 平台");
    const en = setup(true, "en");
    await en.dialogs.confirmRemoveDevice(null, named, 3);
    expect(en.shown[0]?.options.title).toBe(
      "Also disconnect this computer's 3 devices on this platform and log them out?",
    );
    // One connection: no "1 devices".
    const one = setup(true, "en");
    await one.dialogs.confirmRemoveDevice(null, named, 1);
    expect(one.shown[0]?.options.title).toBe(
      "Also disconnect this computer's device on this platform and log it out?",
    );
    expect(one.shown[0]?.options.detail).toContain("as a local device");
    expect(en.shown[0]?.options.detail).toContain("as local devices");
    const zhOne = setup(true);
    await zhOne.dialogs.confirmRemoveDevice(null, named, 1);
    expect(zhOne.shown[0]?.options.title).toBe("同时断开本机在这个平台上的设备并退出登录？");
  });
});

describe("the dialogs' language (spec 12)", () => {
  test("each dialog in the language of the profile it is about; none: the app's", async () => {
    const shown: ShellDialogOptions[] = [];
    const dialogs = createDeviceDialogs({
      showDialog: async (_parent, options) => {
        shown.push(options);
        return { response: options.cancelId };
      },
      // The app (and every other profile) speaks zh; this profile speaks en.
      locale: (profileId) => (profileId === named.id ? "en" : "zh"),
      platform: "darwin",
    });
    await dialogs.confirmConnect(null, named);
    await dialogs.confirmRemoveDevice(null, named, 1);
    await dialogs.confirmRaiseKeepAwake(null, "connected");
    expect(shown[0]?.buttons).toEqual(["Cancel", "Allow"]);
    expect(shown[0]?.profileId).toBe(named.id);
    expect(shown[1]?.title).not.toMatch(/[一-鿿]/);
    expect(shown[2]?.buttons[0]).toBe("取消");
  });
});
