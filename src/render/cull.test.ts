import { beforeEach, describe, expect, it } from "vitest";

import { Culler, ENTER_MARGIN, LEAVE_MARGIN } from "@/render/cull";
import { SHADOW_PAD } from "@/render/items/shadow";
import { mulberry32 } from "@/lib/seed";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene, type Bounds } from "@/state/scene";

let scene: Scene;
let dirty: DirtySets;
let camera: Camera;
let culler: Culler;

beforeEach(() => {
  scene = new Scene();
  dirty = new DirtySets();
  camera = new Camera();
  camera.resize(800, 600);
  culler = new Culler();
});

function put(id: string, x: number, y: number, w = 100, h = 100, rot = 0): void {
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x, y, rot, w, h },
  );
  dirty.item(id);
}

/** One frame's worth: cull, then let the frame end. */
function frame(): ReadonlySet<string> {
  culler.update(scene, dirty, camera);
  dirty.clear();
  return culler.visible;
}

/**
 * Half-extent of a 2-unit item once the shadow padding is on it.
 *
 * Every threshold the culler applies is a threshold on the *padded* box, so the
 * tests below say where the padded box goes and let this convert. Writing them
 * in terms of the item's centre instead means encoding the padding a second
 * time, in the test, where a mistake looks like a passing assertion.
 */
const TINY_HALF = 1 + SHADOW_PAD;

/** A 2x2 item placed so its padded box starts exactly at `paddedLeft`. */
function putPaddedLeft(id: string, paddedLeft: number, y = 300): void {
  put(id, paddedLeft + TINY_HALF, y, 2, 2);
}

function movePaddedLeft(id: string, paddedLeft: number): void {
  scene.setPose(id, { x: paddedLeft + TINY_HALF });
  dirty.item(id);
}

/**
 * The answer, computed the slow obvious way — the oracle for the fuzz below and
 * a second opinion on the hand-written cases.
 */
function bruteForce(rect: Bounds, pad = SHADOW_PAD): Set<string> {
  const out = new Set<string>();
  const b: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  for (const id of scene.itemIds()) {
    scene.boundsOf(id, pad, b);
    if (b.minX <= rect.maxX && b.maxX >= rect.minX && b.minY <= rect.maxY && b.maxY >= rect.minY) {
      out.add(id);
    }
  }
  return out;
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

/**
 * Enough items, spread thinly, that the grid is the cheaper path — otherwise the
 * culler quite correctly answers with the dense scan and a test about the grid
 * proves nothing. All of them sit far off screen so they never join `visible`.
 */
function fillerFarAway(count = 20): void {
  for (let i = 0; i < count; i++) put(`filler${i}`, 100_000 + i * 900, 100_000, 40, 40);
}

describe("Culler", () => {
  it("mounts what is on screen and leaves the rest of the board alone", () => {
    put("here", 400, 300);
    put("far", 40_000, 40_000);
    expect(sorted(frame())).toEqual(["here"]);
    // The board still holds both. Culling changes what is mounted, not what is.
    expect(scene.size).toBe(2);
  });

  it("keeps an item off screen but inside the 20% margin", () => {
    const viewport = camera.visibleBounds(0);
    putPaddedLeft("edge", viewport.maxX + 1);
    // Not on screen at all...
    expect(bruteForce(viewport).has("edge")).toBe(false);
    // ...and mounted anyway, which is what the margin is for: it is about to be.
    expect(sorted(frame())).toEqual(["edge"]);
  });

  it("uses rotation-expanded bounds, so a tilted item does not pop at the edge", () => {
    // A long thin bar turned a quarter turn reaches 200 units vertically; flat, it
    // reaches 5. Placed below the viewport, only the rotated extent gets near.
    put("bar", 400, 900, 400, 10, Math.PI / 2);
    expect(sorted(frame())).toEqual(["bar"]);

    // Straighten it and the same centre is out of reach — of the band, too.
    scene.setPose("bar", { rot: 0 });
    dirty.item("bar");
    expect(sorted(frame())).toEqual([]);
  });

  it("pads by the shadow, so a shadow never pops in at the viewport edge", () => {
    // Outside the enter rectangle by its own box, inside it by its shadow.
    const enter = camera.visibleBounds(ENTER_MARGIN);
    put("caster", enter.maxX + 30, 300, 2, 2);
    expect(bruteForce(enter, 0).has("caster")).toBe(false);
    expect(sorted(frame())).toEqual(["caster"]);
  });

  describe("the hysteresis band", () => {
    it("holds a mounted item past the enter rectangle, then lets it go", () => {
      const enter = camera.visibleBounds(ENTER_MARGIN);
      const leave = camera.visibleBounds(LEAVE_MARGIN);

      putPaddedLeft("a", enter.maxX - 1);
      expect(sorted(frame())).toEqual(["a"]);

      // Out of the enter rectangle, still inside the band.
      movePaddedLeft("a", enter.maxX + 1);
      expect(sorted(frame())).toEqual(["a"]);

      // Past the band.
      movePaddedLeft("a", leave.maxX + 1);
      expect(sorted(frame())).toEqual([]);
    });

    it("does not let an unmounted item back in until it clears the enter rectangle", () => {
      const enter = camera.visibleBounds(ENTER_MARGIN);
      // Starts inside the band, having never been mounted. The band is not an
      // entry condition, or it would just be a bigger viewport.
      putPaddedLeft("a", enter.maxX + 1);
      expect(sorted(frame())).toEqual([]);

      movePaddedLeft("a", enter.maxX - 1);
      expect(sorted(frame())).toEqual(["a"]);
    });

    it("does not thrash a boundary item as the camera jitters back and forth", () => {
      const enter = camera.visibleBounds(ENTER_MARGIN);
      putPaddedLeft("a", enter.maxX - 1);
      expect(sorted(frame())).toEqual(["a"]);

      // A wheel or a tremor: a couple of board units, over and over. Without the
      // band every one of these frames is a DOM insertion and a rebind.
      for (let i = 0; i < 20; i++) {
        camera.panByBoard(i % 2 === 0 ? 3 : -3, 0);
        dirty.camera = true;
        expect(sorted(frame())).toEqual(["a"]);
      }
    });
  });

  describe("invalidation", () => {
    it("follows an item that moves into view with nothing but its own dirty flag", () => {
      put("a", 40_000, 40_000);
      expect(sorted(frame())).toEqual([]);

      scene.setPose("a", { x: 400, y: 300 });
      dirty.item("a");
      expect(sorted(frame())).toEqual(["a"]);
    });

    it("drops an item deleted out from under it", () => {
      put("a", 400, 300);
      expect(sorted(frame())).toEqual(["a"]);

      scene.removeItem("a");
      dirty.item("a");
      expect(sorted(frame())).toEqual([]);
    });

    it("gets a reused slot right, stale grid entries and all", () => {
      // The scene reuses slots, so a deleted item's index entries describe
      // whatever moves in next. Getting this wrong shows up as an item that is on
      // screen and not drawn.
      fillerFarAway();
      put("gone", 40_000, 40_000);
      frame();
      expect(culler.path).toBe("grid");

      const slot = scene.slotOf("gone")!;
      scene.removeItem("gone");
      dirty.item("gone");
      frame();

      put("fresh", 400, 300);
      expect(scene.slotOf("fresh")).toBe(slot);
      expect(sorted(frame())).toEqual(["fresh"]);
    });

    it("survives a camera-only frame against a scene it has never indexed", () => {
      // Not how main.ts wires it — a load always arrives with dirty.all — but the
      // failure mode is half a board silently missing, so it is worth nailing.
      put("a", 400, 300);
      dirty.clear();
      dirty.camera = true;
      expect(sorted(frame())).toEqual(["a"]);
    });

    it("does no work when only ropes changed", () => {
      put("a", 400, 300);
      frame();

      culler.path = "none";
      dirty.rope("r1");
      frame();
      // A rope moving cannot move an item, so the answer cannot have changed.
      expect(culler.path).toBe("none");
      expect(sorted(culler.visible)).toEqual(["a"]);
    });

    it("rebuilds from scratch on dirty.all", () => {
      put("a", 400, 300);
      frame();
      scene.clear();
      put("b", 400, 300);
      dirty.everything();
      expect(sorted(frame())).toEqual(["b"]);
    });
  });

  describe("choosing a path", () => {
    it("takes the grid when the viewport covers fewer cells than there are items", () => {
      for (let i = 0; i < 200; i++) put(`i${i}`, (i % 20) * 90, Math.floor(i / 20) * 90, 40, 40);
      frame();
      expect(culler.path).toBe("grid");
    });

    it("takes the dense scan when a handful of items outnumber nothing", () => {
      // Small board, ordinary zoom: the viewport already covers more cells than
      // there are items, so walking the buckets would be the more expensive way
      // to arrive at the same answer.
      put("a", 400, 300);
      frame();
      expect(culler.path).toBe("scan");
    });

    it("takes the dense scan when zoomed out far enough to cover every cell", () => {
      for (let i = 0; i < 40; i++) put(`i${i}`, i * 300, i * 300, 40, 40);
      camera.setView(-200_000, -200_000, 0.05);
      dirty.camera = true;
      frame();
      expect(culler.path).toBe("scan");
    });

    it("falls back to the scan for an item too large to index, and recovers", () => {
      fillerFarAway();
      put("small", 400, 300, 40, 40);
      // `readItem` clamps item size from below and not from above, so a corrupt
      // peer can write this. Indexing it would insert into millions of buckets.
      put("huge", 400, 300, 5_000_000, 5_000_000);
      expect(sorted(frame())).toEqual(["huge", "small"]);
      expect(culler.path).toBe("scan");

      // And a corrupt item that is then deleted must not leave the culler
      // scanning for the rest of the session.
      scene.removeItem("huge");
      dirty.item("huge");
      frame();
      expect(culler.path).toBe("grid");
      expect(sorted(culler.visible)).toEqual(["small"]);
    });
  });

  /**
   * The test that makes the index trustworthy.
   *
   * A spatial index maintained incrementally fails in one characteristic way: a
   * stale entry, so an item that is on screen is never drawn. That is invisible
   * in every hand-written case, because a hand-written case is one you thought
   * of. So: four hundred randomised frames of items moving, appearing and being
   * deleted while the camera pans and zooms, each checked against brute force.
   *
   * The band makes the exact answer path-dependent — what stays mounted depends
   * on what was mounted — so the oracle is a pair of bounds rather than a set:
   * everything inside the enter rectangle must be mounted, and nothing outside
   * the leave rectangle may be.
   */
  it("agrees with a brute-force scan across randomised frames", () => {
    const random = mulberry32(0x5c4177ed);
    const pick = (n: number): number => Math.floor(random() * n);
    const live: string[] = [];
    let minted = 0;

    const mint = (): void => {
      const id = `s${minted++}`;
      put(id, pick(8000) - 4000, pick(8000) - 4000, 40 + pick(300), 40 + pick(300));
      live.push(id);
    };

    for (let i = 0; i < 60; i++) mint();
    frame();

    let sawGrid = false;
    let sawScan = false;

    for (let step = 0; step < 400; step++) {
      const roll = random();
      if (roll < 0.35) {
        const id = live[pick(live.length)];
        if (id !== undefined) {
          scene.setPose(id, {
            x: pick(8000) - 4000,
            y: pick(8000) - 4000,
            rot: random() * Math.PI * 2,
          });
          dirty.item(id);
        }
      } else if (roll < 0.5) {
        mint();
      } else if (roll < 0.6 && live.length > 1) {
        // Deletion is what recycles slots, which is what goes stale.
        const id = live.splice(pick(live.length), 1)[0]!;
        scene.removeItem(id);
        dirty.item(id);
      } else if (roll < 0.85) {
        camera.panByBoard(pick(2000) - 1000, pick(2000) - 1000);
        dirty.camera = true;
      } else {
        camera.zoomTo(0.05 + random() * 3, 400, 300);
        dirty.camera = true;
      }

      const visible = frame();
      if (culler.path === "grid") sawGrid = true;
      if (culler.path === "scan") sawScan = true;

      const mustBeIn = bruteForce(camera.visibleBounds(ENTER_MARGIN));
      const mayBeIn = bruteForce(camera.visibleBounds(LEAVE_MARGIN));

      for (const id of mustBeIn) {
        expect(visible.has(id), `step ${step}: ${id} is on screen and not mounted`).toBe(true);
      }
      for (const id of visible) {
        expect(mayBeIn.has(id), `step ${step}: ${id} is mounted and far off screen`).toBe(true);
      }
    }

    // Both access paths have to have actually run, or this proves half of it.
    expect(sawGrid).toBe(true);
    expect(sawScan).toBe(true);
  });
});
