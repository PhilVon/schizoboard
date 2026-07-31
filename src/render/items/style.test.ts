/**
 * Seed against override — `render/items/style.ts` (T-225).
 *
 * The four reconciliations are each a decision rather than a fallback, so each
 * gets its own block. What they share is the rule stated once here: an absent
 * property is not a default, it is *the seed's answer*, and putting an override
 * back to absent has to be indistinguishable from never having set one.
 */

import { describe, expect, it } from "vitest";

import type { ItemStyle } from "@/lib/style";
import { defaultStock, seedTint, TINT_HUE_LIMIT, TINT_LIGHT_LIMIT } from "@/render/items/paper";
import { tapedCorners } from "@/render/items/tape";
import { faceOf, sheetEdgeOf, stockOf, tapeOf, tintOf, tornOf } from "@/render/items/style";
import type { ItemCold } from "@/state/scene";

function cold(over: Partial<ItemCold> = {}): ItemCold {
  return {
    id: "i1",
    type: "note",
    z: "a0",
    seed: 12345,
    assetId: null,
    createdBy: 1,
    createdAt: 0,
    text: "",
    style: {},
    ...over,
  };
}

function styled(style: ItemStyle, seed = 12345): ItemCold {
  return cold({ style, seed });
}

describe("which paper", () => {
  it("is the seed's when nobody has chosen", () => {
    const c = cold();
    expect(stockOf(c)).toBe(defaultStock(c.type, c.seed));
  });

  /** Against a stock the seed did *not* draw, or the assertion is true whether
   *  or not the override is read at all. */
  it("is the chosen one when somebody has", () => {
    const seeded = defaultStock("note", 12345);
    const other = (["white", "cream", "legal", "graph"] as const).find((s) => s !== seeded)!;
    expect(stockOf(styled({ paperStock: other }))).toBe(other);
    expect(other).not.toBe(seeded);
  });

  /** A card is index stock by type rather than by seed, and an override has to
   *  beat that too — otherwise the one item whose look is not seeded is the one
   *  item you cannot restyle. */
  it("beats the card's type rule as well as the seed's draw", () => {
    expect(stockOf(cold({ type: "card" }))).toBe("index");
    expect(stockOf(cold({ type: "card", style: { paperStock: "legal" } }))).toBe("legal");
  });

  it("takes the silhouette with it", () => {
    const plain = sheetEdgeOf(cold({ seed: 7 }), 0);
    const graph = sheetEdgeOf(styled({ paperStock: "graph" }, 7), 0);
    const index = sheetEdgeOf(styled({ paperStock: "index" }, 7), 0);
    // Index card is the machine-cut one — 0.35 units of ragged against graph's
    // 1.0 and a tear down one side — so the two polygons cannot be the same.
    expect(graph.path).not.toBe(index.path);
    expect(plain.path).toBeTypeOf("string");
  });
});

describe("the tint", () => {
  it("is the seed's when nobody has chosen", () => {
    expect(tintOf(cold())).toBe(seedTint(12345));
  });

  /**
   * The same formatter for both, which is the reason `tintFilter` was split
   * out. Two formatters would round differently and a sheet would shift shade
   * very slightly the moment somebody first touched it.
   */
  it("formats a chosen tint exactly as a seeded one", () => {
    const chosen = tintOf(styled({ tint: { hue: 0, light: 0 } }));
    expect(chosen).toBe("hue-rotate(0.00deg) brightness(1.0000)");
    expect(chosen).toMatch(/^hue-rotate\(-?\d+\.\d\ddeg\) brightness\(\d\.\d{4}\)$/);
    expect(seedTint(12345)).toMatch(/^hue-rotate\(-?\d+\.\d\ddeg\) brightness\(\d\.\d{4}\)$/);
  });

  /** A sheet you can select and delete but can no longer read is not a tint. */
  it("clamps a tint that would stop it reading as paper", () => {
    expect(tintOf(styled({ tint: { hue: 900, light: 900 } }))).toBe(
      `hue-rotate(${TINT_HUE_LIMIT.toFixed(2)}deg) brightness(${(1 + TINT_LIGHT_LIMIT / 100).toFixed(4)})`,
    );
    expect(tintOf(styled({ tint: { hue: -900, light: -900 } }))).toBe(
      `hue-rotate(${(-TINT_HUE_LIMIT).toFixed(2)}deg) brightness(${(1 - TINT_LIGHT_LIMIT / 100).toFixed(4)})`,
    );
  });

  /** The limits have to leave room, or choosing one would do less than the
   *  board already does on its own. */
  it("leaves the seed's whole range inside the limits", () => {
    for (let seed = 0; seed < 200; seed++) {
      const filter = seedTint(seed);
      const hue = Number(/hue-rotate\((-?[\d.]+)deg\)/.exec(filter)![1]);
      expect(Math.abs(hue)).toBeLessThan(TINT_HUE_LIMIT);
    }
  });
});

describe("the tape", () => {
  it("is the seed's when nobody has chosen", () => {
    expect(tapeOf(cold(), 0)).toBe(tapedCorners(12345, 0));
  });

  it("takes the tape off when asked, whatever the seed said", () => {
    // On a seed the seed path *does* tape, so there is something to undo and
    // the assertion is not true by accident.
    let seed = 0;
    while (seed < 5000 && tapedCorners(seed, 0) === 0) seed++;
    expect(tapedCorners(seed, 0)).not.toBe(0);
    expect(tapeOf(styled({ tapeStyle: 0 }, seed), 0)).toBe(0);
  });

  it("puts tape on a sheet the seed left bare", () => {
    let seed = 0;
    while (seed < 5000 && tapedCorners(seed, 0) !== 0) seed++;
    expect(tapedCorners(seed, 0)).toBe(0);
    expect(tapeOf(styled({ tapeStyle: 0b1100 }, seed), 0)).toBe(0b1100);
  });

  /**
   * The decision in `tapeOf`, and the one worth a test because it deliberately
   * departs from the seed path: nothing pinned is taped, but a mask in the
   * document is somebody having *asked*. A choice that silently stops meaning
   * anything the moment a pin goes in is worse than belt and braces.
   */
  it("honours a chosen mask on a pinned sheet, where the seed would refuse", () => {
    expect(tapeOf(cold(), 1)).toBe(0);
    expect(tapeOf(styled({ tapeStyle: 0b0011 }), 1)).toBe(0b0011);
  });
});

describe("torn or cut", () => {
  it("is the stock's when nobody has chosen", () => {
    expect(tornOf(styled({ paperStock: "legal" }))).toBe("top");
    expect(tornOf(styled({ paperStock: "graph" }))).toBe("left");
    expect(tornOf(styled({ paperStock: "white" }))).toBeNull();
  });

  it("cuts a sheet the stock would have torn", () => {
    expect(tornOf(styled({ paperStock: "legal", torn: false }))).toBeNull();
  });

  it("keeps the stock's own side when it has one", () => {
    expect(tornOf(styled({ paperStock: "legal", torn: true }))).toBe("top");
  });

  /**
   * The awkward half: the document holds a boolean and the renderer needs a
   * side. A stock with no side of its own gets one from the seed, so that two
   * white sheets both marked torn do not tear along the same edge and give the
   * pair away as a setting rather than as paper.
   */
  it("finds a side from the seed for a stock that has none", () => {
    const sides = new Set<string | null>();
    for (let seed = 0; seed < 60; seed++) {
      sides.add(tornOf(styled({ paperStock: "white", torn: true }, seed)));
    }
    expect(sides).not.toContain(null);
    expect(sides.size).toBe(2);
  });

  it("gives the same sheet the same side every time it is asked", () => {
    const c = styled({ paperStock: "white", torn: true }, 99);
    expect(tornOf(c)).toBe(tornOf(c));
  });
});

describe("the face", () => {
  it("is the board's own hand when nobody has chosen", () => {
    expect(faceOf(cold())).toBe("hand");
  });

  it("is the clean one when somebody has", () => {
    expect(faceOf(styled({ fontFamily: "clean" }))).toBe("clean");
  });
});

describe("putting an override back", () => {
  /**
   * The rule the whole design rests on, tested against all five at once: an
   * item whose overrides have been cleared has to be indistinguishable from one
   * that was never touched — not merely similar to it.
   */
  it("is indistinguishable from never having chosen", () => {
    const never = cold({ seed: 4242 });
    const cleared = cold({ seed: 4242, style: {} });
    expect(stockOf(cleared)).toBe(stockOf(never));
    expect(tintOf(cleared)).toBe(tintOf(never));
    expect(tapeOf(cleared, 0)).toBe(tapeOf(never, 0));
    expect(tornOf(cleared)).toBe(tornOf(never));
    expect(faceOf(cleared)).toBe(faceOf(never));
    expect(sheetEdgeOf(cleared, 0.4).path).toBe(sheetEdgeOf(never, 0.4).path);
  });
});
