import { describe, expect, it } from "vitest";

import { cornerCurl, cornerFace, curlAt } from "@/render/items/curl";
import { tapedCorners } from "@/render/items/tape";
import { Scene, type ItemCold, type ItemPose, type PinNode } from "@/state/scene";

const [TL, TR, BR, BL] = [0, 1, 2, 3];

function cold(id: string, over: Partial<ItemCold> = {}): ItemCold {
  return {
    id,
    type: "note",
    z: "a0",
    seed: 1,
    assetId: null,
    createdBy: 1,
    createdAt: 0,
    text: "",
    ...over,
  };
}

function pose(over: Partial<ItemPose> = {}): ItemPose {
  return { x: 0, y: 0, rot: 0, w: 240, h: 190, ...over };
}

function pin(id: string, parent: string | null, lx: number, ly: number): PinNode {
  return { id, parent, lx, ly, kind: "pushpin", color: "#f00", wx: 0, wy: 0 };
}

/** A seed that would be taped if nothing else were holding the sheet. */
const TAPED = (() => {
  for (let seed = 1; seed < 1000; seed++) if (tapedCorners(seed, 0) !== 0) return seed;
  throw new Error("no seed is taped");
})();

/**
 * A sheet, its pins, and the four corner curls that come out.
 *
 * `taped` is what the caller decided, exactly as `place` decides it — nothing
 * here re-derives it, because that is the point of it being an argument.
 */
function curls(
  pins: readonly PinNode[],
  over: Partial<ItemPose> = {},
  taped = 0,
): Float32Array {
  const scene = new Scene();
  const slot = scene.putItem(cold("sheet"), pose(over));
  for (const p of pins) scene.putPin(p);
  const out = new Float32Array(4);
  cornerCurl(scene, "sheet", slot, taped, out);
  return out;
}

describe("curlAt", () => {
  it("holds a corner flat near a pin and lets it go far from one", () => {
    expect(curlAt(0)).toBe(0);
    expect(curlAt(20)).toBe(0);
    expect(curlAt(400)).toBe(1);
    expect(curlAt(Infinity)).toBe(1);
  });

  it("never goes backwards as the pin gets further away", () => {
    let last = -1;
    for (let gap = 0; gap <= 300; gap += 3) {
      const now = curlAt(gap);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });
});

describe("cornerFace", () => {
  const curled = new Float32Array([1, 1, 1, 1]);

  function faces(rot: number): number[] {
    const out = new Float32Array(4);
    cornerFace(rot, curled, out);
    return [...out];
  }

  it("lights the corner nearest the light and shades the one opposite", () => {
    // The light is up and to the left (DESIGN 4.1), so a flap at the top left
    // tips into it and one at the bottom right tips away.
    const [tl, tr, br, bl] = faces(0);
    expect(tl).toBeGreaterThan(0.9);
    expect(br).toBeLessThan(-0.9);
    // And the two across the other diagonal are barely either way — the light is
    // 30 degrees off vertical, not 45.
    expect(tr).toBeGreaterThan(0);
    expect(bl).toBeLessThan(0);
    expect(Math.abs(tr)).toBeLessThan(0.4);
    expect(Math.abs(bl)).toBeLessThan(0.4);
  });

  it("turns with the sheet, so a corner swaps sides as it is rotated round", () => {
    // Half a turn puts the bottom right corner where the top left one was, and
    // the light has not moved.
    const upright = faces(0);
    const over = faces(Math.PI);
    expect(over[2]).toBeCloseTo(upright[0]!, 5);
    expect(over[0]).toBeCloseTo(upright[2]!, 5);
  });

  it("says nothing about a corner that is not curled", () => {
    // A flat corner has no flap to catch anything.
    const out = new Float32Array(4);
    cornerFace(0, new Float32Array([0, 1, 0, 1]), out);
    expect(out[0]).toBeCloseTo(0, 10);
    expect(out[2]).toBeCloseTo(0, 10);
    expect(Math.abs(out[1]!)).toBeGreaterThan(0);
  });

  it("scales with how far the corner has lifted", () => {
    const out = new Float32Array(4);
    cornerFace(0, new Float32Array([0.5, 0, 0, 0]), out);
    expect(out[0]).toBeCloseTo(faces(0)[0]! / 2, 5);
  });
});

describe("cornerCurl", () => {
  it("curls every corner of a sheet nothing is holding", () => {
    // A loose sheet lying on the cork is exactly the thing that lifts.
    expect([...curls([])]).toEqual([1, 1, 1, 1]);
  });

  it("lies flat under a pin in each corner", () => {
    const out = curls([
      pin("a", "sheet", -110, -85),
      pin("b", "sheet", 110, -85),
      pin("c", "sheet", 110, 85),
      pin("d", "sheet", -110, 85),
    ]);
    expect([...out]).toEqual([0, 0, 0, 0]);
  });

  it("hangs off one pin at the top centre — DESIGN 4.4's whole point", () => {
    // Which is what a paste makes (DESIGN 3.1), so this is the ordinary sheet.
    const out = curls([pin("a", "sheet", 0, -81)]);
    expect(out[BR]).toBe(1);
    expect(out[BL]).toBe(1);
    expect(out[TL]).toBeLessThan(out[BL]!);
    expect(out[TL]).toBeGreaterThan(0);
    // Symmetric about the pin, because the pin is.
    expect(out[TL]).toBeCloseTo(out[TR]!, 6);
  });

  it("counts a pin that is merely over the sheet, not only its own", () => {
    // T-176: `pinsOf` is geometric. A pin somebody dragged onto a note holds it
    // exactly as much as the one it was created with, and a corner does not
    // curl differently because of whose frame the coordinates are stored in.
    const own = curls([pin("a", "sheet", -110, -85)]);
    const other = curls([pin("a", null, -110, -85)]);
    expect([...other]).toEqual([...own]);
    expect(other[TL]).toBe(0);
  });

  it("answers in the sheet's own frame, so turning it turns nothing", () => {
    // The pin is parented, so it turns with the paper. Which corner it holds is
    // a fact about the paper, and a note on its side must not curl somewhere
    // else because the world moved underneath it.
    const upright = curls([pin("a", "sheet", -110, -85)]);
    const sideways = curls([pin("a", "sheet", -110, -85)], { rot: Math.PI / 2 });
    expect([...sideways]).toEqual([...upright]);
  });

  it("holds a taped corner as flat as a pinned one", () => {
    // Tape is one of the two things that hold a sheet down, so a corner with a
    // strip across it must not be drawn lifting off the cork from underneath it.
    // And a taped sheet is by definition an unpinned one, so this is the loose
    // case with two of its corners answered by something other than a pin.
    const taped = tapedCorners(TAPED, 0);
    const out = curls([], {}, taped);
    for (let c = 0; c < 4; c++) {
      expect(out[c]).toBe(taped & (1 << c) ? 0 : 1);
    }
  });

  it("holds the far corners of a small sheet with one pin in the middle", () => {
    // A pin flattens about so much paper around it whatever the sheet is, so a
    // scrap is held everywhere by one pin and a poster is not.
    const scrap = curls([pin("a", "sheet", 0, 0)], { w: 70, h: 60 });
    const poster = curls([pin("a", "sheet", 0, 0)], { w: 700, h: 600 });
    for (const corner of scrap) expect(corner).toBeLessThan(0.01);
    expect([...poster]).toEqual([1, 1, 1, 1]);
  });
});
