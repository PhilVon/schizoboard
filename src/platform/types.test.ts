import { describe, expect, it } from "vitest";

import { VARIANT_MAX_EDGE, variantFor } from "@/platform/types";

describe("variantFor", () => {
  it("takes the thumbnail only while the thumbnail has enough pixels", () => {
    expect(variantFor(1)).toBe("thumb");
    expect(variantFor(120)).toBe("thumb");
    // Exactly the thumbnail's longest edge is still enough; one more is not.
    expect(variantFor(VARIANT_MAX_EDGE.thumb)).toBe("thumb");
    expect(variantFor(VARIANT_MAX_EDGE.thumb + 1)).toBe("display");
  });

  it("takes the display variant for anything larger, and never the original", () => {
    // `display` is capped at the 400% ceiling on a 2x display, so nothing on
    // screen can out-resolve it and `original` is never the right answer here —
    // it exists for export, where the point is that it was not touched.
    for (const px of [300, VARIANT_MAX_EDGE.display, VARIANT_MAX_EDGE.display * 100]) {
      expect(variantFor(px)).toBe("display");
    }
  });

  it("falls through to display for a size that means nothing", () => {
    // `screenPx` is a Float32 scene value times a zoom, so NaN is reachable, and
    // this caught -1 quietly selecting a thumbnail on the first run. Nothing
    // produces a negative size today; the point is that the rule is "a positive
    // finite size *establishes* that a thumbnail is enough", not "anything that
    // compares small".
    for (const px of [Number.NaN, -1, 0, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(variantFor(px), `${px}`).toBe("display");
    }
  });
});
