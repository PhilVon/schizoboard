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
    expect(tierAt(0.01, "full")).toBe("flat");
  });

  /**
   * The two constants interact, and this is the test that keeps them honest
   * (T-204, Q-120).
   *
   * The camera's floor was raised to 0.15 so the board never mounts five hundred
   * items at once — and 0.15 was also `FLAT_ZOOM`, with an exclusive comparison,
   * which left the bottom tier reachable in principle and never entered in
   * practice. So the tier moved to 20%, giving it a genuine 15-to-20 band.
   *
   * Written down rather than commented so that neither number can move without
   * somebody being told: if the floor rises to meet the threshold again, the
   * bottom tier silently stops existing.
   */
  it("keeps the bottom tier reachable above the camera's floor", () => {
    expect(FLAT_ZOOM).toBeGreaterThan(MIN_ZOOM);
    // The floor itself is in the bottom tier, which is the point of the band.
    expect(tierAt(MIN_ZOOM, "full")).toBe("flat");
    expect(tierAt(MIN_ZOOM, "card")).toBe("flat");
    // And the band is wide enough that the hysteresis cannot swallow it: leaving
    // `flat` needs 22%, which is inside the range the camera can reach.
    expect(FLAT_ZOOM * (1 + TIER_BAND)).toBeLessThan(CARD_ZOOM);
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
    expect(tierAt(0.01, "full")).toBe("flat");
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

/**
 * T-203. Detail arrives while the camera is moving; it only leaves when the
 * camera stops.
 *
 * Not symmetry, and the asymmetry is the point. A zoom in used to hold flat
 * cards through the whole motion and then pop about a hundred and forty sheets
 * into full detail on the first still frame — the one moment nothing else on
 * screen was moving. Rising is also the cheap direction, because it happens at a
 * zoom where fewer items are mounted.
 */
describe("Lod.rise", () => {
  it("takes detail that has become due while the camera is still moving", () => {
    const lod = new Lod();
    const seen: Tier[] = [];
    lod.settle(0.05);
    lod.on((tier) => seen.push(tier));

    // A zoom in, frame by frame. 22% and 38.5% are the hysteresis edges — the
    // bottom tier is left a band above its 20% threshold, exactly as the top one
    // is above 35%.
    expect(lod.rise(0.1)).toBe(false);
    expect(lod.rise(0.21)).toBe(false);
    expect(lod.rise(0.23)).toBe(true);
    expect(lod.rise(0.3)).toBe(false);
    expect(lod.rise(0.4)).toBe(true);
    expect(seen).toEqual(["card", "full"]);
    expect(lod.tier).toBe("full");
  });

  it("never gives detail up, however far out the gesture goes", () => {
    const lod = new Lod();
    lod.settle(1);
    const listener = vi.fn();
    lod.on(listener);

    // A zoom out, frame by frame, past both boundaries. Written in explicit
    // zooms rather than `MIN_ZOOM`, because this is a statement about the tiers
    // and the camera's floor is somebody else's decision — see the test above.
    for (const zoom of [0.8, 0.5, 0.34, 0.2, 0.1, 0.05]) {
      expect(lod.rise(zoom)).toBe(false);
    }
    expect(lod.tier).toBe("full");
    expect(listener).not.toHaveBeenCalled();

    // And the settle is what finally lets it go — where the frame is already
    // repainting the world for the demote.
    expect(lod.settle(0.05)).toBe(true);
    expect(lod.tier).toBe("flat");
  });

  it("respects the band on the way up, exactly as settle does", () => {
    const lod = new Lod();
    lod.settle(0.3);
    expect(lod.tier).toBe("card");
    // Below the band's far edge the cheaper tier still holds: a camera creeping
    // across 35% must not rebuild the board on alternate frames of one gesture.
    expect(lod.rise(0.36)).toBe(false);
    expect(lod.rise(0.384)).toBe(false);
    expect(lod.rise(0.386)).toBe(true);
    expect(lod.tier).toBe("full");
  });

  it("rises one tier at a time, so a zoom in from the bottom passes through card", () => {
    const lod = new Lod();
    lod.settle(0.05);
    // 36% is above both thresholds, but `card` is what the band allows from
    // `flat` — and `card` is the right answer, because it is genuinely a step up.
    expect(lod.rise(0.36)).toBe(true);
    expect(lod.tier).toBe("card");
    expect(lod.rise(0.5)).toBe(true);
    expect(lod.tier).toBe("full");
  });

  it("says nothing on a gesture that stays inside one tier", () => {
    const lod = new Lod();
    lod.settle(1);
    const listener = vi.fn();
    lod.on(listener);
    for (const zoom of [1.2, 2, 3, MAX_ZOOM]) expect(lod.rise(zoom)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not stand in for the boot announcement", () => {
    const lod = new Lod();
    // `full` is where it starts, so a rise to `full` is not a change — and the
    // one guaranteed pass every layer needs is the settle's, not this.
    expect(lod.rise(1)).toBe(false);
  });
});
