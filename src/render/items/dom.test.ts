/**
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CAPTION_BOTTOM, CAPTION_HEIGHT, FRAME_BOTTOM } from "@/lib/polaroid";
import { ItemInk } from "@/render/ink/canvas";
import {
  DomItemLayer,
  NO_FACTS,
  type AssetFacts,
  type AssetLookup,
  type AssetResolver,
  type AssetView,
} from "@/render/items/dom";
import { objectSizeFor } from "@/lib/objects";
import { tapedCorners } from "@/render/items/tape";
import { dogEarOf } from "@/render/items/wear";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemCold, type ItemPose } from "@/state/scene";

let host: HTMLDivElement;
let scene: Scene;
let dirty: DirtySets;
let layer: DomItemLayer;

/** The bytes are on this disk. */
const ready = (url: string): AssetView => ({ url, phase: "ready", fraction: 0 });
/** Nothing to point an `<img>` at yet, in whichever state left it that way. */
const waiting = (): AssetView => ({ url: "", phase: "requesting", fraction: 0 });

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  scene = new Scene();
  dirty = new DirtySets();
  layer = new DomItemLayer(host, (sha) => ready(`asset://sha256/${sha}`));
});

function add(
  id: string,
  cold: Partial<ItemCold> = {},
  pose: Partial<ItemPose> = {},
): void {
  scene.putItem(
    {
      id,
      type: "polaroid",
      z: "a0",
      seed: 1,
      assetId: null,
      createdBy: 1,
      createdAt: 0,
      text: "",
      ...cold,
    },
    { x: 0, y: 0, rot: 0, w: 100, h: 100, ...pose },
  );
  dirty.item(id);
}

describe("DomItemLayer", () => {
  it("mounts an element per item and nothing more", () => {
    add("a");
    add("b", { type: "note" });
    layer.sync(scene, dirty, null);
    expect(layer.mounted).toBe(2);
    expect(host.children.length).toBe(2);
  });

  it("does nothing at all when the frame is clean", () => {
    add("a");
    layer.sync(scene, dirty, null);
    dirty.clear();
    scene.removeItem("a");
    layer.sync(scene, dirty, null);
    // Still mounted: a clean frame must not walk the scene.
    expect(layer.mounted).toBe(1);
  });

  it("recycles nodes rather than creating fresh ones", () => {
    add("a");
    layer.sync(scene, dirty, null);
    const first = host.children[0];

    dirty.clear();
    scene.removeItem("a");
    dirty.item("a");
    layer.sync(scene, dirty, null);
    expect(layer.mounted).toBe(0);
    expect(host.children.length).toBe(0);

    dirty.clear();
    add("b");
    layer.sync(scene, dirty, null);
    // Same node object, back out of the pool.
    expect(host.children[0]).toBe(first);
  });

  it("keeps separate pools per archetype", () => {
    add("photo", { type: "polaroid" });
    add("paper", { type: "note" });
    layer.sync(scene, dirty, null);
    const kinds = [...host.children].map((el) =>
      el.classList.contains("item-polaroid") ? "polaroid" : "paper",
    );
    expect(kinds.sort()).toEqual(["paper", "polaroid"]);
  });

  it("unmounts items culled out of view", () => {
    add("a");
    add("b");
    layer.sync(scene, dirty, null);
    expect(layer.mounted).toBe(2);

    dirty.everything();
    layer.sync(scene, dirty, new Set(["a"]));
    expect(layer.mounted).toBe(1);
  });

  it("paints in the documented total order, not insertion order", () => {
    add("late", { z: "a2" });
    add("early", { z: "a0" });
    add("middle", { z: "a1" });
    layer.sync(scene, dirty, null);
    expect(layer.paintOrder()).toEqual(["early", "middle", "late"]);
  });

  it("breaks an equal z key on client id then item id, as compareOrder does", () => {
    add("bb", { z: "a0", createdBy: 2 });
    add("aa", { z: "a0", createdBy: 2 });
    add("zz", { z: "a0", createdBy: 1 });
    layer.sync(scene, dirty, null);
    expect(layer.paintOrder()).toEqual(["zz", "aa", "bb"]);
  });

  it("re-sorts when a z key changes and not when a position does", () => {
    add("a", { z: "a0" });
    add("b", { z: "a1" });
    layer.sync(scene, dirty, null);
    expect(layer.paintOrder()).toEqual(["a", "b"]);

    dirty.clear();
    // Raise "a" above "b".
    scene.putItem({ ...scene.cold("a")!, z: "a2" }, scene.poseOf("a")!);
    dirty.item("a");
    layer.sync(scene, dirty, null);
    expect(layer.paintOrder()).toEqual(["b", "a"]);
  });

  it("orders the whole board, not only what is mounted", () => {
    add("a", { z: "a0" });
    add("b", { z: "a1" });
    add("c", { z: "a2" });
    dirty.everything();
    layer.sync(scene, dirty, new Set(["b"]));
    expect(layer.mounted).toBe(1);
    // Culling decides what is drawn; it must not get a say in what order things
    // are drawn in, or panning would shuffle the board.
    expect(layer.paintOrder()).toEqual(["a", "b", "c"]);
  });

  it("does not renumber a surviving item when its neighbours mount and unmount", () => {
    add("a", { z: "a0" });
    add("b", { z: "a1" });
    add("c", { z: "a2" });
    layer.sync(scene, dirty, null);
    const b = host.children[1] as HTMLElement;
    const before = b.style.zIndex;
    expect(before).not.toBe("");

    // A zoom, in the spike, unmounted ~180 items across one gesture. Every one
    // of those used to rewrite an inline style on every other mounted node, and
    // 180 style invalidations a frame is a 243 ms frame (D-13).
    dirty.everything();
    layer.sync(scene, dirty, new Set(["b"]));
    expect(b.style.zIndex).toBe(before);

    dirty.everything();
    layer.sync(scene, dirty, null);
    expect(b.style.zIndex).toBe(before);
  });

  it("gives a remounted item the z-index it had before", () => {
    add("under", { z: "a0" });
    add("over", { z: "a1" });
    layer.sync(scene, dirty, null);
    const over = host.children[1] as HTMLElement;
    const overZ = over.style.zIndex;

    dirty.everything();
    layer.sync(scene, dirty, new Set(["under"]));
    expect(over.parentElement).toBeNull();

    // Blanked, so the assertion is that mounting *writes* the rank rather than
    // that the pooled node happened to keep it.
    over.style.zIndex = "";
    dirty.everything();
    layer.sync(scene, dirty, null);
    expect(over.parentElement).toBe(host);
    expect(over.style.zIndex).toBe(overZ);
  });

  it("writes a transform that positions by centre", () => {
    add("a", {}, { x: 100, y: 50, w: 40, h: 20 });
    layer.sync(scene, dirty, null);
    const el = host.children[0] as HTMLElement;
    expect(el.style.transform).toBe("translate(80px, 40px) rotate(0rad)");
    expect(el.style.width).toBe("40px");
  });

  it("renders the swing on top of the authored rotation", () => {
    add("a", {}, { rot: 0.1 });
    scene.swing[scene.slotOf("a")!] = 0.4;
    layer.sync(scene, dirty, null);
    const el = host.children[0] as HTMLElement;
    expect(el.style.transform).toContain("rotate(0.5rad)");
  });

  it("scales a carried item up and leaves a resting one alone", () => {
    add("a", {}, { x: 0, y: 0, w: 100, h: 100 });
    layer.sync(scene, dirty, null);
    const el = host.children[0] as HTMLElement;
    expect(el.style.transform).not.toContain("scale");
    expect(el.classList.contains("is-lifted")).toBe(false);

    dirty.clear();
    scene.lift[scene.slotOf("a")!] = 1;
    dirty.item("a");
    layer.sync(scene, dirty, null);
    // "it scales up by about 2%" — DESIGN 3.2.
    expect(el.style.transform).toContain("scale(1.02)");
    expect(el.classList.contains("is-lifted")).toBe(true);
  });

  it("keeps the carry out of the item's real geometry", () => {
    add("a", {}, { x: 0, y: 0, w: 100, h: 100 });
    scene.lift[scene.slotOf("a")!] = 1;
    layer.sync(scene, dirty, null);
    // A 2% flourish must not move the edge things are hit-tested against.
    expect(layer.hitTest(scene, 50.5, 0)).toBeNull();
    expect(layer.hitTest(scene, 49.5, 0)).toBe("a");
  });

  it("rebinds only when the document changed, not when the item moved", () => {
    add("a", { text: "one" }, { x: 0, y: 0 });
    layer.sync(scene, dirty, null);
    const caption = host.querySelector(".pol-caption")!;
    expect(caption.textContent).toBe("one");

    // A drag replaces the pose and leaves the cold record alone, which is what
    // lets the view skip sixty rebinds a second.
    dirty.clear();
    caption.textContent = "scribbled over";
    scene.setPose("a", { x: 40 });
    dirty.item("a");
    layer.sync(scene, dirty, null);
    expect(caption.textContent).toBe("scribbled over");

    // A real document change mints a fresh cold record, and that does rebind.
    dirty.clear();
    add("a", { text: "two" }, { x: 40, y: 0 });
    layer.sync(scene, dirty, null);
    expect(caption.textContent).toBe("two");
  });

  it("rebinds when an item's bytes arrive, which the document never mentions", () => {
    // The asset store answers "not here yet" with an empty URL, and the item is
    // fully usable in that state (DESIGN 7.5). What must not happen is that it
    // stays that way: the cold record does not change when the bytes land.
    let stored: AssetView = waiting();
    const late = new DomItemLayer(host, () => stored);
    add("a", { assetId: "abc" });
    late.sync(scene, dirty, null);
    const img = host.querySelector(".pol-photo") as HTMLImageElement;
    expect(img.hasAttribute("src")).toBe(false);

    stored = ready("asset://sha256/abc");
    dirty.clear();
    dirty.item("a");
    late.sync(scene, dirty, null);
    expect(img.getAttribute("src")).toBe("asset://sha256/abc");
    late.destroy();
  });

  // Three tests about selection chrome used to live here — one of them about a
  // culled-and-remounted item coming back still outlined, which is what the
  // layer's copy of the selection existed for. The chrome is `render/overlay.ts`
  // now (T-91) and none of it is the layer's business; `overlay.test.ts` covers
  // it, including the case where a selected item has been culled away.

  it("does not hand a recycled node the last item's carry", () => {
    add("a");
    layer.sync(scene, dirty, null);
    scene.lift[scene.slotOf("a")!] = 1;
    dirty.item("a");
    layer.sync(scene, dirty, null);

    dirty.clear();
    scene.removeItem("a");
    dirty.item("a");
    layer.sync(scene, dirty, null);
    dirty.clear();
    add("b", { type: "polaroid" });
    layer.sync(scene, dirty, null);

    const el = host.children[0] as HTMLElement;
    expect(el.classList.contains("is-lifted")).toBe(false);
  });

  it("waits until a photograph has actually arrived, not until a URL exists", () => {
    add("a", { assetId: null });
    add("b", { assetId: "abc" });
    layer.sync(scene, dirty, null);
    // Both: one has no photograph coming, the other has one in flight. The
    // undeveloped-film state covers the whole of the wait, which is the only
    // time anyone would see it.
    const waiting = [...host.children].filter((el) => el.classList.contains("is-waiting"));
    expect(waiting.length).toBe(2);

    const photo = host.querySelectorAll(".pol-photo")[1] as HTMLImageElement;
    photo.dispatchEvent(new Event("load"));
    expect(photo.closest(".item")!.classList.contains("is-waiting")).toBe(false);

    // ...and a photograph this peer cannot produce goes straight back to it,
    // rather than showing a broken-image icon.
    photo.dispatchEvent(new Event("error"));
    expect(photo.closest(".item")!.classList.contains("is-waiting")).toBe(true);
  });

  it("does not leave a recycled node wearing the last item's photograph", () => {
    add("a", { assetId: "abc" });
    layer.sync(scene, dirty, null);
    const photo = host.querySelector(".pol-photo") as HTMLImageElement;
    photo.dispatchEvent(new Event("load"));
    expect(photo.getAttribute("src")).toBe("asset://sha256/abc");

    dirty.clear();
    scene.removeItem("a");
    dirty.item("a");
    layer.sync(scene, dirty, null);

    // Same asset, new item, pooled node. The URL guard would otherwise match,
    // skip the assignment, and never request anything.
    dirty.clear();
    add("b", { assetId: "abc" });
    layer.sync(scene, dirty, null);
    expect(host.children.length).toBe(1);
    expect((host.children[0] as HTMLElement).classList.contains("is-waiting")).toBe(true);
  });
});

describe("asset variants", () => {
  /** Records what the layer asked for, so the assertions are about the ask. */
  function recording(): { asked: { sha: string; px: number }[]; resolve: AssetResolver } {
    const asked: { sha: string; px: number }[] = [];
    return {
      asked,
      resolve: (sha, px) => {
        asked.push({ sha, px });
        return ready(`asset://sha256/${sha}?px=${Math.round(px)}`);
      },
    };
  }

  it("asks for the size the item will be drawn at, not the size it is", () => {
    const { asked, resolve } = recording();
    const layer = new DomItemLayer(host, resolve);
    add("a", { assetId: "abc" }, { w: 320, h: 240 });

    // Zoomed out to 5% on a 2x display: a 320-unit polaroid is 32 device pixels.
    layer.setRasterScale(0.05 * 2);
    layer.sync(scene, dirty, null);
    expect(asked).toEqual([{ sha: "abc", px: 32 }]);

    // And at 400% on the same display it is 2560.
    asked.length = 0;
    layer.setRasterScale(4 * 2);
    dirty.everything();
    layer.sync(scene, dirty, null);
    expect(asked).toEqual([{ sha: "abc", px: 2560 }]);
    layer.destroy();
  });

  it("defaults to the full size when nobody has said what the scale is", () => {
    // Wrong in the cheap direction: a layer nobody wires up should look right and
    // cost too much, not look wrong.
    const { asked, resolve } = recording();
    const layer = new DomItemLayer(host, resolve);
    add("a", { assetId: "abc" }, { w: 320, h: 240 });
    layer.sync(scene, dirty, null);
    expect(asked[0]!.px).toBe(320);
    layer.destroy();
  });

  it("ignores a nonsense scale rather than asking for a zero-pixel image", () => {
    const { asked, resolve } = recording();
    const layer = new DomItemLayer(host, resolve);
    add("a", { assetId: "abc" }, { w: 320, h: 240 });
    layer.setRasterScale(0);
    layer.setRasterScale(Number.NaN);
    layer.sync(scene, dirty, null);
    expect(asked[0]!.px).toBe(320);
    layer.destroy();
  });

  it("keeps the photograph on screen while a replacement variant decodes", async () => {
    const { resolve } = recording();
    const layer = new DomItemLayer(host, resolve);
    add("a", { assetId: "abc" }, { w: 320, h: 240 });
    layer.setRasterScale(1);
    layer.sync(scene, dirty, null);

    const photo = host.querySelector(".pol-photo") as HTMLImageElement;
    const first = photo.getAttribute("src");
    expect(first).toContain("px=320");
    photo.dispatchEvent(new Event("load"));

    // A zoom-end crossing into the larger variant. Assigning src straight away
    // would blank the item until the new bytes decoded; DESIGN's rule for a
    // re-raster is that the stale bitmap stays up in the interim (T-63).
    layer.setRasterScale(8);
    dirty.everything();
    layer.sync(scene, dirty, null);
    expect(photo.getAttribute("src")).toBe(first);
    expect(photo.closest(".item")!.classList.contains("is-waiting")).toBe(false);

    // ...and once the decode has had a turn, it swaps.
    await new Promise((r) => setTimeout(r, 0));
    expect(photo.getAttribute("src")).toContain("px=2560");
    layer.destroy();
  });

  it("does not land a late variant decode on a recycled node", async () => {
    const { resolve } = recording();
    const layer = new DomItemLayer(host, resolve);
    add("a", { assetId: "abc" }, { w: 320, h: 240 });
    layer.setRasterScale(1);
    layer.sync(scene, dirty, null);
    const photo = host.querySelector(".pol-photo") as HTMLImageElement;
    photo.dispatchEvent(new Event("load"));

    // Start a swap, then cull the item away before it can finish.
    layer.setRasterScale(8);
    dirty.everything();
    layer.sync(scene, dirty, null);
    dirty.everything();
    layer.sync(scene, dirty, new Set());
    expect(layer.mounted).toBe(0);

    await new Promise((r) => setTimeout(r, 0));
    // The pooled node must be blank, not wearing the photograph of the item it
    // used to be — the whole hazard of recycling.
    expect(photo.hasAttribute("src")).toBe(false);
    layer.destroy();
  });
});

describe("hitTest", () => {
  it("finds an item under a board point", () => {
    add("a", {}, { x: 0, y: 0, w: 100, h: 100 });
    layer.sync(scene, dirty, null);
    expect(layer.hitTest(scene, 10, 10)).toBe("a");
    expect(layer.hitTest(scene, 60, 0)).toBeNull();
  });

  it("returns the topmost of overlapping items", () => {
    add("under", { z: "a0" }, { x: 0, y: 0, w: 100, h: 100 });
    add("over", { z: "a5" }, { x: 0, y: 0, w: 100, h: 100 });
    layer.sync(scene, dirty, null);
    expect(layer.hitTest(scene, 0, 0)).toBe("over");
  });

  it("respects rotation", () => {
    // A long thin item turned a quarter turn: a point off its long axis is a
    // hit before the rotation and a miss after it.
    add("a", {}, { x: 0, y: 0, w: 200, h: 20, rot: 0 });
    layer.sync(scene, dirty, null);
    expect(layer.hitTest(scene, 80, 0)).toBe("a");

    scene.setPose("a", { rot: Math.PI / 2 });
    expect(layer.hitTest(scene, 80, 0)).toBeNull();
    expect(layer.hitTest(scene, 0, 80)).toBe("a");
  });

  /**
   * T-186 — the pen's boundary, and the one property that makes it a second
   * walk rather than a filter on the first.
   *
   * A sheet is not its rectangle. `hitTest` takes the rectangle because a grab
   * target wants to be forgiving; `inkHitTest` takes the paper, because a mark
   * has to land where you can see paper. The tests below are about the *walk*.
   * Whether the polygon is the right shape is `edge.test.ts`'s business.
   */
  describe("inkHitTest", () => {
    /** The deepest tear this board has: a legal pad, torn along its head. */
    function torn(id: string, cold: Partial<ItemCold> = {}): void {
      add(id, { type: "note", seed: 7, ...cold }, { x: 0, y: 0, w: 400, h: 300 });
    }

    /** A board point in the strip a torn head gave up, or null if this seed's
     *  tear does not reach far enough to test with. */
    function inTheStrip(id: string): { x: number; y: number } | null {
      const h = 300;
      for (let dy = 0.5; dy < 9; dy += 0.25) {
        const y = -h / 2 + dy;
        for (let x = -150; x <= 150; x += 5) {
          if (layer.hitTest(scene, x, y) === id && layer.inkHitTest(scene, x, y) !== id) {
            return { x, y };
          }
        }
      }
      return null;
    }

    it("agrees with hitTest over the paper, which is nearly all of a sheet", () => {
      torn("s");
      layer.sync(scene, dirty, null);
      expect(layer.hitTest(scene, 0, 0)).toBe("s");
      expect(layer.inkHitTest(scene, 0, 0)).toBe("s");
    });

    it("stops at the paper, not the rectangle, along a torn edge", () => {
      torn("s");
      layer.sync(scene, dirty, null);
      const spot = inTheStrip("s");
      expect(spot, "a legal pad's torn head should recede somewhere").not.toBeNull();
      expect(layer.hitTest(scene, spot!.x, spot!.y)).toBe("s");
      expect(layer.inkHitTest(scene, spot!.x, spot!.y)).toBeNull();
    });

    it("carries on down the paint order — the strip is not a hole to the cork", () => {
      // THE reason this is a second walk. A photograph tucked under the torn
      // head of a legal pad is the arrangement this board is for, and a point
      // in the strip belongs to *it*, not to the cork. A filter on hitTest's
      // answer could only ever have said null here.
      torn("top", { z: "a5" });
      add("below", { type: "polaroid", z: "a0" }, { x: 0, y: 0, w: 400, h: 300 });
      layer.sync(scene, dirty, null);
      const spot = inTheStrip("top");
      expect(spot).not.toBeNull();
      expect(layer.hitTest(scene, spot!.x, spot!.y)).toBe("top");
      expect(layer.inkHitTest(scene, spot!.x, spot!.y)).toBe("below");
    });

    it("takes the whole rectangle of a photograph, which has no silhouette", () => {
      // A polaroid is a machine-cut border and has never asked `edge.ts` for
      // anything. Null from `silhouette` is the answer, not the absence of one.
      add("photo", { type: "polaroid" }, { x: 0, y: 0, w: 400, h: 300 });
      layer.sync(scene, dirty, null);
      for (const [x, y] of [
        [-199.5, 0],
        [199.5, 0],
        [0, -149.5],
        [0, 149.5],
      ]) {
        expect(layer.inkHitTest(scene, x!, y!)).toBe("photo");
      }
    });

    it("does not follow the paint below 35% zoom, or ink would depend on the camera", () => {
      // `PaperView.bind` drops the clip-path at the card tier because the
      // wander is sub-pixel there. If the boundary followed it, the same
      // gesture over the same spot would file ink on the item at 100% and on
      // the cork at 30% — the document depending on the view of it.
      torn("s");
      layer.sync(scene, dirty, null);
      const spot = inTheStrip("s");
      expect(spot).not.toBeNull();
      layer.setTier("card");
      layer.sync(scene, dirty, null);
      expect(layer.inkHitTest(scene, spot!.x, spot!.y)).toBeNull();
      expect(layer.hitTest(scene, spot!.x, spot!.y)).toBe("s");
    });

    it("hands the outline to the raster, so committed ink stops at the paper too", () => {
      // The wiring, and it is the half that fails silently: everything below
      // this line can be perfectly correct while the INK phase quietly passes
      // null and the pen and the paint disagree about every torn edge. The
      // mutation that replaces this argument with `null` breaks no other test.
      torn("s");
      add("photo", { type: "polaroid" }, { x: 500, y: 0, w: 400, h: 300 });
      layer.sync(scene, dirty, null);

      const raster = vi.spyOn(ItemInk.prototype, "update").mockImplementation(() => {});
      try {
        dirty.ink.add("s");
        dirty.ink.add("photo");
        layer.paintInk(scene, dirty);
        // Two rasters, and exactly one of them carries a polygon: the sheet.
        // A photograph is machine-cut and gets null, which is the answer.
        const outlines = raster.mock.calls.map((call) => call[4] ?? null);
        expect(outlines).toHaveLength(2);
        expect(outlines.filter((o) => o !== null)).toHaveLength(1);
        const sheet = outlines.find((o) => o !== null)!;
        expect(sheet.n).toBeGreaterThan(8);
        expect(sheet.points.length).toBe(sheet.n * 2);
      } finally {
        raster.mockRestore();
      }
    });

    it("re-cuts the silhouette when the sheet is resized", () => {
      // The polygon is percentages and offsets, so a resize moves it. A cache
      // keyed on the item alone would leave the pen stopping where the paper
      // used to end.
      torn("s");
      layer.sync(scene, dirty, null);
      const spot = inTheStrip("s");
      expect(spot).not.toBeNull();
      expect(layer.inkHitTest(scene, spot!.x, spot!.y)).toBeNull();

      // Twice as tall about the same centre: the head moves up and away, so
      // that same board point is now well inside the paper.
      scene.setPose("s", { h: 600 });
      dirty.item("s");
      layer.sync(scene, dirty, null);
      expect(layer.inkHitTest(scene, spot!.x, spot!.y)).toBe("s");
    });
  });

  it("ignores items that left the scene", () => {
    add("a");
    layer.sync(scene, dirty, null);
    scene.removeItem("a");
    expect(layer.hitTest(scene, 0, 0)).toBeNull();
  });
});

/**
 * The ink canvas: where it lives, when it exists, and when it goes.
 *
 * happy-dom has no 2D context, so `getContext("2d")` returns null and nothing
 * here can assert a pixel. What it *can* assert is the part that fails quietly:
 * which element the canvas is parented to, how big it is, and whether a pooled
 * node carries one item's marks onto the next.
 */
describe("ink", () => {
  function drawOn(id: string, size = 6, span = 40): void {
    const samples = [];
    for (let i = 0; i <= 10; i++) samples.push({ x: (i / 10) * span - span / 2, y: 0, pressure: 0.5 });
    scene.putStrokes(id, [
      {
        id: `${id}-s`,
        tool: "marker",
        color: "#1f1b17",
        size,
        opacity: 1,
        seed: 1,
        z: "a0",
        page: null,
        bbox: [-span / 2, 0, span / 2, 0],
        samples,
      },
    ]);
    dirty.inkFor(id);
  }

  function canvases(): HTMLCanvasElement[] {
    return [...host.querySelectorAll("canvas.item-ink")] as HTMLCanvasElement[];
  }

  it("gives an item with no ink no canvas at all", () => {
    add("a");
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);
    expect(canvases()).toHaveLength(0);
    expect(layer.inked).toBe(0);
  });

  /**
   * The clipping regression, and it is invisible in happy-dom any other way:
   * `.pol-window` and `.paper-surface` are `overflow: hidden`, so a canvas
   * parented into either would crop ink that runs off the edge of the paper.
   */
  it("hangs the canvas off the item root, not off anything that clips", () => {
    add("a");
    drawOn("a");
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);

    const canvas = canvases()[0]!;
    expect(canvas.parentElement!.classList.contains("item")).toBe(true);
    expect(canvas.parentElement!.querySelector(".pol-window")).not.toBeNull();
  });

  it("sizes the backing store to the ink and in powers of two", () => {
    add("a", {}, { w: 400, h: 400 });
    drawOn("a", 6, 40);
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);

    const canvas = canvases()[0]!;
    expect(canvas.width & (canvas.width - 1)).toBe(0);
    expect(canvas.height & (canvas.height - 1)).toBe(0);
    // Sized to the ink, not the item: a 40-unit stroke on a 400-unit sheet.
    expect(parseFloat(canvas.style.width)).toBeLessThan(400);
  });

  it("grows for a stroke that runs further, and does not shrink back", () => {
    add("a", {}, { w: 4000, h: 4000 });
    drawOn("a", 6, 40);
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);
    const small = canvases()[0]!.width;

    drawOn("a", 6, 3000);
    layer.paintInk(scene, dirty);
    const large = canvases()[0]!.width;
    expect(large).toBeGreaterThan(small);

    drawOn("a", 6, 40);
    layer.paintInk(scene, dirty);
    // Eviction reclaims the pixels when the item leaves; shrinking here would
    // re-sample every remaining stroke to save memory that is about to go anyway.
    expect(canvases()[0]!.width).toBe(large);
  });

  it("drops the canvas when the last stroke is erased", () => {
    add("a");
    drawOn("a");
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);
    expect(layer.inked).toBe(1);

    scene.putStrokes("a", []);
    dirty.inkFor("a");
    layer.paintInk(scene, dirty);
    // An item that stays mounted and loses its ink would otherwise go on
    // showing it.
    expect(canvases()).toHaveLength(0);
    expect(layer.inked).toBe(0);
  });

  it("evicts the canvas when the item leaves the viewport, and re-rasters on return", () => {
    add("a");
    drawOn("a");
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);
    expect(layer.inked).toBe(1);
    expect(layer.inkPixels).toBeGreaterThan(0);

    dirty.item("a");
    layer.sync(scene, dirty, new Set());
    expect(layer.inked).toBe(0);
    expect(layer.inkPixels).toBe(0);
    expect(canvases()).toHaveLength(0);

    dirty.item("a");
    layer.sync(scene, dirty, new Set(["a"]));
    layer.paintInk(scene, dirty);
    // Strokes are the truth and the canvas is a cache, so coming back is a
    // re-raster and not a restore.
    expect(layer.inked).toBe(1);
  });

  /** The same bug the photograph's `release()` already guards against: a pooled
   *  node keeps its subtree, so it would sit there wearing the last item's marks. */
  it("does not carry one item's ink onto the next item in the pooled node", () => {
    add("a");
    drawOn("a");
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);
    expect(layer.inked).toBe(1);

    scene.removeItem("a");
    dirty.item("a");
    layer.sync(scene, dirty, null);

    add("b");
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);
    expect(canvases()).toHaveLength(0);
    expect(layer.inked).toBe(0);
  });

  it("re-rasters only a few items a frame, and finishes the rest on the next", () => {
    for (const id of ["a", "b", "c", "d", "e"]) {
      add(id);
      drawOn(id);
    }
    layer.sync(scene, dirty, null);

    // Without a budget, one debounced zoom-end repaints every ink canvas on
    // screen inside one frame — the shape of the 777 ms frame D-12 measured.
    layer.paintInk(scene, dirty);
    expect(layer.inked).toBe(3);
    layer.paintInk(scene, dirty);
    expect(layer.inked).toBe(5);
  });

  it("queues every mounted inked item when the whole board is dirty", () => {
    for (const id of ["a", "b"]) {
      add(id);
      drawOn(id);
    }
    layer.sync(scene, dirty, null);
    dirty.clear();

    // What `world.onRasterize` raises on a debounced gesture end.
    dirty.everything();
    layer.paintInk(scene, dirty);
    expect(layer.inked).toBe(2);
  });

  it("drops ink dirt for an item nobody has mounted", () => {
    add("a");
    drawOn("a");
    // Never synced, so there is no node and nothing to be stale.
    layer.paintInk(scene, dirty);
    expect(layer.inked).toBe(0);
  });

  /**
   * T-63. The re-raster is the same bitmap at a different resolution, and the
   * two assertions below are the two halves of that sentence: more device
   * pixels, over the same item-local box.
   *
   * The second is what makes the interim a *stretch* rather than a jump. The
   * canvas's CSS size is in the item's own units, so a canvas that has not been
   * repainted yet is displayed at exactly the size it always was and the browser
   * scales the pixels it has — which is what DESIGN section 9.3 asks for while
   * `paintInk`'s budget works through the board.
   */
  /**
   * T-136 in the DOM half: the canvas covers the overlap of the ink and the
   * paper, so a stroke that ran off the edge costs no pixels for the part that
   * cannot be drawn — and a resize has to re-raster, because the clip is a
   * function of a size that just changed.
   */
  it("sizes the canvas to the paper, not to ink that ran off it", () => {
    add("a", {}, { w: 200, h: 200 });
    drawOn("a", 6, 3000);
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);

    // A 3000-unit stroke on a 200-unit sheet. Sized to the ink, this is a 4096px
    // backing store; sized to the overlap it is a fraction of that.
    expect(canvases()[0]!.width).toBeLessThanOrEqual(512);
  });

  it("re-rasters an inked item that was resized, and only that", () => {
    add("a", {}, { w: 200, h: 200 });
    drawOn("a", 6, 1000);
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);
    const small = canvases()[0]!.width;
    dirty.clear();

    // Dragged wider: the paper gives back the ink its old edge was hiding.
    scene.setPose("a", { w: 1200 });
    dirty.item("a");
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);
    expect(canvases()[0]!.width).toBeGreaterThan(small);

    // And a move is not a resize: the INK phase stays asleep while a photograph
    // is carried, which is what the whole per-item canvas buys.
    dirty.clear();
    scene.setPose("a", { x: 900 });
    dirty.item("a");
    const before = canvases()[0]!.width;
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);
    expect(canvases()[0]!.width).toBe(before);
  });

  /**
   * DESIGN 6.6's last clause for the card tier: "ink renders at quarter
   * resolution". A quarter of the linear scale, so a sixteenth of the pixels —
   * and because the backing store rounds up to a power of two, the tier is often
   * the difference between a 2048-square bitmap and a 128-square one.
   */
  it("rasters ink at a quarter of the scale below the boundary", () => {
    add("a");
    drawOn("a");
    layer.setRasterScale(4);
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);
    const canvas = canvases()[0]!;
    const full = canvas.width;
    const box = canvas.style.width;

    layer.setTier("card");
    dirty.everything();
    layer.paintInk(scene, dirty);
    expect(canvas.width).toBeLessThan(full);
    // The CSS box does not move: this is a resolution, not a size. A stretched
    // bitmap is the whole point — it is what makes the tier free.
    expect(canvas.style.width).toBe(box);

    layer.setTier("full");
    dirty.everything();
    layer.paintInk(scene, dirty);
    expect(canvas.width).toBe(full);
  });

  it("spends more device pixels on the same ink when the board zooms in", () => {
    add("a");
    drawOn("a");
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);
    const canvas = canvases()[0]!;
    const before = canvas.width;
    const box = canvas.style.width;

    // What `World.onRasterize` hands over on a settled camera at 2x.
    layer.setRasterScale(2);
    dirty.everything();
    layer.paintInk(scene, dirty);

    expect(canvas.width).toBeGreaterThan(before);
    expect(canvas.style.width).toBe(box);
  });

  /**
   * The wet/dry handoff's signal (T-58). The marker goes on drawing a committed
   * stroke on the overlay until this says the bitmap has caught up, so an answer
   * that is wrong in the true direction leaves the mark drawn twice for a frame
   * and one that is wrong in the false direction is the blink the whole
   * arrangement exists to avoid.
   */
  describe("awaitingInk", () => {
    it("is true from the commit until the raster, and false after it", () => {
      add("a");
      layer.sync(scene, dirty, null);
      expect(layer.awaitingInk("a")).toBe(false);

      drawOn("a");
      // Queued but not painted: dirty.ink alone is not an answer, because the
      // budget below can leave it queued for frames.
      expect(layer.awaitingInk("a")).toBe(false);
      layer.paintInk(scene, dirty);
      expect(layer.awaitingInk("a")).toBe(false);
    });

    it("stays true for an item the budget did not reach this frame", () => {
      for (const id of ["a", "b", "c", "d", "e"]) {
        add(id);
        drawOn(id);
      }
      layer.sync(scene, dirty, null);
      layer.paintInk(scene, dirty);

      // Three of the five were painted; the other two are still waiting, and a
      // handoff counting frames instead would have dropped their overlay copies
      // a frame before their ink appeared.
      const waiting = ["a", "b", "c", "d", "e"].filter((id) => layer.awaitingInk(id));
      expect(waiting).toHaveLength(2);

      // Phase 9 clears the dirty sets; the two left over survive in this layer's
      // own queue, which is the whole reason it has one.
      dirty.clear();
      layer.paintInk(scene, dirty);
      expect(["a", "b", "c", "d", "e"].some((id) => layer.awaitingInk(id))).toBe(false);
    });

    it("is false for a queued item the viewport has since taken away", () => {
      for (const id of ["a", "b", "c", "d", "e"]) {
        add(id);
        drawOn(id);
      }
      layer.sync(scene, dirty, null);
      layer.paintInk(scene, dirty);
      dirty.clear();

      const left = ["a", "b", "c", "d", "e"].find((id) => layer.awaitingInk(id))!;
      // The item is culled while its re-raster is still queued — which is the
      // one way an id in the queue stops having a node. Nothing is going to
      // appear where it was, so nothing is worth waiting for and the marker's
      // overlay copy stops now rather than hanging on the board forever.
      for (const id of ["a", "b", "c", "d", "e"]) dirty.item(id);
      layer.sync(scene, dirty, new Set(["a", "b", "c", "d", "e"].filter((id) => id !== left)));
      expect(layer.awaitingInk(left)).toBe(false);
    });
  });

  it("frees every backing store on teardown", () => {
    add("a");
    drawOn("a");
    layer.sync(scene, dirty, null);
    layer.paintInk(scene, dirty);

    layer.destroy();
    expect(layer.inked).toBe(0);
    expect(document.querySelectorAll("canvas.item-ink")).toHaveLength(0);
  });
});

describe("undeveloped film", () => {
  /**
   * A layer whose asset state the test drives, because that is the whole point:
   * none of these transitions is a document write, so nothing in the scene
   * changes across any of them (DESIGN 7.5, DATA-MODEL section 10).
   */
  function film(): { set: (view: AssetView) => void; layer: DomItemLayer; item: HTMLElement } {
    let view: AssetView = { url: "", phase: "unknown", fraction: 0 };
    const layer = new DomItemLayer(host, () => view);
    // Comfortably over EMERGE_MIN_PX, so the develop tests below are testing
    // what they say they are and not the size floor.
    add("a", { assetId: "abc" }, { w: 300, h: 300 });
    layer.sync(scene, dirty, null);
    return {
      layer,
      item: host.querySelector(".item-polaroid") as HTMLElement,
      set: (next) => {
        view = next;
        dirty.clear();
        dirty.item("a");
        layer.sync(scene, dirty, null);
      },
    };
  }

  it("shows blank film for an asset nobody has mentioned", () => {
    const { item, layer } = film();
    expect(item.classList.contains("is-waiting")).toBe(true);
    expect(item.classList.contains("is-developing")).toBe(false);
    expect(item.classList.contains("is-torn")).toBe(false);
    layer.destroy();
  });

  it("develops as the chunks land, though the document never changes", () => {
    // The regression this whole change is about: every phase short of `ready`
    // resolves to the same empty URL, so a layer guarding on the URL alone sees
    // no difference between film that is blank and film that is half developed.
    const { item, set, layer } = film();
    set({ url: "", phase: "transferring", fraction: 0.42 });
    expect(item.classList.contains("is-developing")).toBe(true);
    expect(item.style.getPropertyValue("--develop")).toBe("42%");

    set({ url: "", phase: "transferring", fraction: 0.77 });
    expect(item.style.getPropertyValue("--develop")).toBe("77%");
    layer.destroy();
  });

  it("tears a photograph nobody on the board has, and stops developing it", () => {
    const { item, set, layer } = film();
    set({ url: "", phase: "transferring", fraction: 0.3 });
    set({ url: "", phase: "unavailable", fraction: 0 });
    expect(item.classList.contains("is-torn")).toBe(true);
    expect(item.classList.contains("is-developing")).toBe(false);
    // A stale wash height would still be driving the gradient the torn rule
    // paints over.
    expect(item.style.getPropertyValue("--develop")).toBe("");
    layer.destroy();
  });

  it("un-tears when a peer that holds it turns up", () => {
    // `state/assets.ts` makes `unavailable` sticky against a re-request and
    // clears it only when bytes actually move, so this is what the person sees
    // the moment the holder joins: the tear closes and the picture comes up.
    const { item, set, layer } = film();
    set({ url: "", phase: "unavailable", fraction: 0 });
    set({ url: "", phase: "transferring", fraction: 0.1 });
    expect(item.classList.contains("is-torn")).toBe(false);
    expect(item.classList.contains("is-developing")).toBe(true);
    layer.destroy();
  });

  it("keeps the film on until there are pixels, not until the bytes land", () => {
    // `ready` is a fact about the disk. There is a decode between it and
    // anything appearing in the window, and blanking the film for those frames
    // would flash the bare backing.
    const { item, set, layer } = film();
    set({ url: "", phase: "transferring", fraction: 0.9 });
    set({ url: "asset://sha256/abc", phase: "ready", fraction: 0 });
    expect(item.classList.contains("is-developing")).toBe(false);
    expect(item.classList.contains("is-waiting")).toBe(true);

    const img = host.querySelector(".pol-photo") as HTMLImageElement;
    img.dispatchEvent(new Event("load"));
    expect(item.classList.contains("is-waiting")).toBe(false);
    layer.destroy();
  });

  it("tears a photograph that is on this disk and will not decode", () => {
    // Not "waiting": the bytes arrived. A file that is present and broken is a
    // photograph that is not coming, which is what the tear says.
    const { item, set, layer } = film();
    set({ url: "asset://sha256/abc", phase: "ready", fraction: 0 });
    const img = host.querySelector(".pol-photo") as HTMLImageElement;
    img.dispatchEvent(new Event("error"));
    expect(item.classList.contains("is-torn")).toBe(true);
    expect(item.classList.contains("is-waiting")).toBe(true);
    layer.destroy();
  });

  it("does not hand a recycled node the last item's tear", () => {
    // The tear has two ways on, and only one of them is a phase. A decode that
    // failed is invisible to `paintFilm`'s guard, so a node torn by a broken
    // file and pooled would carry the tear onto whatever it is recycled onto —
    // and both items being `ready` is exactly what stops anything repainting it.
    let view: AssetView = { url: "asset://sha256/abc", phase: "ready", fraction: 0 };
    const layer = new DomItemLayer(host, () => view);
    add("a", { assetId: "abc" });
    layer.sync(scene, dirty, null);
    const first = host.querySelector(".item-polaroid") as HTMLElement;
    (host.querySelector(".pol-photo") as HTMLImageElement).dispatchEvent(new Event("error"));
    expect(first.classList.contains("is-torn")).toBe(true);

    dirty.clear();
    scene.removeItem("a");
    dirty.item("a");
    layer.sync(scene, dirty, null);

    dirty.clear();
    view = { url: "asset://sha256/def", phase: "ready", fraction: 0 };
    add("b", { assetId: "def" });
    layer.sync(scene, dirty, null);
    const item = host.querySelector(".item-polaroid") as HTMLElement;
    expect(item).toBe(first);
    expect(item.classList.contains("is-torn")).toBe(false);
    layer.destroy();
  });

  it("re-dresses a recycled node even when the new item is in the same state", () => {
    // The other half of the recycling problem, and the one that decides which
    // of the two things `release` does is load-bearing. Sweeping the classes off
    // a released node is not enough on its own: the next item to get that node
    // is very often in the *same* phase — a viewport full of one board's worth
    // of arriving photographs is exactly that — and `paintFilm` would look at a
    // phase that matches the one it last painted and decline to paint anything.
    // The node would come back stripped and never be dressed again.
    const view: AssetView = { url: "", phase: "transferring", fraction: 0.6 };
    const layer = new DomItemLayer(host, () => view);
    add("a", { assetId: "abc" });
    layer.sync(scene, dirty, null);
    expect(host.querySelector(".item-polaroid")!.classList.contains("is-developing")).toBe(true);

    dirty.clear();
    scene.removeItem("a");
    dirty.item("a");
    layer.sync(scene, dirty, null);

    dirty.clear();
    add("b", { assetId: "def" });
    layer.sync(scene, dirty, null);
    const item = host.querySelector(".item-polaroid") as HTMLElement;
    expect(item.classList.contains("is-developing")).toBe(true);
    expect(item.style.getPropertyValue("--develop")).toBe("60%");
    layer.destroy();
  });

  it("gives each waiting photograph its own crystals", () => {
    // One shared grain tile, offset per item — twenty blank films showing the
    // identical speckle read as one repeated texture rather than as twenty
    // pieces of film.
    const layer = new DomItemLayer(host, () => ({ url: "", phase: "requesting", fraction: 0 }));
    add("a", { assetId: "abc", seed: 11 }, { x: -200 });
    add("b", { assetId: "abc", seed: 12 }, { x: 200 });
    layer.sync(scene, dirty, null);
    const films = [...host.querySelectorAll<HTMLElement>(".pol-film")];
    expect(films).toHaveLength(2);
    expect(films[0]!.style.backgroundPosition).not.toBe("");
    expect(films[0]!.style.backgroundPosition).not.toBe(films[1]!.style.backgroundPosition);
    layer.destroy();
  });

  /**
   * The print coming up (T-174).
   *
   * Everything here turns on one question — has this item's photograph ever been
   * on this screen — and every test below is a way of getting that question
   * wrong. Nothing checks what the animation looks like: that is a stylesheet,
   * and happy-dom runs no animations, which is also why the class only ever
   * comes off by hand in here.
   */
  function landed(): { item: HTMLElement; img: HTMLImageElement } {
    return {
      item: host.querySelector(".item-polaroid") as HTMLElement,
      img: host.querySelector(".pol-photo") as HTMLImageElement,
    };
  }

  it("brings the print up out of the emulsion when it first lands", () => {
    const { item, set, layer } = film();
    set(ready("asset://sha256/abc"));
    expect(item.classList.contains("is-waiting")).toBe(true);
    expect(item.classList.contains("is-emerging")).toBe(false);

    landed().img.dispatchEvent(new Event("load"));
    expect(item.classList.contains("is-waiting")).toBe(false);
    expect(item.classList.contains("is-emerging")).toBe(true);
    // The stagger, so a viewport of photographs arriving together is a scatter
    // rather than one flash.
    expect(item.style.getPropertyValue("--emerge-delay")).toMatch(/^\d+ms$/);
    layer.destroy();
  });

  it("takes the emulsion off when the print has come up", () => {
    const { item, set, layer } = film();
    set(ready("asset://sha256/abc"));
    const { img } = landed();
    img.dispatchEvent(new Event("load"));
    img.dispatchEvent(new Event("animationend"));
    expect(item.classList.contains("is-emerging")).toBe(false);
    layer.destroy();
  });

  it("does not develop a photograph a second time", () => {
    // The one this feature lives or dies by. Culling unmounts an item that
    // leaves the viewport and mounts it again when it comes back, and the
    // cached `<img>` fires `load` again on the way in — so a develop keyed on
    // "was it waiting a moment ago" would fade every photograph up afresh every
    // time the board was panned.
    const layer = new DomItemLayer(host, (sha) => ready(`asset://sha256/${sha}`));
    add("a", { assetId: "abc" }, { w: 300, h: 300 });
    layer.sync(scene, dirty, null);
    landed().img.dispatchEvent(new Event("load"));
    expect(landed().item.classList.contains("is-emerging")).toBe(true);

    dirty.clear();
    dirty.item("a");
    layer.sync(scene, dirty, new Set());
    expect(layer.mounted).toBe(0);

    dirty.clear();
    dirty.item("a");
    layer.sync(scene, dirty, new Set(["a"]));
    landed().img.dispatchEvent(new Event("load"));
    expect(landed().item.classList.contains("is-emerging")).toBe(false);
    expect(landed().item.classList.contains("is-waiting")).toBe(false);
    layer.destroy();
  });

  it("does not develop a variant swap", () => {
    // A zoom that crosses a variant boundary re-points the `<img>` at a sharper
    // copy of a picture that is already on the screen, and its `load` arrives
    // here like any other. The photograph has been seen; nothing may fade it up
    // again, or a board would blink every time it was zoomed past 200%.
    const { item, set, layer } = film();
    set(ready("asset://sha256/abc"));
    const { img } = landed();
    img.dispatchEvent(new Event("load"));
    img.dispatchEvent(new Event("animationend"));

    img.dispatchEvent(new Event("load"));
    expect(item.classList.contains("is-emerging")).toBe(false);
    layer.destroy();
  });

  it("abandons a develop when the film goes back on", () => {
    // Waiting and emerging are the same square inch of the item, and a
    // photograph that has gone back to being missing must not have a develop
    // still fading it up over the blank film.
    const { item, set, layer } = film();
    set(ready("asset://sha256/abc"));
    landed().img.dispatchEvent(new Event("load"));
    expect(item.classList.contains("is-emerging")).toBe(true);

    set({ url: "", phase: "unavailable", fraction: 0 });
    expect(item.classList.contains("is-emerging")).toBe(false);
    expect(item.classList.contains("is-torn")).toBe(true);
    layer.destroy();
  });

  it("drops a develop when the file turns out not to decode", () => {
    const { item, set, layer } = film();
    set(ready("asset://sha256/abc"));
    const { img } = landed();
    img.dispatchEvent(new Event("load"));
    img.dispatchEvent(new Event("error"));
    expect(item.classList.contains("is-emerging")).toBe(false);
    expect(item.classList.contains("is-torn")).toBe(true);
    layer.destroy();
  });

  it("does not hand a recycled node a develop in flight", () => {
    // A node pooled mid-develop would otherwise fade the next item's photograph
    // up from nothing, having already spent that item's first sight on it.
    let view: AssetView = ready("asset://sha256/abc");
    const layer = new DomItemLayer(host, () => view);
    add("a", { assetId: "abc" }, { w: 300, h: 300 });
    layer.sync(scene, dirty, null);
    const first = landed();
    first.img.dispatchEvent(new Event("load"));
    expect(first.item.classList.contains("is-emerging")).toBe(true);

    dirty.clear();
    scene.removeItem("a");
    dirty.item("a");
    layer.sync(scene, dirty, null);

    dirty.clear();
    view = ready("asset://sha256/def");
    add("b", { assetId: "def" }, { w: 300, h: 300 });
    layer.sync(scene, dirty, null);
    const item = host.querySelector(".item-polaroid") as HTMLElement;
    expect(item).toBe(first.item);
    expect(item.classList.contains("is-emerging")).toBe(false);
    expect(item.style.getPropertyValue("--emerge-delay")).toBe("");
    layer.destroy();
  });

  it("does not develop a photograph too small to watch, and does not save it up", () => {
    // The bound that bites: a board zoomed out to a wall of stamps has every
    // photograph on it landing at once, and at that size there is no picture to
    // come up. Driven on 300 fitted polaroids with no floor, developing them
    // cost p99 frame time 28 ms -> 83 ms and a third of the frames in the four
    // seconds after boot; below the floor it costs nothing, because nothing
    // runs. See EMERGE_MIN_PX for the numbers either side.
    const layer = new DomItemLayer(host, (sha) => ready(`asset://sha256/${sha}`));
    add("a", { assetId: "abc" }, { w: 60, h: 60 });
    layer.sync(scene, dirty, null);
    landed().img.dispatchEvent(new Event("load"));
    expect(landed().item.classList.contains("is-emerging")).toBe(false);
    expect(landed().item.classList.contains("is-waiting")).toBe(false);

    // And the first sight was spent on it. Zooming in on a photograph that has
    // been on the board for an hour must not develop it — that would be a board
    // that brings things up at random, long after they arrived.
    dirty.clear();
    dirty.item("a");
    layer.setRasterScale(8);
    layer.sync(scene, dirty, null);
    landed().img.dispatchEvent(new Event("load"));
    expect(landed().item.classList.contains("is-emerging")).toBe(false);
    layer.destroy();
  });

  it("develops both prints of one photograph, and staggers them apart", () => {
    // Keyed by item and not by hash. Pasting a picture twice makes two items and
    // one asset, and watching one of them come up is not having seen the other.
    const layer = new DomItemLayer(host, (sha) => ready(`asset://sha256/${sha}`));
    add("a", { assetId: "abc", seed: 11 }, { x: -400, w: 300, h: 300 });
    add("b", { assetId: "abc", seed: 12 }, { x: 400, w: 300, h: 300 });
    layer.sync(scene, dirty, null);
    const items = [...host.querySelectorAll<HTMLElement>(".item-polaroid")];
    for (const img of host.querySelectorAll(".pol-photo")) img.dispatchEvent(new Event("load"));

    expect(items.map((el) => el.classList.contains("is-emerging"))).toEqual([true, true]);
    expect(items[0]!.style.getPropertyValue("--emerge-delay")).not.toBe(
      items[1]!.style.getPropertyValue("--emerge-delay"),
    );
    layer.destroy();
  });
});

describe("paper curl at unpinned corners", () => {
  /** The four custom properties on the one mounted sheet, in `curl.ts` order. */
  function written(): string[] {
    const sheet = host.querySelector<HTMLElement>(".item-paper")!;
    return ["--curl-tl", "--curl-tr", "--curl-br", "--curl-bl"].map((prop) =>
      sheet.style.getPropertyValue(prop),
    );
  }

  function pin(id: string, lx: number, ly: number): void {
    scene.putPin({ id, parent: null, lx, ly, kind: "pushpin", color: "#f00", page: null, wx: 0, wy: 0 });
  }

  it("curls every corner of a sheet nothing is holding", () => {
    add("a", { type: "note" }, { w: 240, h: 190 });
    layer.sync(scene, dirty, null);
    expect(written()).toEqual(["1.00", "1.00", "1.00", "1.00"]);
  });

  it("flattens a corner on a frame where only a pin moved", () => {
    // The gate this is really testing is in `sync`. A pin dragged onto a still
    // sheet touches `dirty.pins` and nothing else — the sheet is not dirty, its
    // pose has not changed, and `place` would have had no reason to look.
    add("a", { type: "note" }, { w: 240, h: 190 });
    pin("p", 600, 600);
    layer.sync(scene, dirty, null);
    expect(written()[0]).toBe("1.00");

    dirty.clear();
    scene.putPin({
      id: "p",
      parent: null,
      lx: -110,
      ly: -85,
      kind: "pushpin",
      color: "#f00",
      page: null,
      wx: 0,
      wy: 0,
    });
    dirty.pin("p");
    layer.sync(scene, dirty, null);
    // The bottom left is 180 units below the pin and not quite gone; the two on
    // the far side are past the reach entirely.
    expect(written()).toEqual(["0.00", "1.00", "1.00", "0.90"]);
  });

  it("leaves the curl alone when only the camera moved", () => {
    // A pan changes nothing about which pins hold which sheets, so the walk that
    // asks is skipped — and the properties already written must survive it.
    add("a", { type: "note" }, { w: 240, h: 190 });
    pin("p", -110, -85);
    layer.sync(scene, dirty, null);
    dirty.clear();
    dirty.camera = true;
    layer.sync(scene, dirty, null);
    // The bottom left is 180 units below the pin and not quite gone; the two on
    // the far side are past the reach entirely.
    expect(written()).toEqual(["0.00", "1.00", "1.00", "0.90"]);
  });

  it("hands a recycled node no memory of the last sheet's corners", () => {
    add("a", { type: "note" }, { w: 240, h: 190 });
    layer.sync(scene, dirty, null);
    expect(written()[0]).toBe("1.00");

    // Cull it away, which pools the node, and bring a fully pinned sheet back on
    // the same one.
    dirty.clear();
    dirty.item("a");
    layer.sync(scene, dirty, new Set());
    expect(host.querySelector(".item-paper")).toBeNull();

    scene.removeItem("a");
    add("b", { type: "note" }, { w: 240, h: 190 });
    for (const [i, at] of [
      [-110, -85],
      [110, -85],
      [110, 85],
      [-110, 85],
    ].entries()) {
      pin(`p${i}`, at[0]!, at[1]!);
    }
    layer.sync(scene, dirty, null);
    expect(written()).toEqual(["0.00", "0.00", "0.00", "0.00"]);
  });

  it("does not curl a polaroid", () => {
    add("a");
    layer.sync(scene, dirty, null);
    const item = host.querySelector<HTMLElement>(".item-polaroid")!;
    expect(item.style.getPropertyValue("--curl-tl")).toBe("");
  });
});

describe("tape", () => {
  /** A seed that is taped when nothing else is holding the sheet. */
  const TAPED = (() => {
    for (let seed = 1; seed < 1000; seed++) if (tapedCorners(seed, 0) !== 0) return seed;
    throw new Error("no seed is taped");
  })();

  function strips(mask: number): number {
    let n = 0;
    for (let i = 0; i < 4; i++) if (mask & (1 << i)) n++;
    return n;
  }

  function showing(): number {
    return [...host.querySelectorAll<HTMLElement>(".item-tape")].filter(
      (el) => el.style.display === "block",
    ).length;
  }

  it("tapes a sheet nothing else is holding", () => {
    add("a", { type: "note", seed: TAPED }, { w: 240, h: 190 });
    layer.sync(scene, dirty, null);
    expect(showing()).toBe(strips(tapedCorners(TAPED, 0)));
  });

  it("takes the tape off the moment a pin goes through it", () => {
    // Tape and a pin are alternatives, not layers. And the frame this arrives on
    // touches `dirty.pins` and nothing else — the sheet is not dirty and its
    // pose has not changed — which is the same gate the curl needed.
    add("a", { type: "note", seed: TAPED }, { w: 240, h: 190 });
    layer.sync(scene, dirty, null);
    expect(showing()).toBeGreaterThan(0);

    dirty.clear();
    scene.putPin({
      id: "p",
      parent: null,
      lx: 0,
      ly: 0,
      kind: "pushpin",
      color: "#f00",
      page: null,
      wx: 0,
      wy: 0,
    });
    dirty.pin("p");
    layer.sync(scene, dirty, null);
    expect(showing()).toBe(0);
  });

  it("gives a recycled node no memory of the last item's strips", () => {
    add("a", { type: "note", seed: TAPED }, { w: 240, h: 190 });
    layer.sync(scene, dirty, null);
    expect(showing()).toBeGreaterThan(0);

    dirty.clear();
    dirty.item("a");
    layer.sync(scene, dirty, new Set());
    scene.removeItem("a");
    // Seed 1 is not taped, and it comes back on the node the taped one left.
    expect(tapedCorners(1, 0)).toBe(0);
    add("b", { type: "note", seed: 1 }, { w: 240, h: 190 });
    layer.sync(scene, dirty, null);
    expect(showing()).toBe(0);
  });
});
describe("ageing", () => {
  const DAY = 86400000;
  /** The real clock (Q-105): how long ago, in days, the item was made. */
  const wallClock = (cold: ItemCold): number => (Date.now() - cold.createdAt) / DAY;

  function sheet(): HTMLElement {
    return host.querySelector<HTMLElement>(".item-paper")!;
  }

  it("leaves a board with nothing old on it entirely alone", () => {
    // The default clock, and the whole cost of this feature on a new board: one
    // class that is not added. Every wear layer is `display: none` behind it.
    add("a", { type: "note", createdAt: Date.now() }, { w: 240, h: 190 });
    layer.sync(scene, dirty, null);
    expect(sheet().classList.contains("is-aged")).toBe(false);
    expect(sheet().style.getPropertyValue("--age")).toBe("");
  });

  it("wears a sheet that has been up for years", () => {
    layer.setAgeClock(wallClock);
    add("a", { type: "note", seed: 49, createdAt: Date.now() - 1500 * DAY }, { w: 240, h: 190 });
    layer.sync(scene, dirty, null);
    const el = sheet();
    expect(el.classList.contains("is-aged")).toBe(true);
    expect(Number(el.style.getPropertyValue("--age"))).toBeGreaterThan(0.9);
    // Seed 49 is folded and its fold is very nearly horizontal, so it also
    // exercises the property `transform` writes rather than `bind`.
    expect(Number(el.style.getPropertyValue("--crease"))).toBeGreaterThan(0);
    expect(el.style.getPropertyValue("--crease-rot")).toMatch(/deg$/);
    expect(el.style.getPropertyValue("--crease-face")).not.toBe("");
  });

  /**
   * The switch, from the renderer's side (DESIGN section 4.7). Turning ageing
   * off is a clock on which nothing is older than this morning, and it has to
   * take the marks back off sheets that are already wearing them — a board that
   * only stopped ageing *newly mounted* items would be worse than one that never
   * stopped at all.
   */
  it("takes it all back off when the clock is turned off", () => {
    layer.setAgeClock(wallClock);
    add("a", { type: "note", seed: 49, createdAt: Date.now() - 1500 * DAY }, { w: 240, h: 190 });
    layer.sync(scene, dirty, null);
    expect(sheet().classList.contains("is-aged")).toBe(true);

    layer.setAgeClock(() => 0);
    dirty.clear();
    dirty.everything();
    layer.sync(scene, dirty, null);
    expect(sheet().classList.contains("is-aged")).toBe(false);
    for (const prop of ["--age", "--crease", "--stain", "--crease-rot"]) {
      expect(sheet().style.getPropertyValue(prop)).toBe("");
    }
  });

  it("fades the print's frame and not the shadow it casts", () => {
    layer.setAgeClock(wallClock);
    add("a", { createdAt: Date.now() - 1500 * DAY });
    layer.sync(scene, dirty, null);
    const item = host.querySelector<HTMLElement>(".item-polaroid")!;
    expect(item.classList.contains("is-aged")).toBe(true);
    expect(item.querySelector<HTMLElement>(".pol-frame")!.style.filter).toMatch(/saturate\(0\./);
    // The item's own filter is the per-sheet tint and has nothing to do with age.
    expect(item.style.filter).not.toMatch(/sepia/);
    expect(item.querySelector<HTMLElement>(".item-shadow")!.style.filter).toBe("");
  });

  it("gives a recycled node no memory of the last item's years", () => {
    // The bug this whole class of test exists for: a pooled node keeps its
    // subtree and its inline style, so a fresh note landing on the node an
    // ancient one left would arrive already yellowed.
    layer.setAgeClock(wallClock);
    add("a", { type: "note", seed: 49, createdAt: Date.now() - 1500 * DAY }, { w: 240, h: 190 });
    layer.sync(scene, dirty, null);
    expect(sheet().classList.contains("is-aged")).toBe(true);

    dirty.clear();
    dirty.item("a");
    layer.sync(scene, dirty, new Set());
    scene.removeItem("a");
    add("b", { type: "note", seed: 49, createdAt: Date.now() }, { w: 240, h: 190 });
    layer.sync(scene, dirty, null);
    expect(sheet().classList.contains("is-aged")).toBe(false);
    expect(sheet().style.getPropertyValue("--stain")).toBe("");
  });

  /**
   * Dog-ears — T-190, and the one mark on DESIGN 4.7's list that is not paint.
   *
   * The others are a class and a custom property and everything else is
   * `items.css`. This one changes the *shape* of the sheet, so there is a second
   * thing to get wrong: the silhouette is no longer a function of the cold item
   * alone, and `bind`'s guard has to know that.
   */
  describe("dog-ears", () => {
    /** A seed whose corner is turned over on a board this old, and one whose is not. */
    const FOLDED = (() => {
      for (let seed = 1; seed < 500; seed++) if (dogEarOf(seed, 1).amount > 0) return seed;
      throw new Error("no seed folds");
    })();
    const PLAIN = (() => {
      for (let seed = 1; seed < 500; seed++) if (dogEarOf(seed, 1).amount === 0) return seed;
      throw new Error("every seed folds");
    })();

    function note(seed: number, age = 1500 * DAY): void {
      add("a", { type: "note", seed, createdAt: Date.now() - age }, { w: 240, h: 190 });
    }

    it("cuts the corner out of the silhouette and hangs the flap on it", () => {
      layer.setAgeClock(wallClock);
      note(FOLDED);
      layer.sync(scene, dirty, null);
      const el = sheet();
      const corner = dogEarOf(FOLDED, 1).corner;
      expect(el.dataset["ear"]).toBe(["tl", "tr", "br", "bl"][corner]);
      expect(el.style.getPropertyValue("--ear")).toMatch(/^\d+\.\d%$/);
      // The flap needs an opaque paper colour: it is the *back* of this sheet,
      // and a translucent one would let the ruling through.
      expect(el.style.getPropertyValue("--stock-base")).not.toBe("");
      expect(el.querySelector(".paper-ear")).not.toBeNull();
      // And the cut itself. A corner of the paper is the one kind of point whose
      // coordinates are both lengths — every other vertex is a position *along*
      // an edge — so a sheet with a corner cut off has three of them and not four.
      const square = (item: HTMLElement): number =>
        item
          .querySelector<HTMLElement>(".paper-surface")!
          .style.clipPath.slice(8, -1)
          .split(/,\s*(?![^(]*\))/)
          // `calc(100% - 3px)` is a length measured from the far side, not a
          // position along an edge — collapsed first so its `100%` cannot be
          // mistaken for one.
          .filter(
            (pair) =>
              !pair
                .replace(/calc\([^)]*\)/g, "L")
                .trim()
                .split(/\s+/)
                .some((coord) => coord.endsWith("%")),
          ).length;
      expect(square(el)).toBe(3);

      dirty.clear();
      dirty.item("a");
      layer.sync(scene, dirty, new Set());
      scene.removeItem("a");
      add("b", { type: "note", seed: PLAIN, createdAt: Date.now() - 1500 * DAY }, { w: 240, h: 190 });
      layer.sync(scene, dirty, null);
      expect(square(sheet())).toBe(4);
    });

    it("leaves a sheet nobody has folded square", () => {
      layer.setAgeClock(wallClock);
      note(PLAIN);
      layer.sync(scene, dirty, null);
      expect(sheet().dataset["ear"]).toBeUndefined();
      expect(sheet().style.getPropertyValue("--ear")).toBe("");
    });

    it("never folds a photograph", () => {
      // A print ages by losing its dyes, not by having its shape changed
      // (DESIGN 4.7). It has no silhouette to cut and no back to show.
      layer.setAgeClock(wallClock);
      add("a", { seed: FOLDED, createdAt: Date.now() - 1500 * DAY });
      layer.sync(scene, dirty, null);
      const item = host.querySelector<HTMLElement>(".item-polaroid")!;
      expect(item.dataset["ear"]).toBeUndefined();
      expect(item.querySelector(".paper-ear")).toBeNull();
    });

    /**
     * The guard, and the reason this is a test rather than an assertion inside
     * another one.
     *
     * A fold deepens with wear while the item's cold record does not change at
     * all — nobody edits a note to make it older. `bind` returns early on the
     * cold identity, so without the fold in that guard the sheet would keep the
     * silhouette it had the day it crossed its own threshold and the flap drawn
     * off `--ear` would grow out past the cut it is meant to sit behind.
     */
    it("re-cuts the silhouette as the fold deepens, with no document change", () => {
      let days = 0;
      layer.setAgeClock(() => days);
      note(FOLDED, 0);
      layer.sync(scene, dirty, null);
      const surface = (): HTMLElement => sheet().querySelector<HTMLElement>(".paper-surface")!;

      const paths = new Set<string>();
      const depths = new Set<string>();
      for (days = 0; days <= 3000; days += 50) {
        dirty.clear();
        dirty.everything();
        layer.sync(scene, dirty, null);
        paths.add(surface().style.clipPath);
        depths.add(sheet().style.getPropertyValue("--ear"));
      }
      // Not "it changed once": the fold grows in, so the silhouette has to keep
      // up with it the whole way rather than snapping to its final shape.
      expect(paths.size).toBeGreaterThan(2);
      expect(depths.size).toBe(paths.size);
    });

    /**
     * AC-463, through the real path rather than through `cornerCurl` directly.
     *
     * `curl.test.ts` proves the rule; this proves the wiring — that the answer
     * `bind` arrived at is the one the curl is computed from, and not a second
     * `dogEarOf` that could disagree with it. A `-1` passed here by mistake has
     * no symptom in any unit test and shades a corner the sheet has not got.
     */
    it("does not curl the corner it has folded", () => {
      layer.setAgeClock(wallClock);
      note(FOLDED);
      layer.sync(scene, dirty, null);
      const el = sheet();
      const corner = dogEarOf(FOLDED, 1).corner;
      const props = ["--curl-tl", "--curl-tr", "--curl-br", "--curl-bl"];
      // Nothing is holding this sheet — no pin, and a taped sheet would be one
      // that is pinned — so every corner but the folded one is fully curled.
      for (let c = 0; c < 4; c++) {
        expect(el.style.getPropertyValue(props[c]!)).toBe(c === corner ? "0.00" : "1.00");
      }
    });

    it("gives a recycled node no memory of the last sheet's fold", () => {
      layer.setAgeClock(wallClock);
      note(FOLDED);
      layer.sync(scene, dirty, null);
      expect(sheet().dataset["ear"]).toBeDefined();

      dirty.clear();
      dirty.item("a");
      layer.sync(scene, dirty, new Set());
      scene.removeItem("a");
      add("b", { type: "note", seed: FOLDED, createdAt: Date.now() }, { w: 240, h: 190 });
      layer.sync(scene, dirty, null);
      expect(sheet().dataset["ear"]).toBeUndefined();
      expect(sheet().style.getPropertyValue("--ear")).toBe("");
    });
  });
});

/**
 * T-198 / AC-122. The card tier.
 *
 * Almost all of it is one attribute and a stylesheet, which is what the
 * measurement said it should be (D-33): removing the decorative *paint* took
 * `hold 35%` from a 222 ms worst frame to 7.1 ms with 500 items on screen, and
 * it needed no change to the tree, the pooling, the binding or the hit test.
 * These tests are therefore about the attribute and about the one thing that is
 * not CSS — the writing.
 */
/**
 * The clean face — DESIGN 3.6, T-243. What is testable here is the attribute
 * and the one thing that is not CSS: whether the writing goes down as glyph
 * boxes or as a text node.
 */
describe("the face an item is written in", () => {
  const item = (): HTMLElement => host.querySelector<HTMLElement>(".item")!;
  const boxes = (): number => host.querySelectorAll(".hand-word > span").length;

  it("says nothing for the board's own hand", () => {
    add("a", { type: "note", text: "who saw it" });
    layer.sync(scene, dirty, null);
    // Absent rather than "hand", so a selector written before this existed goes
    // on meaning what it meant — the same rule the LOD attribute follows.
    expect(item().dataset["face"]).toBeUndefined();
  });

  it("marks the item when the clean one is chosen", () => {
    add("a", { type: "note", text: "who saw it", style: { fontFamily: "clean" } });
    layer.sync(scene, dirty, null);
    expect(item().dataset["face"]).toBe("clean");
  });

  /**
   * The clean face is laid down as one text node whatever the zoom. A print
   * face does not lean, so it needs no box per glyph — and not having one is
   * what lets it kern, which is most of why anybody would choose it.
   */
  it("writes it without a box per letter, so it can kern", () => {
    add("a", { type: "note", text: "who saw it", style: { fontFamily: "clean" } });
    layer.sync(scene, dirty, null);
    expect(boxes()).toBe(0);
    expect(host.querySelector(".paper-text")!.textContent).toBe("who saw it");
  });

  it("still gives the hand its boxes, which is what the jitter needs", () => {
    add("a", { type: "note", text: "who saw it" });
    layer.sync(scene, dirty, null);
    expect(boxes()).toBeGreaterThan(0);
  });

  /** Choosing it and then putting it back is a real gesture, and the attribute
   *  has to come off rather than merely stop being read. */
  it("takes the mark off again when the override is cleared", () => {
    add("a", { type: "note", text: "who saw it", style: { fontFamily: "clean" } });
    layer.sync(scene, dirty, null);
    expect(item().dataset["face"]).toBe("clean");

    add("a", { type: "note", text: "who saw it" });
    layer.sync(scene, dirty, null);
    expect(item().dataset["face"]).toBeUndefined();
    expect(boxes()).toBeGreaterThan(0);
  });
});

describe("LOD tiers", () => {
  const writing = (): HTMLElement =>
    host.querySelector<HTMLElement>(".paper-text")!;
  const boxes = (): number => host.querySelectorAll(".hand-word > span").length;

  it("says nothing at all at the top tier", () => {
    add("a", { type: "note" });
    layer.sync(scene, dirty, null);
    // Absent rather than "full", so every selector written before LOD existed
    // goes on meaning what it meant.
    expect(host.dataset["lod"]).toBeUndefined();
  });

  it("names the tier once, on the host, however many items are mounted", () => {
    for (const id of ["a", "b", "c"]) add(id, { type: "note", text: "words" });
    layer.sync(scene, dirty, null);

    layer.setTier("card");
    expect(host.dataset["lod"]).toBe("card");
    // Not on the items. Five hundred attribute writes is the cost this avoids.
    for (const child of host.children) {
      expect((child as HTMLElement).dataset["lod"]).toBeUndefined();
    }

    layer.setTier("full");
    expect(host.dataset["lod"]).toBeUndefined();
  });

  it("lays the writing down plainly below the boundary, and leans it again above", () => {
    add("a", { type: "note", text: "two words here" });
    layer.sync(scene, dirty, null);
    expect(boxes()).toBeGreaterThan(0);

    // The caller raises the dirty pass — `setTier` only records, exactly as
    // `setRasterScale` only records.
    layer.setTier("card");
    dirty.clear();
    dirty.all = true;
    layer.sync(scene, dirty, null);
    expect(boxes()).toBe(0);
    expect(writing().textContent).toBe("two words here");

    layer.setTier("full");
    dirty.clear();
    dirty.all = true;
    layer.sync(scene, dirty, null);
    expect(boxes()).toBeGreaterThan(0);
    expect(writing().textContent).toBe("two words here");
  });

  /**
   * The bug the `plain` field in both `bind` guards exists for. Nothing about
   * the document changes when the zoom crosses 35%, so the guard that makes a
   * drag cheap is exactly the guard that would leave the writing leaning.
   */
  it("rewrites a note whose document record has not changed", () => {
    add("a", { type: "note", text: "unchanged" });
    layer.sync(scene, dirty, null);
    const before = boxes();
    expect(before).toBeGreaterThan(0);

    layer.setTier("card");
    dirty.clear();
    dirty.all = true;
    layer.sync(scene, dirty, null);
    expect(boxes()).toBe(0);
  });

  it("does the same for a polaroid's caption", () => {
    add("p", { type: "polaroid", text: "the pier, 1974" });
    layer.sync(scene, dirty, null);
    expect(host.querySelectorAll(".pol-caption .hand-word > span").length).toBeGreaterThan(0);

    layer.setTier("card");
    dirty.clear();
    dirty.all = true;
    layer.sync(scene, dirty, null);
    expect(host.querySelectorAll(".pol-caption .hand-word > span").length).toBe(0);
    expect(host.querySelector(".pol-caption")!.textContent).toBe("the pier, 1974");
  });

  /**
   * The half of AC-122 that a stylesheet cannot do, and the half that shipped
   * broken until a screenshot at 30% still had torn edges and ruled lines in it.
   *
   * `PaperView.bind` writes these three as *inline* styles, from the stock and
   * the seed, and an inline style beats a stylesheet rule — so the `clip-path:
   * none` that was in `items.css` was dead the moment it was written, and every
   * test in this file passed anyway.
   */
  describe("the flat card's inline paint", () => {
    const surface = (): HTMLElement => host.querySelector<HTMLElement>(".paper-surface")!;
  
    const flatten = (): void => {
      dirty.clear();
      dirty.all = true;
      layer.sync(scene, dirty, null);
    };

    it("drops the silhouette, the ruling and the tint below the boundary", () => {
      // `legal` so there is a ruling to lose; a seed with a tint and an edge.
      add("a", { type: "note", seed: 7, text: "words" });
      layer.sync(scene, dirty, null);
      expect(surface().style.clipPath).not.toBe("");
      expect(surface().style.backgroundImage).not.toBe("");
      expect(surface().style.filter).not.toBe("");
      // The stock's own colour is the flat paper and must survive. Read off
      // `backgroundColor` rather than the `background` shorthand, which the
      // ruling writes into and which therefore changes here by construction.
      const stock = surface().style.backgroundColor;
      expect(stock).not.toBe("");

      layer.setTier("card");
      flatten();
      expect(surface().style.clipPath).toBe("");
      expect(surface().style.backgroundImage).toBe("none");
      expect(surface().style.filter).toBe("none");
      expect(surface().style.backgroundColor).toBe(stock);
    });

    it("puts all three back on the way up", () => {
      add("a", { type: "note", seed: 7, text: "words" });
      layer.sync(scene, dirty, null);
      const was = {
        clip: surface().style.clipPath,
        ruling: surface().style.backgroundImage,
        tint: surface().style.filter,
      };

      layer.setTier("card");
      flatten();
      layer.setTier("full");
      flatten();

      expect(surface().style.clipPath).toBe(was.clip);
      expect(surface().style.backgroundImage).toBe(was.ruling);
      expect(surface().style.filter).toBe(was.tint);
    });

    it("drops a polaroid's tint too", () => {
      add("p", { type: "polaroid", seed: 11, text: "the pier" });
      layer.sync(scene, dirty, null);
      const print = (): HTMLElement => host.querySelector<HTMLElement>(".item-polaroid")!;
      expect(print().style.filter).not.toBe("");

      layer.setTier("card");
      flatten();
      expect(print().style.filter).toBe("none");
    });
  });

  it("writes an item mounted while already below the boundary plainly, first time", () => {
    // The board that opens zoomed out. `Lod` announces at boot for this reason,
    // and a view built after the announcement must not need a second pass.
    layer.setTier("card");
    add("a", { type: "note", text: "words" });
    layer.sync(scene, dirty, null);
    expect(boxes()).toBe(0);
    expect(writing().textContent).toBe("words");
  });
});

/**
 * T-202. An item that arrives while the camera is moving arrives as a card, at
 * any zoom, and is given its detail when the camera stops.
 *
 * The measurement behind it (D-33 section 10): what a mount storm costs is
 * *having* the nodes, not the act of mounting. Five hundred items mounted as
 * cards is 7,101 nodes and 6.9 ms a frame; the same five hundred at full detail
 * is 73,071 nodes and 632 ms. And a board that never unmounts costs 104 ms a
 * frame to pan with nothing mounting at all — so the cost cannot be prepaid at
 * load either, which is what pointed here.
 */
describe("coarse mounts", () => {
  const coarse = (): HTMLElement[] =>
    Array.from(host.querySelectorAll<HTMLElement>(".item.is-coarse"));
  const boxes = (): number => host.querySelectorAll(".hand-word > span").length;

  /** A frame in which the camera moved — which is what makes a mount a storm. */
  const panned = (): void => {
    dirty.clear();
    dirty.camera = true;
  };

  /** A frame of a zoom gesture, which is the one that brings items in by the
   *  hundred and the only one that mounts coarsely. */
  const zoomed = (n = 20): string[] => {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = `s${i}`;
      add(id, { type: "note", text: "some words" });
      ids.push(id);
    }
    dirty.camera = true;
    dirty.zoomed = true;
    return ids;
  };

  it("mounts as a card while a zoom is running, even at full zoom", () => {
    zoomed();
    layer.sync(scene, dirty, null);

    expect(coarse()).toHaveLength(20);
    // The whole point: at a zoom whose tier is `full`, a card. This is about the
    // item's age, not the camera's scale.
    const card = coarse()[0]!;
    expect(card.querySelectorAll(".hand-word > span")).toHaveLength(0);
    expect(card.querySelector<HTMLElement>(".paper-surface")!.style.clipPath).toBe("");
  });

  it("gives it everything back when the camera stops", () => {
    zoomed();
    layer.sync(scene, dirty, null);
    const owed = layer.coarseCount;
    expect(owed).toBeGreaterThan(0);

    layer.settled();
    // Clean frames, which is what a resting camera produces — the upgrade must
    // not wait for somebody to touch the board. Several of them, because the
    // drain is budgeted: a hundred and forty items rebound on one frame measured
    // at 493 ms (T-203).
    for (let f = 0; f < 10; f += 1) {
      dirty.clear();
      layer.sync(scene, dirty, null);
    }

    expect(coarse()).toHaveLength(0);
    expect(layer.coarseCount).toBe(0);
    // Every sheet on the board has its writing and its ragged edge back.
    for (const el of host.querySelectorAll<HTMLElement>(".item-paper")) {
      expect(el.querySelectorAll(".hand-word > span").length).toBeGreaterThan(0);
      expect(el.querySelector<HTMLElement>(".paper-surface")!.style.clipPath).not.toBe("");
    }
  });

  it("does not make a paste wait for a gesture that may never come", () => {
    // A still camera: a paste, a peer's create, an undo. One item, affordable at
    // full detail — and one that would otherwise sit there without its grain
    // until somebody happened to pan.
    add("a", { type: "note", text: "some words" });
    layer.sync(scene, dirty, null);

    expect(coarse()).toHaveLength(0);
    expect(boxes()).toBeGreaterThan(0);
  });

  /**
   * The `isNew` half of the guard. A drag marks the camera dirty on every frame
   * of itself, and an item already on screen must not lose its grain because of
   * what some other item is doing.
   */
  it("does not strip an item that was already mounted", () => {
    add("a", { type: "note", text: "some words" });
    layer.sync(scene, dirty, null);
    const before = boxes();

    panned();
    dirty.item("a");
    scene.setPose("a", { x: 40 });
    layer.sync(scene, dirty, null);

    expect(coarse()).toHaveLength(0);
    expect(boxes()).toBe(before);
  });

  /**
   * The distinction the whole thing turns on. A pan mounts a handful at the
   * viewport edge, `pan at 100%` was already inside budget with nothing done to
   * it, and making those few arrive plainly would cost a visible straightening of
   * their handwriting when the pan stopped, for no measured gain at all.
   *
   * A count was tried instead of this and cannot separate them: three a frame
   * over a seventy-frame zoom is two hundred and fifty full mounts, which put the
   * worst frame back from 41.7 ms to 125.
   */
  it("mounts in full during a pan, however many arrive", () => {
    for (let i = 0; i < 40; i += 1) add(`p${i}`, { type: "note", text: "some words" });
    // A pan: the camera moved and the zoom did not.
    dirty.camera = true;
    layer.sync(scene, dirty, null);

    expect(coarse()).toHaveLength(0);
    expect(layer.coarseCount).toBe(0);
    expect(boxes()).toBeGreaterThan(0);
  });

  it("does not bother marking a mount that is a card anyway", () => {
    layer.setTier("card");
    zoomed();
    layer.sync(scene, dirty, null);

    // Already plain, from the tier. A per-item marker on top would be a second
    // thing saying the same thing, and a second thing to take off again.
    expect(coarse()).toHaveLength(0);
    expect(boxes()).toBe(0);
  });

  it("forgets an item culled before its upgrade arrived", () => {
    zoomed();
    layer.sync(scene, dirty, null);
    expect(layer.coarseCount).toBeGreaterThan(0);

    // Panned back out again before the camera stopped.
    panned();
    layer.sync(scene, dirty, new Set());
    expect(layer.coarseCount).toBe(0);

    layer.settled();
    dirty.clear();
    // Must not throw, and must not upgrade whoever inherits the pooled node.
    expect(() => layer.sync(scene, dirty, new Set())).not.toThrow();
  });

  /**
   * Budgeted, and the second reason is the better one: an item culled before its
   * turn is never upgraded at all. A zoom in to 400% catches ~140 items mounted
   * at the boundary and ends with six, so 134 of those rebinds would be work
   * thrown away a moment later — which is why waiting for the settle used to look
   * so good at 400% and so bad at 35%.
   */
  it("sweeps the detail in a few items a frame rather than all at once", () => {
    zoomed(40);
    layer.sync(scene, dirty, null);
    expect(layer.coarseCount).toBe(40);

    layer.settled();
    dirty.clear();
    layer.sync(scene, dirty, null);
    const afterOne = layer.coarseCount;
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan(40);

    // And it keeps going on its own, without being asked again.
    let frames = 1;
    while (layer.coarseCount > 0 && frames < 60) {
      dirty.clear();
      layer.sync(scene, dirty, null);
      frames += 1;
    }
    expect(layer.coarseCount).toBe(0);
    expect(coarse()).toHaveLength(0);
    // A sweep measured in frames, not one item per frame and not all in one.
    expect(frames).toBeGreaterThan(1);
    expect(frames).toBeLessThan(40);
  });

  /**
   * A tier rise owes every mounted item its detail, and none of them may change
   * appearance before its turn. Taking `data-lod` off the host is enough on its
   * own to give every sheet its grain back — CSS needs no rebind — so the per-item
   * marker is what holds them as cards until the sweep reaches them.
   */
  it("holds every mounted item as a card when the tier rises", () => {
    layer.setTier("card");
    for (let i = 0; i < 20; i += 1) add(`r${i}`, { type: "note", text: "some words" });
    layer.sync(scene, dirty, null);
    expect(coarse()).toHaveLength(0);
    expect(host.dataset["lod"]).toBe("card");

    layer.setTier("full");
    expect(host.dataset["lod"]).toBeUndefined();
    // Every one of them, still a card, on the frame the tier changed.
    expect(layer.coarseCount).toBe(20);
    expect(coarse()).toHaveLength(20);

    let frames = 0;
    while (layer.coarseCount > 0 && frames < 60) {
      dirty.clear();
      layer.sync(scene, dirty, null);
      frames += 1;
    }
    expect(coarse()).toHaveLength(0);
    expect(boxes()).toBeGreaterThan(0);
  });

  it("owes nothing when the tier falls", () => {
    for (let i = 0; i < 20; i += 1) add(`f${i}`, { type: "note", text: "some words" });
    layer.sync(scene, dirty, null);

    layer.setTier("card");
    // Everything is a card by the tier alone. A per-item marker would be a second
    // thing saying the same thing, and a second thing to take off again.
    expect(layer.coarseCount).toBe(0);
    expect(coarse()).toHaveLength(0);
  });

  it("says nothing is owed when nothing mounted coarsely", () => {
    add("a", { type: "note", text: "words" });
    layer.sync(scene, dirty, null);
    layer.settled();
    dirty.clear();
    layer.sync(scene, dirty, null);
    expect(layer.coarseCount).toBe(0);
  });
});

/**
 * T-216, from the board: "on tall photos the caption shifts upwards".
 *
 * The white band below the picture is a fraction of the polaroid's *width* —
 * that is what a polaroid is, and it is why the frame's padding is written from
 * `w` alone. The caption used to be placed by the stylesheet with `bottom: 4%`
 * and `height: 11%`, and a percentage on either resolves against the frame's
 * **height**. So the two agreed at one aspect ratio and nowhere else.
 */
describe("where a polaroid's caption sits", () => {
  const px = (value: string): number => Number.parseFloat(value);

  it("is the same place on a wide print and a tall one", () => {
    const shapes: { w: number; h: number }[] = [
      { w: 340, h: 247 }, // 3:2 landscape
      { w: 340, h: 305 }, // the classic, near square
      { w: 226, h: 358 }, // 2:3 portrait — the one that was wrong
    ];
    const seen: { bottom: number; height: number }[] = [];
    for (const [i, shape] of shapes.entries()) {
      add(`p${i}`, { text: "a caption" }, shape);
      layer.sync(scene, dirty, null);
      const el = host.querySelectorAll(".pol-caption")[i] as HTMLElement;
      seen.push({
        bottom: px(el.style.bottom) / shape.w,
        height: px(el.style.height) / shape.w,
      });
    }
    // Every one of them, in fractions of its own width. Three decimal places
    // because the view writes pixels to one — a tenth of a pixel on a 226-unit
    // print is the whole of the difference here, and it is not one anybody can
    // see.
    for (const each of seen) {
      expect(each.bottom).toBeCloseTo(CAPTION_BOTTOM, 3);
      expect(each.height).toBeCloseTo(CAPTION_HEIGHT, 3);
    }
  });

  /**
   * The constraint the percentages were violating, stated as itself: the box
   * has to be inside the band, or the caption is over the photograph.
   */
  it("fits inside the band, centred, whatever shape the print is", () => {
    expect(CAPTION_BOTTOM + CAPTION_HEIGHT).toBeLessThanOrEqual(FRAME_BOTTOM);
    // Equal margin above and below — the classic print's own look.
    expect(FRAME_BOTTOM - CAPTION_HEIGHT - CAPTION_BOTTOM).toBeCloseTo(CAPTION_BOTTOM, 5);
  });

  /**
   * The height is not a factor at all: two prints of one width and very
   * different heights put their captions at exactly the same offset.
   *
   * Two *items* rather than one item resized, deliberately. The view only
   * rewrites this box when the width changes, so resizing an item in place
   * would leave the old numbers standing and the assertion would pass however
   * the box is computed.
   */
  it("does not depend on the height", () => {
    add("wide", { text: "x" }, { w: 300, h: 200 });
    add("tall", { text: "x" }, { w: 300, h: 600 });
    layer.sync(scene, dirty, null);

    const [a, b] = [...host.querySelectorAll(".pol-caption")] as HTMLElement[];
    expect(a!.style.bottom).toBe(b!.style.bottom);
    expect(a!.style.height).toBe(b!.style.height);
  });
});

/**
 * The three objects a file that is not a photograph becomes — T-267, D-46
 * section 1.
 *
 * Everything here goes through the real layer rather than through `CaseView`,
 * which is not exported and should not be: the claim under test is that the
 * *renderer* has no special case for these three, and a test that reached past
 * the layer to build one would be exempting itself from exactly that.
 */
describe("a folder, a tape and a cassette", () => {
  const HASH = "4f2a9c1b".padEnd(64, "0");
  /** The still — a second asset, hashed like any other picture (T-270). */
  const POSTER = "9e10c73d".padEnd(64, "1");

  /** What the document says about an asset — the reader in `app/main.ts`, faked. */
  function facts(over: Partial<AssetFacts> = {}): AssetLookup {
    return () => ({ ...NO_FACTS, ...over });
  }

  function layerWith(lookup: AssetLookup): DomItemLayer {
    return new DomItemLayer(host, (sha) => ready(`asset://sha256/${sha}`), lookup);
  }

  /** A clean host, scene and dirty set — the `beforeEach`, mid-test. */
  function again(): void {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    scene = new Scene();
    dirty = new DirtySets();
  }

  /** Mount one asset item and hand back its element. */
  function mount(lookup: AssetLookup, cold: Partial<ItemCold> = {}): HTMLElement {
    const layer = layerWith(lookup);
    add("a", { assetId: HASH, ...cold });
    layer.sync(scene, dirty, null);
    return host.firstElementChild as HTMLElement;
  }

  // --- AC-665: the face is chosen from the mime -----------------------------

  it("chooses the face from the asset's kind and never from the item's type", () => {
    // Every one of these items is a `polaroid` in the document. Nothing in the
    // schema says folder, tape or cassette anywhere, which is the whole of the
    // data-loss argument in D-46 section 2 — an older build meeting a type it
    // had never heard of would render nothing and collect the bytes.
    for (const [kind, className] of [
      ["document", "item-case"],
      ["video", "item-case"],
      ["audio", "item-case"],
      ["image", "item-polaroid"],
    ] as const) {
      again();
      expect(mount(facts({ kind })).className).toContain(className);
    }
  });

  it("gives each kind its own face", () => {
    for (const [kind, face] of [
      ["document", "folder"],
      ["video", "vhs"],
      ["audio", "cassette"],
    ] as const) {
      again();
      expect(mount(facts({ kind })).dataset["kind"]).toBe(face);
    }
  });

  it("draws a mime it does not understand as a photograph rather than as nothing", () => {
    // Three states that are one state here: no asset, a record that has not
    // arrived, and a mime a later build knows about and this one does not. All
    // three are a frame around nothing, which an item with no bytes already is.
    expect(mount(facts({ kind: "unknown" })).className).toContain("item-polaroid");
  });

  it("becomes a folder when the record lands after the item does", () => {
    // Ordinary on a peer merging a board: the record and the item are one
    // transaction here and need not be one *arrival* there. So the object comes
    // up as a photograph of nothing and changes face when its record turns up.
    let kind: AssetFacts["kind"] = "unknown";
    const layer = layerWith(() => ({ ...NO_FACTS, kind }));
    add("a", { assetId: HASH });
    layer.sync(scene, dirty, null);
    expect((host.firstElementChild as HTMLElement).className).toContain("item-polaroid");

    kind = "document";
    dirty.item("a");
    layer.sync(scene, dirty, null);
    expect(host.children.length).toBe(1);
    expect((host.firstElementChild as HTMLElement).dataset["kind"]).toBe("folder");
  });

  // --- AC-666: they are items, with no special case in the renderer ---------

  it("takes ink, tape, a shadow and the seeded rotation like anything else", () => {
    for (const kind of ["document", "video", "audio"] as const) {
      again();
      const layer = layerWith(facts({ kind }));
      add("a", { assetId: HASH, seed: 7 }, { rot: 0.42, w: 200, h: 140 });
      scene.putStrokes("a", [
        {
          id: "a-s",
          tool: "marker",
          color: "#1f1b17",
          size: 6,
          opacity: 1,
          seed: 1,
          z: "a0",
          page: null,
          bbox: [-20, 0, 20, 0],
          samples: [
            { x: -20, y: 0, pressure: 0.5 },
            { x: 20, y: 0, pressure: 0.5 },
          ],
        },
      ]);
      dirty.inkFor("a");
      layer.sync(scene, dirty, null);
      const el = host.firstElementChild as HTMLElement;

      // The rotation, through the same `writeTransform` every item uses.
      expect(el.style.transform).toContain("rotate(0.42rad)");
      // A shadow, off the same baked nine-slice.
      expect(el.querySelector(".item-shadow")).not.toBeNull();
      // Both tape strips in the tree, shown or hidden by the same mask.
      expect(el.querySelectorAll(".item-tape").length).toBe(2);
      // And an ink canvas inside the rotated node, so marks follow a move.
      layer.paintInk(scene, dirty);
      expect(el.querySelector("canvas.item-ink")).not.toBeNull();
    }
  });

  it("tapes a corner of an unpinned object, on the same mask as a sheet", () => {
    // `tapedCorners` is the seed's answer and nothing here overrides it. What is
    // under test is that the layer offers the mask to these views on the same
    // pass it offers it to every other one.
    const seed = [...Array(64).keys()].find((s) => tapedCorners(s, 0) !== 0)!;
    const el = mount(facts({ kind: "video" }), { seed });
    const shown = [...el.querySelectorAll<HTMLElement>(".item-tape")].filter(
      (strip) => strip.style.display === "block",
    );
    expect(shown.length).toBeGreaterThan(0);
  });

  it("refuses to bend any of the three, and still bends a sheet", () => {
    // Not a special case — the layer offers the curl to every view identically
    // and each answers for its material. `PolaroidView` already refuses on the
    // same grounds for a print in a frame.
    //
    // The folder took it until T-314. Card does bend, which is why the argument
    // held for so long, but a corner flap reaches a fixed way in from the corner
    // and on something 481 by 344 that is most of an edge: what a folder wore
    // was a dark band down its whole left side, not four flaps. A folder is
    // 300gsm board folded double and what handling does to one is take its
    // corners *round*, which is `edge.ts`'s job.
    for (const kind of ["document", "video", "audio"] as const) {
      const el = mount(facts({ kind }));
      expect(el.querySelector(".paper-bend"), `${kind} does not curl`).toBeNull();
      expect(el.style.getPropertyValue("--curl-tl"), `${kind} is never asked`).toBe("");
      again();
    }
    // And the half that keeps this from passing for the wrong reason: the curl
    // is refused per material, not quietly deleted. A note is still a sheet.
    const paper = layerWith(facts());
    add("note", { type: "note", assetId: null });
    paper.sync(scene, dirty, null);
    const note = host.firstElementChild as HTMLElement;
    expect(note.querySelector(".paper-bend"), "a note still bends").not.toBeNull();
  });

  /** A tape somebody has had for fifteen years. */
  const OLD = (): number => 4000;

  /** The item, aged, with the one asset kind asked for. */
  function aged(kind: AssetFacts["kind"]): HTMLElement {
    const layer = layerWith(facts({ kind }));
    layer.setAgeClock(OLD);
    add("a", { assetId: HASH });
    layer.sync(scene, dirty, null);
    return host.firstElementChild as HTMLElement;
  }

  it("fades the writing and leaves every surface to the stylesheet", () => {
    // Two mechanisms and two materials (T-316). Ink ages by going, which is the
    // filter below; card ages by going brown, which is a background layer and so
    // is not visible from here at all. A fifteen-year-old tape is a black tape
    // with a brown label, and polystyrene never goes anywhere.
    for (const kind of ["document", "video", "audio"] as const) {
      const el = aged(kind);
      for (const what of ["case-number", "case-meta", "case-title", "case-caption"]) {
        expect(el.querySelector<HTMLElement>(`.${what}`)!.style.filter, `${kind} ${what}`).not.toBe(
          "",
        );
      }
      // The `--age` the stylesheet's yellowing is a function of, and the class it
      // is gated on. Without these the card cannot age at all.
      expect(el.style.getPropertyValue("--age"), kind).not.toBe("");
      expect(el.classList.contains("is-aged"), kind).toBe(true);
      again();
    }
    // And the surfaces themselves, which must carry no filter: a filter reaches
    // everything below the node it is on, and every one of these has the writing
    // — or, on a cassette, the recording — somewhere inside it.
    const cassette = aged("audio");
    for (const what of [".case-label", ".case-shell", ".case-body"]) {
      expect(cassette.querySelector<HTMLElement>(what)!.style.filter, what).toBe("");
    }
    again();
    expect(aged("document").querySelector<HTMLElement>(".folder-front")!.style.filter).toBe("");
  });

  it("never ages the recording, on a cassette whose window is inside its label", () => {
    // T-272's second sentence. A compact cassette's window is a row of the
    // label's own grid, so a filter on the label reached the spools and the span
    // of tape — measured on the running board at eleven levels of lift on the
    // darkest thing on the object. Since T-271 the window is also where a
    // transfer draws itself, so a yellowed one is a yellowed readout.
    //
    // The whole chain of ancestors, not the window alone, because that is how a
    // filter reaches: this fails wherever somebody puts one.
    const cassette = aged("audio");
    // The window really is inside the label — if that ever stops being true this
    // test is measuring something else, and T-304 and T-306 both rest on it.
    expect(cassette.querySelector(".case-label > .case-window")).not.toBeNull();
    for (const node of ["", " .case-reel", " .case-tape"]) {
      let el = cassette.querySelector<HTMLElement>(`.case-window${node}`)!;
      for (; el !== cassette.parentElement; el = el.parentElement!) {
        expect(el.style.filter, `${el.className} is not aged`).toBe("");
      }
    }
  });

  it("gives every tape a supply spool and a take-up spool", () => {
    // Which spool is which is a fact about the object, not about the order they
    // were appended in — a VHS keeps its two in separate windows at opposite
    // ends of the face, so there is no DOM order to read it off (T-268).
    for (const kind of ["video", "audio"] as const) {
      const el = mount(facts({ kind }));
      expect(el.querySelectorAll(".case-reel").length, kind).toBe(2);
      expect(el.querySelectorAll(".case-reel.is-supply").length, kind).toBe(1);
      expect(el.querySelectorAll(".case-reel.is-takeup").length, kind).toBe(1);
      again();
    }
    // And on a VHS the supply is the left window, which is where a rewound
    // tape's ribbon is on Phil's reference.
    const vhs = mount(facts({ kind: "video" }));
    expect(vhs.querySelector(".case-window.is-left .case-reel.is-supply")).not.toBeNull();
    expect(vhs.querySelector(".case-window.is-right .case-reel.is-takeup")).not.toBeNull();
  });

  it("puts a four digit counter on a VHS and on nothing else", () => {
    // A cassette shows both hubs in one window an inch apart, so the balance
    // between them is the readout. A VHS has its windows at opposite ends of a
    // nine inch face with a label between, and the eye will not make that
    // comparison — so it gets digits, and they are four wheels rather than one
    // string because a mechanical counter is four wheels.
    const vhs = mount(facts({ kind: "video" }));
    const counter = vhs.querySelector(".case-counter")!;
    expect(counter).not.toBeNull();
    const digits = [...counter.querySelectorAll(".case-digit")];
    expect(digits.map((d) => d.textContent).join("")).toBe("0000");
    // On the shell, not on the label: it is read off the transport rather than
    // written by anybody, and a filter or a fold that finds the label must not
    // find this.
    expect(vhs.querySelector(".case-label .case-counter")).toBeNull();

    for (const kind of ["audio", "document"] as const) {
      again();
      expect(mount(facts({ kind })).querySelector(".case-counter"), kind).toBeNull();
    }
  });

  // --- T-270: the still clipped to the tape ---------------------------------

  it("clips a print to a tape and to neither of the other two", () => {
    // There is no frame to take off a sound recording, and a document's first
    // page is a page — it belongs to the spread T-279 mounts rather than to a
    // thumbnail lifted early. So this is a VHS's furniture, decided in the
    // constructor like every other difference between the three.
    const vhs = mount(facts({ kind: "video", poster: POSTER }));
    expect(vhs.querySelector(".case-print")).not.toBeNull();
    expect(vhs.querySelector(".case-still")).not.toBeNull();
    // Held on by a clip, which is what makes it a thing stuck to the tape
    // rather than artwork printed on the sleeve.
    expect(vhs.querySelector(".case-print .case-clip")).not.toBeNull();

    for (const kind of ["audio", "document"] as const) {
      again();
      expect(mount(facts({ kind, poster: POSTER })).querySelector(".case-print"), kind).toBeNull();
    }
  });

  it("draws no print at all until there is a still to put in it", () => {
    // A tape with no still is a tape — the shell, the label, the case number
    // and the runtime are all there and all legible (T-271). A print saying
    // "the still is on its way" would be furniture explaining the absence of
    // furniture, so there is no third state here: the class is what keeps the
    // node out of the box model, and out of the decode.
    const vhs = mount(facts({ kind: "video" }));
    expect(vhs.querySelector(".case-print")!.classList.contains("is-empty")).toBe(true);
    expect(vhs.querySelector(".case-still")!.getAttribute("src")).toBeNull();
  });

  it("points the print at the poster hash and never at the film", () => {
    const layer = new DomItemLayer(
      host,
      (sha) => ready(`asset://sha256/${sha}`),
      facts({ kind: "video", poster: POSTER }),
    );
    add("a", { assetId: HASH });
    layer.sync(scene, dirty, null);
    const still = host.querySelector(".case-still") as HTMLImageElement;
    expect(still.getAttribute("src")).toContain(POSTER);
    expect(still.getAttribute("src")).not.toContain(HASH);
  });

  it("paints the still when its bytes land, with nothing else about the record changed", () => {
    // The guard this defends is the bind's digest. The poster *hash* is on the
    // record from the moment it is grabbed and never changes again; what
    // changes afterwards is whether this machine can show it. A digest naming
    // the hash compares equal across the transfer committing, and the tape you
    // were looking at when the bytes landed is the one that never gets a
    // picture.
    let here = false;
    const layer = new DomItemLayer(
      host,
      (sha) => (sha === POSTER && !here ? waiting() : ready(`asset://sha256/${sha}`)),
      facts({ kind: "video", poster: POSTER }),
    );
    add("a", { assetId: HASH });
    layer.sync(scene, dirty, null);
    const print = host.querySelector(".case-print")!;
    expect(print.classList.contains("is-empty")).toBe(true);

    here = true;
    dirty.item("a");
    layer.sync(scene, dirty, null);
    expect(print.classList.contains("is-empty")).toBe(false);
    expect((host.querySelector(".case-still") as HTMLImageElement).getAttribute("src")).toContain(
      POSTER,
    );
  });

  it("takes the last film's frame off a recycled print", () => {
    // Views are pooled, so the node this tape gives back is the node the next
    // one mounts on. An `<img>` still pointing at the last film's still would
    // show it for the frame between mounting and binding — a tape wearing
    // somebody else's picture, which is the one failure a wall of stills
    // cannot survive.
    let poster: string = POSTER;
    const layer = new DomItemLayer(
      host,
      (sha) => ready(`asset://sha256/${sha}`),
      () => ({ ...NO_FACTS, kind: "video" as const, poster }),
    );
    add("a", { assetId: HASH });
    layer.sync(scene, dirty, null);
    expect((host.querySelector(".case-still") as HTMLImageElement).getAttribute("src")).toContain(
      POSTER,
    );

    poster = "";
    dirty.item("a");
    layer.sync(scene, dirty, null);
    expect((host.querySelector(".case-still") as HTMLImageElement).getAttribute("src")).toBeNull();
  });

  it("hands a recycled node back to its own kind", () => {
    // Three pools, not one. A cassette dressed out of a folder's subtree would
    // be a tab and no window, because the constructor is the only place the
    // furniture is decided.
    const layer = layerWith(facts({ kind: "audio" }));
    add("a", { assetId: HASH });
    layer.sync(scene, dirty, null);
    scene.removeItem("a");
    dirty.item("a");
    layer.sync(scene, dirty, null);

    add("b", { assetId: HASH });
    layer.sync(scene, dirty, null);
    const el = host.firstElementChild as HTMLElement;
    expect(el.dataset["kind"]).toBe("cassette");
    expect(el.querySelector(".case-window")).not.toBeNull();
  });

  // --- AC-667 and AC-668: what is written on them ---------------------------

  it("types the filename on the gummed label as the case number", () => {
    // On a stuck-on filing label rather than on a tab: Phil's reference folder
    // is a landscape kraft one with the back panel proud along the top and no
    // tab to write on, so the label is where a real one of those wears it.
    const el = mount(facts({ kind: "document", name: "22718 N Sign.pdf" }));
    expect(el.querySelector(".folder-label .case-number")!.textContent).toBe("22718 N Sign");
  });

  it("is a landscape folder with paper spilling out of it", () => {
    // Both off the reference, and both were wrong before it: the object was
    // portrait, and what showed above the front panel was two neat strips
    // rather than a handful of paper nobody squared up.
    const el = mount(facts({ kind: "document" }));
    expect(el.querySelector(".folder-back")).not.toBeNull();
    expect(el.querySelector(".folder-sheets")).not.toBeNull();
    const size = objectSizeFor("document")!;
    expect(size.w).toBeGreaterThan(size.h);
  });

  it("is as thick as the document it holds", () => {
    // The one thing a closed folder can say about what is in it. Read off the
    // element rather than off `folderBulk`, because the point of this task is
    // that the number reaches the drawing.
    const memo = mount(facts({ kind: "document", pages: 3 }));
    const thin = Number(memo.style.getPropertyValue("--bulk"));
    again();
    const dump = mount(facts({ kind: "document", pages: 400 }));
    const fat = Number(dump.style.getPropertyValue("--bulk"));
    expect(thin).toBeGreaterThan(0);
    expect(fat).toBeGreaterThan(thin * 2);
  });

  it("thickens when the page count arrives after the item has been drawn", () => {
    // The case the digest exists for: `pages` comes with the asset record,
    // which may be a peer's write and a network away, and a folder drawn
    // before it landed must not stay the shape it guessed.
    let pages: number | null = null;
    const layer = layerWith(() => ({ ...NO_FACTS, kind: "document", pages }));
    add("a", { assetId: HASH });
    layer.sync(scene, dirty, null);
    const el = host.firstElementChild as HTMLElement;
    const guessed = Number(el.style.getPropertyValue("--bulk"));

    pages = 480;
    dirty.item("a");
    layer.sync(scene, dirty, null);
    expect(Number(el.style.getPropertyValue("--bulk"))).toBeGreaterThan(guessed);
  });

  it("writes the extracted title under it, in the hand the notes use", () => {
    const el = mount(
      facts({ kind: "document", name: "configure-vhosts.pdf", title: "Configure Virtual Hosts" }),
    );
    const title = el.querySelector<HTMLElement>(".case-title")!;
    // `writeHand` lays it down a word at a time, so this is the text reassembled
    // out of the glyph boxes rather than read off one node.
    expect(title.textContent).toBe("Configure Virtual Hosts");
    expect(title.querySelector(".hand-word")).not.toBeNull();
  });

  it("leaves the title line off when the file says nothing worth writing", () => {
    // The ordinary case. D-47 measured a title on about a third of real
    // documents, and `titleWorthWriting` refuses half of those again.
    for (const title of ["", "MPI Log book.cdr", "Untitled-1"]) {
      again();
      const el = mount(facts({ kind: "document", name: "MPI Log book.pdf", title }));
      expect(el.querySelector(".case-title")!.textContent).toBe("");
    }
  });

  it("writes a spine and a J-card out of the container's own name", () => {
    // The same line as a folder's, off a different field: T-302 reads it out of
    // ID3v2, `udta`, Matroska's `Info` and a Vorbis comment.
    const tape = mount(facts({ kind: "video", name: "S03E04.1080p.x265.mkv", title: "Silo" }));
    expect(tape.querySelector<HTMLElement>(".case-title")!.textContent).toBe("Silo");

    again();
    const cassette = mount(facts({ kind: "audio", name: "track03.mp3", title: "Interview" }));
    expect(cassette.querySelector<HTMLElement>(".case-title")!.textContent).toBe("Interview");
  });

  it("is a tape with only its filename on it when the container says nothing", () => {
    // AC-697, and it is not the unhappy path — it is the usual one. D-52 swept
    // 4,502 real media files and found a title on 1 of 461 `.mp4`s. So the
    // spine that says only its case number is what most tapes look like, and it
    // has to look deliberate rather than broken.
    const el = mount(facts({ kind: "video", name: "holiday.mp4", title: "" }));
    expect(el.querySelector(".case-number")!.textContent).toBe("holiday");
    expect(el.querySelector(".case-title")!.textContent).toBe("");
  });

  it("refuses a container title that is only the filename again", () => {
    // 85 of the 186 titled `.mp3`s on D-52's corpus. `titleWorthWriting` was
    // written for PDFs and this is the same junk shape in another format, which
    // is the argument for one filter rather than one per container.
    const el = mount(facts({ kind: "audio", name: "Chemical Static.mp3", title: "Chemical Static" }));
    expect(el.querySelector(".case-title")!.textContent).toBe("");
  });

  it("says the runtime and the page count before a byte of the file has arrived", () => {
    // AC-668, and the point of it: every number on these labels comes off the
    // *record*. The resolver below hands back no URL at all and never will.
    const nothing: AssetResolver = () => waiting();

    const folder = new DomItemLayer(host, nothing, facts({ kind: "document", pages: 142 }));
    add("a", { assetId: HASH });
    folder.sync(scene, dirty, null);
    expect(host.querySelector(".case-meta")!.textContent).toBe("142 pp.");

    again();
    const tape = new DomItemLayer(host, nothing, facts({ kind: "video", duration: 3785 }));
    add("a", { assetId: HASH });
    tape.sync(scene, dirty, null);
    expect(host.querySelector(".case-meta")!.textContent).toBe("1:03:05");
  });

  it("gives a file that never had a name a case number off its hash", () => {
    const el = mount(facts({ kind: "audio", name: "" }));
    expect(el.querySelector(".case-number")!.textContent).toBe("4F2A9C1B");
  });

  it("rewrites the label when the title arrives, which is after the bind", () => {
    // The title is derived locally and asked for asynchronously (Q-211), so it
    // lands on a later frame than the item did. A guard on the cold record alone
    // would leave the folder saying nothing for the rest of the session.
    let title = "";
    const layer = layerWith(() => ({ ...NO_FACTS, kind: "document", name: "f.pdf", title }));
    add("a", { assetId: HASH });
    layer.sync(scene, dirty, null);
    expect(host.querySelector(".case-title")!.textContent).toBe("");

    title = "Grand jury exhibit B";
    dirty.item("a");
    layer.sync(scene, dirty, null);
    expect(host.querySelector(".case-title")!.textContent).toBe("Grand jury exhibit B");
  });

  it("does not keep the last object's label when its node is recycled", () => {
    // The failure `release` exists to stop, and the one a pool makes easy: two
    // case files in a row through one node, the second wearing the first's name.
    let name = "first.pdf";
    const layer = layerWith(() => ({ ...NO_FACTS, kind: "document", name }));
    add("a", { assetId: HASH });
    layer.sync(scene, dirty, null);
    scene.removeItem("a");
    dirty.item("a");
    layer.sync(scene, dirty, null);

    name = "second.pdf";
    add("b", { assetId: HASH });
    layer.sync(scene, dirty, null);
    expect(host.querySelector(".case-number")!.textContent).toBe("second");
  });

  it("comes back with its label when it is culled away and back again", () => {
    // The case a pool makes easy to get wrong and a mutation test found: the
    // *same* item, released and remounted, with a cold record that did not
    // change while it was gone. Every guard in `bind` says nothing has moved,
    // so a view that had not forgotten what it wrote would come back blank.
    const layer = layerWith(facts({ kind: "document", name: "filing.pdf", pages: 9 }));
    add("a", { assetId: HASH });
    layer.sync(scene, dirty, new Set(["a"]));
    expect(host.querySelector(".case-number")!.textContent).toBe("filing");

    // Panned off the screen, and back.
    layer.sync(scene, dirty, new Set());
    expect(layer.mounted).toBe(0);
    layer.sync(scene, dirty, new Set(["a"]));
    expect(host.querySelector(".case-number")!.textContent).toBe("filing");
    expect(host.querySelector(".case-meta")!.textContent).toBe("9 pp.");
  });

  it("gives each cassette the furniture the real object has", () => {
    // Drawn from photographs, and the structure is what the photographs
    // changed rather than only the colours. A VHS has TWO windows, one either
    // side of a label in the middle of the face. A compact cassette has one,
    // cut through a label that covers nearly all of it — so its window is a row
    // of the label's own grid rather than a shape lying over one.
    const vhs = mount(facts({ kind: "video" }));
    expect(vhs.querySelectorAll(".case-window").length).toBe(2);
    expect(vhs.querySelector(".case-window.is-left")).not.toBeNull();
    expect(vhs.querySelector(".case-window.is-right")).not.toBeNull();
    expect(vhs.querySelectorAll(".case-reel").length).toBe(2);
    // Beside the label, not inside it.
    expect(vhs.querySelector(".case-label .case-window")).toBeNull();

    again();
    const cassette = mount(facts({ kind: "audio" }));
    expect(cassette.querySelectorAll(".case-window").length).toBe(1);
    expect(cassette.querySelector(".case-label > .case-window")).not.toBeNull();
    expect(cassette.querySelectorAll(".case-reel").length).toBe(2);
    expect(cassette.querySelector(".case-tape")).not.toBeNull();
    // The openings along the bottom edge, which say which way up it is.
    expect(cassette.querySelector(".case-holes")).not.toBeNull();
  });

  it("carries the item's own text as a caption anybody can write on", () => {
    const el = mount(facts({ kind: "audio" }), { text: "call 3 - the second one" });
    const caption = el.querySelector(".case-caption")!;
    expect(caption.textContent).toBe("call 3 - the second one");
    expect(caption.classList.contains("is-empty")).toBe(false);
  });

  // --- T-271: what the object shows when the file is not here ----------------

  describe("an object with no file in it", () => {
    /** An asset in one phase, and how far through it is. */
    const phase = (p: AssetView["phase"], fraction = 0): AssetResolver => () => ({
      url: p === "ready" ? "asset://sha256/x" : "",
      phase: p,
      fraction,
    });

    /** Mount one object of `kind` against a resolver in one phase. */
    function inPhase(kind: AssetFacts["kind"], resolver: AssetResolver): HTMLElement {
      const l = new DomItemLayer(host, resolver, facts({ kind }));
      add("a", { assetId: HASH });
      l.sync(scene, dirty, null);
      return host.firstElementChild as HTMLElement;
    }

    /**
     * **The one that is a defect rather than a drawing.** `assetUrl` is what
     * raises a want to `VISIBLE` and marks a hash requesting, and `CaseView`
     * took the resolver as `_assetUrl` and never called it — so a tape you were
     * sitting in front of queued behind every photograph on the board, at the
     * idle priority `reconcileAssets` had asked for it at on boot.
     */
    it("asks for the bytes of an object that is on the screen", () => {
      const asked: string[] = [];
      inPhase("video", (sha) => {
        asked.push(sha);
        return waiting();
      });
      expect(asked).toEqual([HASH]);
    });

    it("wears the waiting state for every phase short of ready", () => {
      for (const p of ["unknown", "requesting", "transferring", "unavailable"] as const) {
        again();
        expect(inPhase("audio", phase(p)).classList.contains("is-waiting"), p).toBe(true);
      }
      again();
      // And nothing at all once it is here. There is no decode gap on a case
      // object the way there is on a polaroid — the face is CSS, so `ready` is
      // the whole of it.
      const here = inPhase("audio", phase("ready"));
      expect(here.classList.contains("is-waiting")).toBe(false);
      expect(here.style.getPropertyValue("--arrived")).toBe("");
    });

    it("winds the tape on as the transfer runs", () => {
      const el = inPhase("audio", phase("transferring", 0.42));
      expect(el.classList.contains("is-developing")).toBe(true);
      expect(el.style.getPropertyValue("--arrived")).toBe("0.42");
    });

    it("tears when nobody on this board has it, and drops the fraction with it", () => {
      // Through a transfer that stops, rather than straight into `unavailable`,
      // because the fraction is only ever *written* by the phase before this
      // one — the peer holding a 400 MB interview closing its window is exactly
      // how this is reached. Left set, the tape would be drawn half wound on and
      // with its ribbon out of the shell at the same time.
      let view: AssetView = { url: "", phase: "transferring", fraction: 0.5 };
      const l = new DomItemLayer(host, () => view, facts({ kind: "video" }));
      add("a", { assetId: HASH });
      l.sync(scene, dirty, null);
      const el = host.firstElementChild as HTMLElement;
      expect(el.style.getPropertyValue("--arrived")).toBe("0.50");

      view = { url: "", phase: "unavailable", fraction: 0 };
      dirty.item("a");
      l.sync(scene, dirty, null);
      expect(el.classList.contains("is-torn")).toBe(true);
      expect(el.classList.contains("is-developing")).toBe(false);
      expect(el.style.getPropertyValue("--arrived")).toBe("");
    });

    /**
     * The phase is not a document write, so nothing about the item changes when
     * the bytes land. `CaseView`'s guard was the cold identity and a digest of
     * the record, and both of those are the same on the frame after a transfer
     * finishes as on the frame before it.
     */
    it("repaints when the bytes arrive, which the document never mentions", () => {
      let view: AssetView = { url: "", phase: "transferring", fraction: 0.5 };
      const l = new DomItemLayer(host, () => view, facts({ kind: "document", pages: 142 }));
      add("a", { assetId: HASH });
      l.sync(scene, dirty, null);
      const el = host.firstElementChild as HTMLElement;
      expect(el.classList.contains("is-developing")).toBe(true);

      view = { url: "asset://sha256/x", phase: "ready", fraction: 0 };
      dirty.item("a");
      l.sync(scene, dirty, null);
      expect(el.classList.contains("is-developing")).toBe(false);
      expect(el.classList.contains("is-waiting")).toBe(false);
    });

    /**
     * And every label is still readable in all four of them — AC-668 does not
     * get quieter because the file is late. A page count comes off the record,
     * and the record is a peer's write that arrives long before the bytes.
     */
    it("says the case number and the page count in every one of the states", () => {
      for (const p of ["unknown", "requesting", "transferring", "unavailable", "ready"] as const) {
        again();
        const l = new DomItemLayer(
          host,
          phase(p, 0.3),
          facts({ kind: "document", name: "dossier.pdf", pages: 142 }),
        );
        add("a", { assetId: HASH });
        l.sync(scene, dirty, null);
        expect(host.querySelector(".case-number")!.textContent, p).toBe("dossier");
        expect(host.querySelector(".case-meta")!.textContent, p).toBe("142 pp.");
      }
    });

    /**
     * A pooled node that was last a torn cassette must not come back as one. The
     * trap is specific: `paintContents` is guarded on the phase, and a board
     * joining cold is a wall of objects *all* equally not here — so the item this
     * node is handed to next is very often in the same phase, and the guard would
     * correctly decide there was nothing to repaint while the node still wore the
     * last object's fraction.
     */
    it("re-dresses a recycled node that comes back in the state it left in", () => {
      // The *same* phase on both sides, which is the case the guard gets wrong
      // and the only one worth a test: `release` strips the classes off the node
      // and a guard comparing the new phase against the one still recorded would
      // decide there was nothing to repaint. Two objects equally not here is not
      // a corner — it is what a board looks like the moment somebody joins it.
      const l = new DomItemLayer(host, () => waiting(), facts({ kind: "audio" }));
      add("a", { assetId: HASH });
      l.sync(scene, dirty, null);
      const el = host.firstElementChild as HTMLElement;
      expect(el.classList.contains("is-waiting")).toBe(true);

      scene.removeItem("a");
      dirty.item("a");
      l.sync(scene, dirty, null);
      add("b", { assetId: HASH });
      l.sync(scene, dirty, null);

      const next = host.firstElementChild as HTMLElement;
      expect(next, "the same node, out of the pool").toBe(el);
      expect(next.classList.contains("is-waiting")).toBe(true);
    });
  });
});
