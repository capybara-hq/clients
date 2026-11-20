import { describe, expect, test, vi } from "vitest";
import { createLocalFrames } from "../../src/runtime/local-frames.ts";

function fakeDom() {
  const made: { src: string; win: object; removed: boolean; posted: unknown[] }[] = [];
  return {
    made,
    create: vi.fn((src: string) => {
      const frame = { src, win: {}, removed: false, posted: [] as unknown[] };
      made.push(frame);
      return {
        window: frame.win,
        post: (m: unknown) => frame.posted.push(m),
        remove: () => {
          frame.removed = true;
        },
      };
    }),
  };
}

describe("local pages framed over the runtime document (I4)", () => {
  test("one page at a time: showing the address page replaces the error page", () => {
    const dom = fakeDom();
    const frames = createLocalFrames({ create: dom.create });
    frames.show("error", "error/index.html");
    frames.show("address", "address/index.html");
    expect(dom.made.map((f) => [f.src, f.removed])).toEqual([
      ["error/index.html", true],
      ["address/index.html", false],
    ]);
    expect(frames.current()).toBe("address");
  });

  test("messages are attributed only to the frame shown now", () => {
    const dom = fakeDom();
    const frames = createLocalFrames({ create: dom.create });
    frames.show("error", "error/index.html");
    const errorWin = dom.made[0]?.win;
    frames.show("address", "address/index.html");
    expect(frames.sourceOf(errorWin)).toBeNull();
    expect(frames.sourceOf(dom.made[1]?.win)).toBe("address");
    expect(frames.sourceOf({})).toBeNull();
  });

  test("showing the same page again keeps its frame and posts to it", () => {
    const dom = fakeDom();
    const frames = createLocalFrames({ create: dom.create });
    frames.show("error", "error/index.html");
    frames.show("error", "error/index.html");
    frames.post({ hi: 1 });
    expect(dom.create).toHaveBeenCalledTimes(1);
    expect(dom.made[0]?.posted).toEqual([{ hi: 1 }]);
  });

  test("hide removes the frame; there is no way to navigate the runtime document", () => {
    const dom = fakeDom();
    const frames = createLocalFrames({ create: dom.create });
    frames.show("address", "address/index.html");
    frames.hide();
    expect(dom.made[0]?.removed).toBe(true);
    expect(frames.current()).toBeNull();
    expect(Object.keys(frames).sort()).toEqual(["current", "hide", "post", "show", "sourceOf"]);
  });
});
