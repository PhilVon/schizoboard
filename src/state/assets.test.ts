/**
 * The five states, and the orders they are allowed to move between.
 *
 * The transitions are trivial; the guards are not, and every one of them is here
 * because a caller fires at a rate or in an order it does not control. A test
 * that only walked unknown → requesting → transferring → ready would pass
 * against a plain `Map.set` and prove nothing.
 */

import { describe, expect, it, vi } from "vitest";

import { AssetStates } from "@/state/assets";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("the happy path", () => {
  it("starts every hash at unknown, with nothing showable", () => {
    const assets = new AssetStates();
    expect(assets.phase(A)).toBe("unknown");
    expect(assets.isReady(A)).toBe(false);
    expect(assets.fraction(A)).toBe(0);
  });

  it("walks unknown to requesting to transferring to ready", () => {
    const assets = new AssetStates();
    assets.requesting(A);
    expect(assets.phase(A)).toBe("requesting");
    assets.transferring(A, 1, 4);
    expect(assets.phase(A)).toBe("transferring");
    expect(assets.fraction(A)).toBeCloseTo(0.25);
    assets.ready(A);
    expect(assets.phase(A)).toBe("ready");
    expect(assets.isReady(A)).toBe(true);
  });

  it("keeps hashes apart", () => {
    const assets = new AssetStates();
    assets.ready(A);
    assets.unavailable(B);
    expect(assets.phase(A)).toBe("ready");
    expect(assets.phase(B)).toBe("unavailable");
  });

  it("reports no fraction for anything that is not mid-transfer", () => {
    const assets = new AssetStates();
    assets.transferring(A, 3, 4);
    expect(assets.fraction(A)).toBeCloseTo(0.75);
    // The bytes landed. "Three quarters" is now a lie about a photograph that
    // is entirely here, and the art on top would draw it as one.
    assets.ready(A);
    expect(assets.fraction(A)).toBe(0);
  });

  it("survives a total of zero without dividing by it", () => {
    const assets = new AssetStates();
    assets.transferring(A, 0, 0);
    expect(assets.phase(A)).toBe("transferring");
    expect(assets.fraction(A)).toBe(0);
  });
});

describe("ready absorbs", () => {
  // Every one of these is a real callback that can land after the commit: the
  // exchange's own progress callback races the platform's `asset:ready`, and
  // `assetUrl` re-requests on a rebind that has not noticed yet.
  it("ignores a late progress report", () => {
    const assets = new AssetStates();
    assets.ready(A);
    assets.transferring(A, 1, 4);
    expect(assets.phase(A)).toBe("ready");
  });

  it("ignores a re-request", () => {
    const assets = new AssetStates();
    assets.ready(A);
    assets.requesting(A);
    expect(assets.phase(A)).toBe("ready");
  });

  it("ignores a stale give-up", () => {
    const assets = new AssetStates();
    assets.ready(A);
    assets.unavailable(A);
    expect(assets.isReady(A)).toBe(true);
  });
});

describe("requesting only leaves unknown", () => {
  it("does not reset a transfer that is already running", () => {
    const assets = new AssetStates();
    assets.transferring(A, 3, 4);
    // `assetUrl` calls `want` for every missing asset on every rebind, which is
    // many times a second while the transfer it is describing runs. If this
    // overwrote the transfer, drawing the frame would erase the progress.
    assets.requesting(A);
    expect(assets.phase(A)).toBe("transferring");
    expect(assets.fraction(A)).toBeCloseTo(0.75);
  });

  it("does not un-say unavailable", () => {
    const assets = new AssetStates();
    assets.unavailable(A);
    assets.requesting(A);
    // Wanting it again asks the same empty room. Nothing has changed, and a
    // torn photograph that flickered back to "waiting" every frame would never
    // settle into anything a person could read.
    expect(assets.phase(A)).toBe("unavailable");
  });
});

describe("unavailable clears when bytes actually move", () => {
  it("goes back to transferring when a holder finally turns up", () => {
    const assets = new AssetStates();
    assets.unavailable(A);
    assets.transferring(A, 1, 8);
    expect(assets.phase(A)).toBe("transferring");
  });

  it("goes to ready when the bytes arrive some other way", () => {
    const assets = new AssetStates();
    assets.unavailable(A);
    // Pasted here, or restored from a backup, or the peer that had it rejoined
    // and the sweep found it on disk.
    assets.ready(A);
    expect(assets.isReady(A)).toBe(true);
  });
});

describe("counting the ones nobody has", () => {
  it("counts only the given-up hashes", () => {
    const assets = new AssetStates();
    assets.unavailable(A);
    assets.requesting(B);
    expect(assets.countUnavailable()).toBe(1);
  });

  it("stops counting one that arrives after all", () => {
    const assets = new AssetStates();
    assets.unavailable(A);
    assets.ready(A);
    expect(assets.countUnavailable()).toBe(0);
  });
});

describe("change notification", () => {
  it("names the hash that moved, once per move", () => {
    const assets = new AssetStates();
    const seen = vi.fn();
    assets.onChange(seen);
    assets.requesting(A);
    assets.transferring(A, 1, 4);
    assets.ready(A);
    expect(seen.mock.calls).toEqual([[A], [A], [A]]);
  });

  it("says nothing when a call changes nothing", () => {
    const assets = new AssetStates();
    assets.transferring(A, 1, 4);
    const seen = vi.fn();
    assets.onChange(seen);
    // The rebind flood, and a give-up arriving twice.
    assets.requesting(A);
    assets.requesting(A);
    assets.transferring(A, 1, 4);
    expect(seen).not.toHaveBeenCalled();
  });

  it("does not announce a progress move too small to round differently", () => {
    const assets = new AssetStates();
    const seen = vi.fn();
    assets.onChange(seen);
    // A thousand-chunk photograph: ten chunks to the percent. A listener's job
    // is to walk the scene dirtying every item wearing the hash, and doing that
    // ten times for one identical redraw is the cost this exists to avoid.
    assets.transferring(A, 10, 1000);
    seen.mockClear();
    assets.transferring(A, 11, 1000);
    assets.transferring(A, 12, 1000);
    expect(seen).not.toHaveBeenCalled();
    assets.transferring(A, 20, 1000);
    expect(seen).toHaveBeenCalledWith(A);
  });

  it("keeps the un-announced progress, so the next reader sees the truth", () => {
    const assets = new AssetStates();
    assets.transferring(A, 10, 1000);
    assets.transferring(A, 15, 1000);
    // Not worth a redraw is not the same as not worth recording — a redraw
    // caused by something else must not paint a stale percentage.
    expect(assets.fraction(A)).toBeCloseTo(0.015);
  });

  it("unsubscribes", () => {
    const assets = new AssetStates();
    const seen = vi.fn();
    const off = assets.onChange(seen);
    off();
    assets.ready(A);
    expect(seen).not.toHaveBeenCalled();
  });
});
