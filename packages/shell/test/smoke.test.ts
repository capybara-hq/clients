import { expect, test } from "vitest";
import { shellPackage } from "../src/index.ts";

test("the package entry loads", () => {
  expect(shellPackage).toBe("@capybara-hq/shell");
});
