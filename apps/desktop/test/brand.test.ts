import { expect, test } from "vitest";
import { brand } from "../brand.ts";

test("the brand carries the working app id and scheme", () => {
  expect(brand.appId).toBe("com.capybarahq.desktop");
  expect(brand.scheme).toBe("capybara");
});
