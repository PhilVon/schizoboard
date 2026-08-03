import { describe, expect, it } from "vitest";

import { fileSize } from "@/lib/filesize";

describe("what a file weighs, as somebody about to send it reads it", () => {
  it("says gigabytes once there are gigabytes to say", () => {
    // The case T-291 exists for: a board with three interviews on it. "6100 MB"
    // is a number somebody has to convert at the exact moment they are deciding
    // whether to send the thing.
    expect(fileSize(6.1 * 1024 * 1024 * 1024)).toBe("6.1 GB");
    expect(fileSize(1024 * 1048576)).toBe("1.0 GB");
  });

  it("stays in megabytes below a gigabyte, where a decimal would be noise", () => {
    expect(fileSize(40 * 1048576)).toBe("40 MB");
    expect(fileSize(1023 * 1048576)).toBe("1023 MB");
  });

  it("never says a written file weighed nothing", () => {
    // A board of notes and no photographs really is a few kilobytes, and "0 MB"
    // reads as an export that did not happen.
    expect(fileSize(12_000)).toBe("1 MB");
    expect(fileSize(0)).toBe("1 MB");
  });

  it("says so rather than printing arithmetic that went wrong", () => {
    // `bundleWeigh` adds two numbers from two sides of the IPC boundary, and a
    // NaN reaching a sentence is how "NaN MB" gets on screen.
    expect(fileSize(Number.NaN)).toBe("an unknown size");
    expect(fileSize(-1)).toBe("an unknown size");
  });
});
