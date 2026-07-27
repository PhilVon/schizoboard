import { beforeEach, describe, expect, it } from "vitest";

import { mulberry32 } from "@/lib/seed";
import { ItemIndex } from "@/sim/collide";
import { DirtySets } from "@/state/dirty";
import { Scene, type Bounds } from "@/state/scene";

let scene: Scene;
let dirty: DirtySets;
let index: ItemIndex;

beforeEach(() => {
  scene = new Scene();
  dirty = new DirtySets();
  index = new ItemIndex();
});

function put(id: string, x: number, y: number, w = 100, h = 100, rot = 0): void {
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x, y, rot, w, h },
  );
  dirty.item(id);
}

function rect(minX: number, minY: number, maxX: number, maxY: number): Bounds {
  return { minX, minY, maxX, maxY };
}

/** One frame: refresh the index, then let the frame end as the loop would. */
function frame(): void {
  index.update(scene, dirty);
  dirty.clear();
}

/** The candidates, as ids, sorted — slots are an implementation detail. */
function ask(box: Bounds): string[] {
  const slots = index.query(scene, box, []);
  const ids = new Set<string>();
  for (const slot of slots) {
    const id = scene.idAt(slot);
    if (id !== null) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * The answer the slow obvious way — the oracle for the fuzz below and a second
 * opinion on the hand-written cases. Unpadded, because a string rests on the
 * paper and not on its shadow.
 */
function bruteForce(box: Bounds): string[] {
  const out: string[] = [];
  const b: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  for (const id of scene.itemIds()) {
    scene.boundsOf(id, 0, b);
    if (b.minX <= box.maxX && b.maxX >= box.minX && b.minY <= box.maxY && b.maxY >= box.minY) {
      out.push(id);
    }
  }
  return out.sort();
}

describe("the broad phase", () => {
  it("returns an item the box overlaps", () => {
    put("photo", 0, 0);
    frame();
    expect(ask(rect(-10, -10, 10, 10))).toEqual(["photo"]);
  });

  it("does not return an item the box misses", () => {
    put("photo", 0, 0);
    frame();
    // Well clear, and in a different cell.
    expect(ask(rect(2000, 2000, 2100, 2100))).toEqual([]);
  });

  /**
   * The near miss is the one worth pinning: a rope passing a hand's width from
   * a photograph must not be a candidate, or every rope on a busy board pays
   * the exact test against half its neighbours.
   */
  it("does not return an item just outside the box, in the same cell", () => {
    put("photo", 0, 0); // spans -50..50
    frame();
    expect(ask(rect(51, -10, 60, 10))).toEqual([]);
    expect(ask(rect(50, -10, 60, 10))).toEqual(["photo"]);
  });

  /**
   * A tilted polaroid reaches further than its width, and the index has to say
   * so — a rope that clips the corner of a rotated photo still rests on it.
   */
  it("uses the rotation-expanded box, so a tilted item reaches further", () => {
    put("photo", 0, 0, 100, 100, Math.PI / 4);
    frame();
    const reach = (100 * Math.SQRT2) / 2; // ~70.7
    expect(ask(rect(reach - 1, -1, reach, 1))).toEqual(["photo"]);
    expect(ask(rect(reach + 1, -1, reach + 2, 1))).toEqual([]);
  });

  /**
   * The silhouette is the paper. The culler pads by the shadow because a shadow
   * is drawn; a string does not rest on a shadow, and if this padded the same
   * way every rope near a photograph would hang visibly clear of it.
   */
  it("indexes the paper, with no shadow pad", () => {
    put("photo", 0, 0); // spans -50..50 exactly
    frame();
    expect(ask(rect(50.5, -10, 51, 10))).toEqual([]);
  });

  it("finds an item across a cell boundary from the query", () => {
    // CELL is 512. An item straddling the line and a box in the next cell over.
    put("photo", 500, 0, 100, 100); // spans 450..550
    frame();
    expect(ask(rect(520, -10, 530, 10))).toEqual(["photo"]);
  });
});

describe("staying in line with the scene", () => {
  it("follows an item that moved", () => {
    put("photo", 0, 0);
    frame();

    scene.setPose("photo", { x: 3000 });
    dirty.item("photo");
    frame();

    expect(ask(rect(-10, -10, 10, 10))).toEqual([]);
    expect(ask(rect(2990, -10, 3010, 10))).toEqual(["photo"]);
  });

  /**
   * Rotation moves nothing and changes the box, which is the case a "did the
   * centre move?" shortcut would miss.
   */
  it("follows an item that only rotated", () => {
    put("photo", 0, 0, 200, 20); // spans -100..100 by -10..10
    frame();
    expect(ask(rect(-5, 60, 5, 70))).toEqual([]);

    scene.setPose("photo", { rot: Math.PI / 2 });
    dirty.item("photo");
    frame();
    expect(ask(rect(-5, 60, 5, 70))).toEqual(["photo"]);
  });

  /**
   * The swing is a *transient* rotation nothing writes down, and a hanging item
   * is drawn where the swing puts it — so that is where a string has to rest on
   * it. Reading `rot` alone would drape ropes onto a photograph's stored pose
   * while it visibly hangs somewhere else.
   */
  it("follows the transient swing and drift, not just the stored pose", () => {
    put("photo", 0, 0, 200, 20);
    frame();
    expect(ask(rect(295, -5, 305, 5))).toEqual([]);

    const slot = scene.slotOf("photo")!;
    scene.driftX[slot] = 300;
    dirty.item("photo");
    frame();
    expect(ask(rect(295, -5, 305, 5))).toEqual(["photo"]);
  });

  it("picks up an item that arrived", () => {
    put("first", 0, 0);
    frame();
    put("second", 3000, 0);
    frame();
    expect(ask(rect(2990, -10, 3010, 10))).toEqual(["second"]);
  });

  it("drops an item that was deleted", () => {
    put("photo", 0, 0);
    frame();
    scene.removeItem("photo");
    dirty.item("photo");
    frame();
    expect(ask(rect(-10, -10, 10, 10))).toEqual([]);
  });

  /**
   * A deleted item leaves its bucket entries behind, and the slot is recycled.
   * The item that inherits it must not be findable at the old one's address.
   */
  it("does not report the previous occupant of a recycled slot", () => {
    put("gone", 0, 0);
    frame();
    scene.removeItem("gone");
    dirty.item("gone");
    put("new", 3000, 0);
    frame();

    expect(ask(rect(-10, -10, 10, 10))).toEqual([]);
    expect(ask(rect(2990, -10, 3010, 10))).toEqual(["new"]);
  });

  /**
   * `dirty.all` is a load, an undo, a document swap — the mirror was rebuilt
   * underneath, and the index has no way to diff it.
   */
  it("rebuilds from scratch on dirty.all", () => {
    put("photo", 0, 0);
    frame();

    // A second scene's worth of items, arriving without individual dirt.
    const fresh = new Scene();
    scene = fresh;
    scene.putItem(
      { id: "after", type: "note", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
      { x: 0, y: 0, rot: 0, w: 100, h: 100 },
    );
    dirty.everything();
    frame();

    expect(ask(rect(-10, -10, 10, 10))).toEqual(["after"]);
  });

  /**
   * An index meeting a scene that is already full, with nothing dirty, must
   * still answer. Not how `main.ts` wires it, but exactly the shape of bug that
   * presents as "draping works, but only sometimes".
   */
  it("builds itself the first time it is asked, however little is dirty", () => {
    put("photo", 0, 0);
    dirty.clear();
    frame();
    expect(ask(rect(-10, -10, 10, 10))).toEqual(["photo"]);
  });

  it("forgets everything on clear", () => {
    put("photo", 0, 0);
    frame();
    index.clear();
    // Nothing is dirty, so only the `built` guard can make this right.
    index.update(scene, dirty);
    expect(ask(rect(-10, -10, 10, 10))).toEqual(["photo"]);
  });
});

/**
 * An item too big to bucket cannot be dropped, because dropping it is a rope
 * falling through a photograph. It becomes a candidate for every query instead.
 * `readItem` clamps item size from below and not from above, so a corrupt or
 * hostile document is all it takes.
 */
describe("an item too big to bucket", () => {
  it("is a candidate everywhere", () => {
    put("huge", 0, 0, 1e6, 1e6);
    put("normal", 0, 0);
    frame();
    expect(ask(rect(400000, 400000, 400010, 400010))).toEqual(["huge"]);
    expect(ask(rect(-10, -10, 10, 10))).toEqual(["huge", "normal"]);
  });

  it("stops being one once it is deleted", () => {
    put("huge", 0, 0, 1e6, 1e6);
    frame();
    scene.removeItem("huge");
    dirty.item("huge");
    frame();
    expect(ask(rect(400000, 400000, 400010, 400010))).toEqual([]);
  });
});

/**
 * The whole point: a board of five hundred items answers a rope's query without
 * walking five hundred items.
 */
describe("cost", () => {
  it("does not walk the board to answer one rope's question", () => {
    for (let i = 0; i < 500; i++) {
      put(`i${i}`, (i % 25) * 900, Math.floor(i / 25) * 900);
    }
    frame();

    let seen = 0;
    const original = scene.idAt.bind(scene);
    scene.idAt = (slot: number): string | null => {
      seen++;
      return original(slot);
    };
    index.query(scene, rect(-10, -10, 10, 10), []);

    // Four cells' worth of buckets on an empty stretch of board, not 500.
    expect(seen).toBeLessThan(20);
  });
});

/**
 * Against the oracle, on boards built to have every awkward case in them:
 * items straddling cell boundaries, rotated ones, overlapping ones, and queries
 * that fall in gaps.
 */
describe("versus the slow obvious answer", () => {
  it("agrees, over a few thousand random queries", () => {
    const rng = mulberry32(0xd12a9e);
    for (let i = 0; i < 120; i++) {
      const w = 20 + rng() * 400;
      const h = 20 + rng() * 400;
      put(`i${i}`, (rng() - 0.5) * 4000, (rng() - 0.5) * 4000, w, h, rng() * Math.PI * 2);
    }
    frame();

    for (let q = 0; q < 3000; q++) {
      const x = (rng() - 0.5) * 4400;
      const y = (rng() - 0.5) * 4400;
      const box = rect(x, y, x + rng() * 500, y + rng() * 500);
      expect(ask(box)).toEqual(bruteForce(box));
    }
  });

  it("agrees while items are being moved about", () => {
    const rng = mulberry32(0x5eed);
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      ids.push(`i${i}`);
      put(`i${i}`, (rng() - 0.5) * 2000, (rng() - 0.5) * 2000, 100 + rng() * 200, 100 + rng() * 200);
    }
    frame();

    for (let step = 0; step < 200; step++) {
      const id = ids[Math.floor(rng() * ids.length)]!;
      scene.setPose(id, {
        x: (rng() - 0.5) * 2400,
        y: (rng() - 0.5) * 2400,
        rot: rng() * Math.PI * 2,
      });
      dirty.item(id);
      frame();

      const x = (rng() - 0.5) * 2600;
      const y = (rng() - 0.5) * 2600;
      const box = rect(x, y, x + rng() * 400, y + rng() * 400);
      expect(ask(box)).toEqual(bruteForce(box));
    }
  });
});
