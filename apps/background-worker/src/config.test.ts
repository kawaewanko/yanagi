import { describe, expect, it } from "vitest";
import { intervalMilliseconds } from "./config.js";

describe("intervalMilliseconds", () => {
  it("defaults to one day", () => {
    expect(intervalMilliseconds()).toBe(86_400_000);
  });

  it("accepts intervals between one minute and seven days", () => {
    expect(intervalMilliseconds("60000")).toBe(60_000);
    expect(intervalMilliseconds("604800000")).toBe(604_800_000);
  });

  it.each(["not-a-number", "", "59999", "604800001", "1.5"])(
    "rejects invalid interval %s",
    (value) => {
      expect(() => intervalMilliseconds(value)).toThrow(RangeError);
    },
  );
});
