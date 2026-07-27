/**
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it } from "vitest";

import { DomItemLayer, type AssetResolver } from "@/render/items/dom";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemCold, type ItemPose } from "@/state/scene";

let host: HTMLDivElement;
let scene: Scene;
let dirty: DirtySets;
let layer: DomItemLayer;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  scene = new Scene();
  dirty = new DirtySets();
  layer = new DomItemLayer(host, (sha) => `asset://sha256/${sha}`);
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
    let stored = "";
    const late = new DomItemLayer(host, () => stored);
    add("a", { assetId: "abc" });
    late.sync(scene, dirty, null);
    const img = host.querySelector(".pol-photo") as HTMLImageElement;
    expect(img.hasAttribute("src")).toBe(false);

    stored = "asset://sha256/abc";
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
        return `asset://sha256/${sha}?px=${Math.round(px)}`;
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
