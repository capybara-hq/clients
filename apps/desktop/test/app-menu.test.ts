import { describe, expect, test, vi } from "vitest";
import { type PlatformMenuState, platformMenuTemplate } from "../src/main/app-menu.ts";
import type { MenuItemModel } from "../src/main/tray.ts";

const actions = () => ({
  showProfile: vi.fn(),
  addPlatform: vi.fn(),
  signOut: vi.fn(),
  removeProfile: vi.fn(),
});

const state: PlatformMenuState = {
  locale: "zh",
  profiles: [
    { id: "p1", name: "Example", signedIn: true },
    { id: "p2", name: "Other", signedIn: false },
  ],
  activeId: "p1",
  lockDeployments: false,
};

const labels = (items: MenuItemModel[]) =>
  items.map((i) => (i.type === "separator" ? "-" : i.label));
const byLabel = (items: MenuItemModel[], label: string) => items.find((i) => i.label === label);

describe("the 「平台」 menu (spec 6.9)", () => {
  test("profiles, then 添加平台…, 退出登录 <current>…, 移除这个平台…", () => {
    expect(labels(platformMenuTemplate(state, actions()))).toEqual([
      "Example",
      "Other",
      "-",
      "添加平台…",
      "退出登录 Example…",
      "移除这个平台…",
    ]);
    expect(labels(platformMenuTemplate({ ...state, locale: "en" }, actions()))).toEqual([
      "Example",
      "Other",
      "-",
      "Add Platform…",
      "Sign Out of Example…",
      "Remove This Platform…",
    ]);
  });

  test("radio items, the current one checked, ⌘1…⌘9 for the first nine", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      signedIn: true,
    }));
    const items = platformMenuTemplate({ ...state, profiles: many, activeId: "p3" }, actions());
    const radios = items.filter((i) => i.type === "radio");
    expect(radios).toHaveLength(11);
    expect(radios.map((i) => i.accelerator)).toEqual([
      "CmdOrCtrl+1",
      "CmdOrCtrl+2",
      "CmdOrCtrl+3",
      "CmdOrCtrl+4",
      "CmdOrCtrl+5",
      "CmdOrCtrl+6",
      "CmdOrCtrl+7",
      "CmdOrCtrl+8",
      "CmdOrCtrl+9",
      undefined,
      undefined,
    ]);
    expect(radios.map((i) => i.checked)).toEqual(radios.map((_, i) => i === 3));
  });

  test("a profile item shows that profile; the others act on the current one", () => {
    const a = actions();
    const items = platformMenuTemplate(state, a);
    items[1]?.click?.({ checked: true });
    expect(a.showProfile).toHaveBeenCalledExactlyOnceWith("p2");
    byLabel(items, "添加平台…")?.click?.({ checked: false });
    expect(a.addPlatform).toHaveBeenCalledTimes(1);
    byLabel(items, "退出登录 Example…")?.click?.({ checked: false });
    expect(a.signOut).toHaveBeenCalledExactlyOnceWith("p1");
    byLabel(items, "移除这个平台…")?.click?.({ checked: false });
    expect(a.removeProfile).toHaveBeenCalledExactlyOnceWith("p1");
  });

  test("退出登录 is enabled only while the current profile is signed in", () => {
    const a = actions();
    const items = platformMenuTemplate({ ...state, activeId: "p2" }, a);
    const signOut = byLabel(items, "退出登录 Other…");
    expect(signOut?.enabled).toBe(false);
    signOut?.click?.({ checked: false });
    expect(a.signOut).not.toHaveBeenCalled();
    expect(byLabel(platformMenuTemplate(state, a), "退出登录 Example…")?.enabled).toBe(true);
  });

  test("without a current profile: 退出登录 and 移除 are disabled", () => {
    const items = platformMenuTemplate({ ...state, activeId: undefined }, actions());
    expect(labels(items)).toEqual([
      "Example",
      "Other",
      "-",
      "添加平台…",
      "退出登录…",
      "移除这个平台…",
    ]);
    expect(items.slice(-2).map((i) => i.enabled)).toEqual([false, false]);
    expect(
      labels(platformMenuTemplate({ ...state, locale: "en", activeId: undefined }, actions())),
    ).toContain("Sign Out…");
  });

  test("under lockDeployments neither adding nor removing is offered", () => {
    expect(labels(platformMenuTemplate({ ...state, lockDeployments: true }, actions()))).toEqual([
      "Example",
      "Other",
      "-",
      "退出登录 Example…",
    ]);
  });

  test("without profiles the menu starts at the entries that remain", () => {
    expect(
      labels(platformMenuTemplate({ ...state, profiles: [], activeId: undefined }, actions())),
    ).toEqual(["添加平台…", "退出登录…", "移除这个平台…"]);
  });
});
