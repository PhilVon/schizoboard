import { describe, expect, it, vi } from "vitest";

import { CARD_ZOOM, Lod, READING_ZOOM, TIER_BAND, tierAt, type Tier } from "@/render/lod";
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



  it("simplifies below 35% — DESIGN section 6.6", () => {
    expect(tierAt(CARD_ZOOM - 0.001, "full")).toBe("card");
    expect(tierAt(MIN_ZOOM, "full")).toBe("card");
    expect(tierAt(0.01, "full")).toBe("card");
  });

  it("is exclusive at the threshold: 35% itself is still the full item", () => {
    expect(tierAt(CARD_ZOOM, "full")).toBe("full");
  });

  /**
   * There is one tier boundary and there used to be two (Q-121). Everything the
   * bottom one promised is either already true, measured at zero, or refused on
   * the principle DESIGN 6.6 now states: detail varies with zoom, structure does
   * not. So `card` is as far down as this goes, at any zoom the camera can reach.
   */
  it("has nothing below card, however far out the camera goes", () => {
    expect(tierAt(MIN_ZOOM, "card")).toBe("card");
    expect(tierAt(0.001, "card")).toBe("card");
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


  /**
   * A zoom well clear of the boundary means what it says however it was
   * reached — the band delays a switch, it must never prevent one.
   */
  it("does not let the band strand a tier", () => {
    expect(tierAt(1, "card")).toBe("full");
    expect(tierAt(0.25, "card")).toBe("card");
  });

  /**
   * Every comparison against NaN is false, so the fall-through is `full`. That
   * is the safe direction and it is worth a test rather than a comment: a
   * camera that has gone wrong (T-155, T-194) should draw the whole board, not
   * silently flatten it while nothing throws.
   */
  it("draws the full board for a camera that has gone NaN", () => {
    expect(tierAt(Number.NaN, "full")).toBe("full");
    expect(tierAt(Number.NaN, "card")).toBe("full");
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
    lod.settle(MIN_ZOOM);
    // One crossing, because there is one boundary.
    expect(seen).toEqual(["full", "card"]);
    expect(lod.tier).toBe("card");
    expect(lod.detailed).toBe(false);
  });

  /**
   * A board opened zoomed out. `Lod` starts at `full` rather than at the
   * opening camera's tier precisely so that this first settle is a real
   * transition and the layers are told — otherwise every layer would sit at its
   * constructed default having never heard anything.
   */

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
    lod.settle(MIN_ZOOM);
    lod.on((tier) => seen.push(tier));

    // A zoom in, frame by frame. 38.5% is the hysteresis edge.
    expect(lod.rise(0.2)).toBe(false);
    expect(lod.rise(0.3)).toBe(false);
    expect(lod.rise(0.38)).toBe(false);
    expect(lod.rise(0.4)).toBe(true);
    expect(seen).toEqual(["full"]);
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
    for (const zoom of [0.8, 0.5, 0.34, 0.2, MIN_ZOOM]) {
      expect(lod.rise(zoom)).toBe(false);
    }
    expect(lod.tier).toBe("full");
    expect(listener).not.toHaveBeenCalled();

    // And the settle is what finally lets it go — where the frame is already
    // repainting the world for the demote.
    expect(lod.settle(MIN_ZOOM)).toBe(true);
    expect(lod.tier).toBe("card");
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

  /**
   * An export frames the whole board, which is a zoom of a few per cent, which is
   * `card` — so the first PDF this project produced was flat sheets with no
   * ruling and no ageing, and said `16% · card` in the HUD inside the file
   * (T-205, D-36).
   */
  describe("holding the tier for an export", () => {
    it("keeps full detail at a zoom that would otherwise be a card", () => {
      const lod = new Lod();
      lod.settle(0.05);
      expect(lod.tier).toBe("card");

      const release = lod.hold("full");
      expect(lod.tier).toBe("full");
      expect(lod.detailed).toBe(true);
      // And the frame loop cannot argue it back down while the file is drawing.
      expect(lod.settle(0.05)).toBe(false);
      expect(lod.rise(0.05)).toBe(false);
      expect(lod.tier).toBe("full");

      release();
      expect(lod.tier).toBe("card");
    });

    it("gives the tier back to the zoom afterwards", () => {
      const lod = new Lod();
      lod.settle(0.05);
      lod.hold("full")();
      // The performance work of T-90 is only undone if a hold outlives its
      // export, so what matters is that the loop is listened to again.
      expect(lod.settle(1)).toBe(true);
      expect(lod.tier).toBe("full");
      expect(lod.settle(0.05)).toBe(true);
      expect(lod.tier).toBe("card");
    });

    it("tells the layers, both ways, because they hold their own bitmaps", () => {
      const lod = new Lod();
      lod.settle(0.05);
      const seen: string[] = [];
      lod.on((tier) => seen.push(tier));
      const release = lod.hold("full");
      release();
      expect(seen).toEqual(["full", "card"]);
    });
  });
});

describe("READING_ZOOM", () => {
  it("is above the card threshold, because below it there is nothing to read", () => {
    // The two constants answer different questions and the trap is treating
    // them as one. CARD_ZOOM is where per-glyph text stops being drawn at all;
    // this is where what *is* drawn becomes legible. A reading zoom at or below
    // the card threshold would be a promise to take you somewhere you can read,
    // honoured by taking you somewhere with no writing on it.
    expect(READING_ZOOM).toBeGreaterThan(CARD_ZOOM);
  });

  it("clears the hysteresis band too, so arriving cannot leave the tier flapping", () => {
    // A flight that landed inside the band would sit at a zoom where the tier
    // it is in depends on the tier it came from — so the same match would
    // arrive readable or not depending on which direction you flew from.
    expect(READING_ZOOM).toBeGreaterThan(CARD_ZOOM * (1 + TIER_BAND));
  });

  it("is a zoom a person can actually be at", () => {
    expect(READING_ZOOM).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(READING_ZOOM).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it("draws the board's 19-unit body text at about ten and a half pixels", () => {
    // The derivation, asserted rather than left in a comment: this is the one
    // opinion about legibility and it is held in screen pixels of text. A
    // change to the body size that forgot this line would fail here.
    expect(19 * READING_ZOOM).toBeCloseTo(10.5, 6);
  });
});
