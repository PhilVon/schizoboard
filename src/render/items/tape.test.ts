import { describe, expect, it } from "vitest";

import {
  MAX_TAPES,
  TAPE_BL,
  TAPE_BR,
  TAPE_TL,
  TAPE_TR,
  tapeAngle,
  tapeClipPath,
  tapedCorners,
  tapeFlip,
} from "@/render/items/tape";

function bits(mask: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) if (mask & (1 << i)) n++;
  return n;
}

describe("tapedCorners", () => {
  it("is stable for a seed", () => {
    expect(tapedCorners(7, 0)).toBe(tapedCorners(7, 0));
  });

  it("tapes nothing that is pinned", () => {
    // Tape and a pin are alternatives, not layers: nobody tapes down a
    // photograph they have already put a pin through. So this is also the rule
    // that says what the strips are *for* — a taped item is one that would
    // otherwise be held by nothing at all.
    let everTaped = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      expect(tapedCorners(seed, 1)).toBe(0);
      expect(tapedCorners(seed, 4)).toBe(0);
      if (tapedCorners(seed, 0)) everTaped++;
    }
    // The pin count is the only thing that changed, so this is not vacuous:
    // plenty of these same seeds are taped when nothing is holding them.
    expect(everTaped).toBeGreaterThan(200);
  });

  it("tapes some of a board and not all of it", () => {
    // The fraction is a taste decision and this is not policing it. What it is
    // policing is that tape is neither everywhere — which is a pattern, not a
    // board — nor so rare that nobody ever sees one.
    let taped = 0;
    for (let seed = 1; seed <= 2000; seed++) if (tapedCorners(seed, 0)) taped++;
    expect(taped).toBeGreaterThan(2000 * 0.15);
    expect(taped).toBeLessThan(2000 * 0.55);
  });

  it("puts on one strip or two, never more", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      expect(bits(tapedCorners(seed, 0))).toBeLessThanOrEqual(MAX_TAPES);
    }
  });

  it("never tapes two corners down one side", () => {
    // A hand tapes across the top or diagonally opposite. Two adjacent down one
    // edge is a thing nobody does and it looks like it.
    const adjacent = [TAPE_TL | TAPE_BL, TAPE_TR | TAPE_BR, TAPE_BL | TAPE_BR];
    for (let seed = 1; seed <= 2000; seed++) {
      const mask = tapedCorners(seed, 0);
      if (bits(mask) !== 2) continue;
      expect(adjacent).not.toContain(mask);
    }
  });
});

describe("tapeAngle", () => {
  it("lays every strip across its corner rather than along the diagonal", () => {
    // Across, so the strip spans from one edge to the other and holds something.
    // Along would point it at the middle of the item and hold nothing — which is
    // the sign flip, and it is opposite on the two diagonals.
    for (const corner of [TAPE_TL, TAPE_BR]) {
      expect(tapeAngle(11, corner, 0)).toBeLessThan(0);
    }
    for (const corner of [TAPE_TR, TAPE_BL]) {
      expect(tapeAngle(11, corner, 0)).toBeGreaterThan(0);
    }
  });

  it("is about forty-five degrees, and never exactly", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const degrees = (tapeAngle(seed, TAPE_TR, 0) * 180) / Math.PI;
      expect(degrees).toBeGreaterThan(36);
      expect(degrees).toBeLessThan(54);
      expect(degrees).not.toBe(45);
    }
  });

  it("gives the two strips on one item different angles", () => {
    // Two tapes exactly parallel is the tell that they came out of a stylesheet.
    expect(tapeAngle(11, TAPE_TL, 0)).not.toBe(tapeAngle(11, TAPE_TL, 1));
  });
});

describe("tapeFlip", () => {
  // The board's own light, from `shadow.ts` — up and to the left, so the vector
  // toward the shadow points down and to the right.
  const LX = Math.sin(Math.PI / 6);
  const LY = Math.cos(Math.PI / 6);

  it("keeps a strip the way up it is drawn when its shine already faces the light", () => {
    // Which is every strip on an item that has not been turned far: at plus or
    // minus 45 degrees the strip's own down-side is still down-light, because
    // the light is only 30 degrees off vertical.
    expect(tapeFlip(Math.PI / 4, LX, LY)).toBe(1);
    expect(tapeFlip(-Math.PI / 4, LX, LY)).toBe(1);
    expect(tapeFlip(0, LX, LY)).toBe(1);
  });

  it("mirrors it once the item has been turned past the light", () => {
    // Turn the same strip right over and its shine is now pointing away, so the
    // profile has to be drawn the other way up. This is the case a rotation
    // gesture produces and a scatter never does.
    expect(tapeFlip(Math.PI / 4 + Math.PI, LX, LY)).toBe(-1);
    expect(tapeFlip(-Math.PI / 4 + Math.PI, LX, LY)).toBe(-1);
  });

  it("flips exactly once as a strip is turned all the way round", () => {
    let flips = 0;
    let last = tapeFlip(0, LX, LY);
    for (let i = 1; i <= 720; i++) {
      const now = tapeFlip((i * Math.PI) / 360, LX, LY);
      if (now !== last) flips++;
      last = now;
    }
    // Twice round the circle from one side to the other and back — never a
    // stutter, which is what a sign test on a dot product buys over a threshold.
    expect(flips).toBe(2);
  });
});

describe("tapeClipPath", () => {
  function points(path: string): { x: number; y: number }[] {
    const inner = /^polygon\((.*)\)$/.exec(path)?.[1];
    expect(inner).toBeDefined();
    return inner!.split(", ").map((pair) => {
      const [x, y] = pair.split(" ").map((n) => Number(n.replace("%", "")));
      return { x: x!, y: y! };
    });
  }

  it("is torn across the ends and straight along its length", () => {
    // That asymmetry is what says tape: a roll is cut to width by its own
    // straight edges, and only what a hand did to it is ragged.
    const all = points(tapeClipPath(3, 0));
    for (const point of all) {
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(100);
      // Every vertex is in one end or the other, never partway along.
      expect(point.x < 8 || point.x > 92).toBe(true);
    }
    expect(Math.min(...all.map((p) => p.y))).toBe(0);
    expect(Math.max(...all.map((p) => p.y))).toBe(100);
  });

  it("tears the two strips on one item differently", () => {
    expect(tapeClipPath(3, 0)).not.toBe(tapeClipPath(3, 1));
  });
});
