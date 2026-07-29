import { describe, expect, it, vi } from "vitest";

import { CARD_ZOOM, FLAT_ZOOM, Lod, TIER_BAND, tierAt, type Tier } from "@/render/lod";
import { MAX_ZOOM, MIN_ZOOM } from "@/state/camera";

/** Where a tier is left, going back up. */
function leaving(threshold: number): number {
  return threshold * (1 + TIER_BAND);
}

describe("tierAt", () => {
  it("draws everything at the zooms a board is worked at", () => {
    for (const zoom of [1, 0.5, 0.4, MAX_ZOOM]) {
      expect(tierAt(zoom, "full")).toBe("full");
    }
  });

  it("simplifies below 35% and flattens below 15% — DESIGN section 6.6", () => {
    expect(tierAt(CARD_ZOOM - 0.001, "full")).toBe("card");
    expect(tierAt(FLAT_ZOOM - 0.001, "full")).toBe("flat");
    expect(tierAt(MIN_ZOOM, "full")).toBe("flat");
  });

  it("is exclusive at the threshold: 35% itself is still the full item", () => {
    expect(tierAt(CARD_ZOOM, "full")).toBe("full");
    expect(tierAt(FLAT_ZOOM, "card")).toBe("card");
  });

  /**
   * The band is the whole reason this is a function of two arguments. A camera
   * resting on the boundary must not rebuild every item on alternate gestures.
   */
  it("holds the cheaper tier until the zoom is a band above the threshold", () => {
    expect(tierAt(CARD_ZOOM + 0.001, "card")).toBe("card");
    expect(tierAt(leaving(CARD_ZOOM) - 0.001, "card")).toBe("card");
    expect(tierAt(leaving(CARD_ZOOM) + 0.001, "card")).toBe("full");
  });

  it("bands the flat boundary too, and lands in card rather than in full", () => {
    expect(tierAt(FLAT_ZOOM + 0.001, "flat")).toBe("flat");
    expect(tierAt(leaving(FLAT_ZOOM) + 0.001, "flat")).toBe("card");
  });

  /**
   * A zoom well clear of the boundary means what it says however it was
   * reached — the band delays a switch, it must never prevent one.
   */
  it("does not let the band strand a tier", () => {
    expect(tierAt(1, "flat")).toBe("full");
    expect(tierAt(MIN_ZOOM, "full")).toBe("flat");
    expect(tierAt(0.25, "flat")).toBe("card");
  });

  /**
   * Every comparison against NaN is false, so the fall-through is `full`. That
   * is the safe direction and it is worth a test rather than a comment: a
   * camera that has gone wrong (T-155, T-194) should draw the whole board, not
   * silently flatten it while nothing throws.
   */
  it("draws the full board for a camera that has gone NaN", () => {
    expect(tierAt(Number.NaN, "full")).toBe("full");
    expect(tierAt(Number.NaN, "flat")).toBe("full");
  });
});

describe("Lod", () => {
  it("tells its listeners once at boot, even though the tier has not moved", () => {
    const lod = new Lod();
    const seen: Tier[] = [];
    lod.on((tier) => seen.push(tier));

    expect(lod.settle(1)).toBe(true);
    expect(seen).toEqual(["full"]);
  });

  it("says nothing on a settle that did not change the tier", () => {
    const lod = new Lod();
    lod.settle(1);
    const listener = vi.fn();
    lod.on(listener);

    expect(lod.settle(0.9)).toBe(false);
    expect(lod.settle(0.4)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("announces each crossing exactly once", () => {
    const lod = new Lod();
    const seen: Tier[] = [];
    lod.on((tier) => seen.push(tier));

    lod.settle(1);
    lod.settle(0.3);
    lod.settle(0.2);
    lod.settle(0.1);
    lod.settle(0.05);
    expect(seen).toEqual(["full", "card", "flat"]);
    expect(lod.tier).toBe("flat");
    expect(lod.detailed).toBe(false);
  });

  /**
   * A board opened zoomed out. `Lod` starts at `full` rather than at the
   * opening camera's tier precisely so that this first settle is a real
   * transition and the layers are told — otherwise every layer would sit at its
   * constructed default having never heard anything.
   */
  it("tells the layers about a board that opens below the boundary", () => {
    const lod = new Lod();
    const seen: Tier[] = [];
    lod.on((tier) => seen.push(tier));

    expect(lod.settle(0.08)).toBe(true);
    expect(seen).toEqual(["flat"]);
  });

  it("does not thrash across a camera wobbling on the boundary", () => {
    const lod = new Lod();
    lod.settle(1);
    const listener = vi.fn();
    lod.on(listener);

    lod.settle(CARD_ZOOM - 0.005);
    for (const zoom of [0.352, 0.348, 0.36, 0.345, 0.37]) lod.settle(zoom);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("card");
  });

  it("stops telling an unsubscribed listener", () => {
    const lod = new Lod();
    const listener = vi.fn();
    const off = lod.on(listener);
    lod.settle(1);
    off();
    lod.settle(0.1);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
