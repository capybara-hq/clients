import { describe, expect, test, vi } from "vitest";
import {
  createDeviceDialogs,
  type MessageBoxOptions,
  platformLabel,
} from "../../src/main/device/dialogs.ts";
import type { Profile } from "../../src/main/profiles.ts";

const named: Profile = {
  id: "p1",
  base: "https://a.example.com/team",
  origin: "https://a.example.com",
  name: "Acme 平台",
};
// Discovery without a platform name stores the host as the profile name.
const unnamed: Profile = {
  id: "p2",
  base: "https://b.example.com:8443",
  origin: "https://b.example.com:8443",
  name: "b.example.com:8443",
};

function setup(response = 0, locale: "zh" | "en" = "zh", platform = "darwin") {
  const shown: { parent: unknown; options: MessageBoxOptions }[] = [];
  const showMessageBox = vi.fn(async (parent: unknown, options: MessageBoxOptions) => {
    shown.push({ parent, options });
    return { response };
  });
  return { dialogs: createDeviceDialogs({ showMessageBox, locale, platform }), shown };
}

describe("the platform label", () => {
  test("the discovery name and the host; only the host when there is no name", () => {
    expect(platformLabel(named)).toEqual({ name: "Acme 平台", host: "a.example.com" });
    expect(platformLabel(unnamed)).toEqual({ name: null, host: "b.example.com:8443" });
    expect(platformLabel({ ...named, name: "  " })).toEqual({ name: null, host: "a.example.com" });
    expect(platformLabel({ ...named, name: "a.example.com" })).toEqual({
      name: null,
      host: "a.example.com",
    });
  });
});

describe("the connect dialog", () => {
  test("the exact zh copy with the platform name and the host, buttons 允许 / 取消", async () => {
    const { dialogs, shown } = setup(0);
    const parent = { id: "win" };
    expect(await dialogs.confirmConnect(parent, named)).toBe(true);
    const box = shown[0];
    expect(box?.parent).toBe(parent);
    expect(box?.options.message).toBe("允许 Acme 平台（a.example.com）在这台电脑上运行命令吗？");
    expect(box?.options.buttons).toEqual(["允许", "取消"]);
    // Enter and Escape both answer 取消: allowing always takes a deliberate click.
    expect(box?.options.defaultId).toBe(1);
    expect(box?.options.cancelId).toBe(1);
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
    const { dialogs, shown } = setup(0);
    await dialogs.confirmConnect(null, unnamed);
    expect(shown[0]?.options.message).toBe("允许 b.example.com:8443 在这台电脑上运行命令吗？");
  });

  test("取消 (or Escape, which answers the cancel id) is false", async () => {
    const { dialogs } = setup(1);
    expect(await dialogs.confirmConnect(null, named)).toBe(false);
  });

  test("English copy", async () => {
    const { dialogs, shown } = setup(0, "en");
    await dialogs.confirmConnect(null, named);
    expect(shown[0]?.options.message).toBe(
      "Allow Acme 平台 (a.example.com) to run commands on this computer?",
    );
    expect(shown[0]?.options.buttons).toEqual(["Allow", "Cancel"]);
  });
});

describe("the other confirmations", () => {
  test("every one defaults to and cancels with its second button", async () => {
    const { dialogs, shown } = setup(1);
    expect(await dialogs.confirmDisconnectOther(null, "https://other.example.com")).toBe(false);
    expect(await dialogs.confirmResume(null, named)).toBe(false);
    expect(
      await dialogs.confirmWidenCeiling(
        null,
        { outsideSandbox: true, network: false, projectReach: false },
        ["W."],
      ),
    ).toBe(false);
    expect(await dialogs.confirmRaiseKeepAwake(null, "connected")).toBe(false);
    expect(await dialogs.confirmRemoveDevice(null, named)).toBe(false);
    for (const { options } of shown) {
      expect(options.buttons).toHaveLength(2);
      expect(options.defaultId).toBe(1);
      expect(options.cancelId).toBe(1);
      expect(options.buttons[1]).toMatch(/^(取消|否)$/);
    }
  });

  test("disconnecting another deployment names only its origin", async () => {
    const { dialogs, shown } = setup(0);
    expect(await dialogs.confirmDisconnectOther(null, "https://other.example.com")).toBe(true);
    expect(shown[0]?.options.message).toContain("https://other.example.com");
  });

  test("the widening dialog names each widened item, then the program's own texts", async () => {
    const cases = [
      [{ outsideSandbox: true, network: false, projectReach: false }, "沙箱外运行：允许"],
      [{ outsideSandbox: false, network: true, projectReach: false }, "网络：开放（公共互联网）"],
      [
        { outsideSandbox: false, network: false, projectReach: true },
        "项目范围：整个系统用户（os-user）",
      ],
      [
        { outsideSandbox: true, network: true, projectReach: true },
        "沙箱外运行：允许\n网络：开放（公共互联网）\n项目范围：整个系统用户（os-user）",
      ],
    ] as const;
    for (const [widened, lines] of cases) {
      const { dialogs, shown } = setup(0);
      await dialogs.confirmWidenCeiling(null, widened, ["Widening text.", "Risk text."]);
      expect(shown[0]?.options.type).toBe("warning");
      expect(shown[0]?.options.detail).toBe(`${lines}\n\nWidening text.\n\nRisk text.`);
    }
  });

  test("the widened items in English", async () => {
    const { dialogs, shown } = setup(0, "en");
    await dialogs.confirmWidenCeiling(
      null,
      { outsideSandbox: true, network: true, projectReach: true },
      ["W."],
    );
    expect(shown[0]?.options.detail).toBe(
      "Running outside the sandbox: allowed\nNetwork: open (the public internet)\n" +
        "Project reach: the whole OS user (os-user)\n\nW.",
    );
  });

  test("the keep-awake dialog says what it cannot prevent", async () => {
    const { dialogs, shown } = setup(0);
    await dialogs.confirmRaiseKeepAwake(null, "while-busy");
    await dialogs.confirmRaiseKeepAwake(null, "connected");
    expect(shown[0]?.options.detail).not.toBe(shown[1]?.options.detail);
    for (const { options } of shown) expect(options.detail).toContain("合上");
  });

  test("on Linux the keep-awake limits name the lid switch instead", async () => {
    const { dialogs, shown } = setup(0, "zh", "linux");
    await dialogs.confirmRaiseKeepAwake(null, "connected");
    expect(shown[0]?.options.detail).toContain("盖子开关");
    expect(shown[0]?.options.detail).not.toContain("Mac");
    const en = setup(0, "en", "linux");
    await en.dialogs.confirmRaiseKeepAwake(null, "connected");
    expect(en.shown[0]?.options.detail).toContain("lid switch");
  });

  test("profile removal asks 是 / 否 about the device", async () => {
    const { dialogs, shown } = setup(0);
    expect(await dialogs.confirmRemoveDevice(null, named)).toBe(true);
    expect(shown[0]?.options.buttons).toEqual(["是", "否"]);
    expect(shown[0]?.options.detail).toContain("Acme 平台");
  });
});
