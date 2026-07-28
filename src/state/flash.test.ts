/**
 * Unit tests for the undo flash — DESIGN section 7.6.
 *
 * The property worth pinning down is a *diff*, and the two ways a diff of two
 * sets goes wrong are opposite and both silent: lighting up something that was
 * already dirty before the undo (so a board blinks whenever it is used), and
 * lighting up an id that no longer names anything (so the renderer walks a
 * scene slot that has gone).
 */

import { describe, expect, it } from "vitest";

import { DirtySets } from "@/state/dirty";
import { FLASH_MS, Flashes } from "@/state/flash";
import { Scene, type ItemCold, type ItemPose } from "@/state/scene";

function add(scene: Scene, id: string, pose: Partial<ItemPose> = {}): void {
  const cold: ItemCold = {
    id,
    type: "polaroid",
    z: "a0",
    seed: 1,
    assetId: null,
    createdBy: 1,
    createdAt: 0,
    text: "",
  };
  scene.putItem(cold, { x: 0, y: 0, rot: 0, w: 100, h: 100, ...pose });
}

function pin(scene: Scene, id: string, parent: string | null = null): void {
  scene.putPin({ id, parent, lx: 0, ly: 0, kind: "pin", color: "#a00", wx: 0, wy: 0 });
}

function string(scene: Scene, id: string, pins: string[]): void {
  scene.putString({
    id,
    nodes: pins.map((p) => ({ pin: p, nodeId: `n-${p}`, slackAfter: 0.1 })),
    color: "#a00",
    thickness: 2,
    material: "cotton",
    layer: "over",
    closed: false,
  });
}

describe("Flashes", () => {
  it("lights what the write dirtied", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const flashes = new Flashes();
    add(scene, "a");
    pin(scene, "p");
    string(scene, "s", ["p"]);

    expect(flashes.isEmpty).toBe(true);
    flashes.around(dirty, scene, () => {
      dirty.item("a");
      dirty.pin("p");
      dirty.string("s");
    });

    expect([...flashes.items.keys()]).toEqual(["a"]);
    expect([...flashes.pins.keys()]).toEqual(["p"]);
    expect([...flashes.strings.keys()]).toEqual(["s"]);
    expect(flashes.isEmpty).toBe(false);
  });

  it("passes the write's answer back, so undo can still report it did nothing", () => {
    const flashes = new Flashes();
    expect(flashes.around(new DirtySets(), new Scene(), () => false)).toBe(false);
    expect(flashes.around(new DirtySets(), new Scene(), () => 7)).toBe(7);
  });

  /**
   * The whole reason `around` is a diff. Phase 9 drains every queued write of
   * the frame in order, and an undo that arrived behind one of them must not
   * take credit for what the other did.
   */
  it("ignores what was already dirty before the write", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const flashes = new Flashes();
    add(scene, "dragged");
    add(scene, "undone");
    dirty.item("dragged");

    flashes.around(dirty, scene, () => dirty.item("undone"));

    expect([...flashes.items.keys()]).toEqual(["undone"]);
  });

  it("does not light an item the write deleted", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const flashes = new Flashes();
    add(scene, "pasted");

    // Undoing a paste: the binding removes the item from the scene and dirties
    // the id it removed. There is nothing left to draw a box round.
    flashes.around(dirty, scene, () => {
      scene.removeItem("pasted");
      dirty.item("pasted");
    });

    expect(flashes.isEmpty).toBe(true);
  });

  it("does not light a pin or a string the write deleted", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const flashes = new Flashes();
    pin(scene, "p");
    string(scene, "s", ["p"]);

    flashes.around(dirty, scene, () => {
      scene.removeString("s");
      scene.removePin("p");
      dirty.pin("p");
      dirty.string("s");
    });

    expect(flashes.isEmpty).toBe(true);
  });

  /**
   * Undoing a stroke drawn on a photograph moves nothing. Only `dirty.ink`
   * says anything happened, and the one edit whose result is a subtle change
   * to a picture is the one that most needs saying.
   */
  it("lights the item an undone stroke was drawn on", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const flashes = new Flashes();
    add(scene, "a");

    flashes.around(dirty, scene, () => dirty.inkFor("a"));

    expect([...flashes.items.keys()]).toEqual(["a"]);
  });

  it("does not light a cork tile", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const flashes = new Flashes();

    flashes.around(dirty, scene, () => dirty.boardInkFor("3,-2"));

    expect(flashes.isEmpty).toBe(true);
  });

  it("counts an item dirtied both ways only once", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const flashes = new Flashes();
    add(scene, "a");

    flashes.around(dirty, scene, () => {
      dirty.item("a");
      dirty.inkFor("a");
    });

    expect(flashes.items.size).toBe(1);
  });

  it("fades to nothing over its own lifetime, and stays gone", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const flashes = new Flashes();
    add(scene, "a");
    flashes.around(dirty, scene, () => dirty.item("a"));

    expect(flashes.items.get("a")).toBe(1);
    flashes.step(FLASH_MS / 2);
    expect(flashes.items.get("a")).toBeCloseTo(0.5);
    flashes.step(FLASH_MS / 2);
    expect(flashes.isEmpty).toBe(true);
    // And a step on an empty set is not a way to resurrect one.
    flashes.step(16);
    expect(flashes.isEmpty).toBe(true);
  });

  it("restarts a flash the next undo touches again", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const flashes = new Flashes();
    add(scene, "a");

    flashes.around(dirty, scene, () => dirty.item("a"));
    flashes.step(FLASH_MS * 0.75);
    expect(flashes.items.get("a")).toBeCloseTo(0.25);

    dirty.clear();
    flashes.around(dirty, scene, () => dirty.item("a"));
    expect(flashes.items.get("a")).toBe(1);
  });

  it("forgets everything when the document underneath is replaced", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const flashes = new Flashes();
    add(scene, "a");
    flashes.around(dirty, scene, () => dirty.item("a"));

    flashes.clear();

    expect(flashes.isEmpty).toBe(true);
  });
});
