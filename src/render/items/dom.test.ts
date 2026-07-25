/**
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it } from "vitest";

import { DomItemLayer } from "@/render/items/dom";
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

  it("shows the waiting state for a polaroid with no bytes yet", () => {
    add("a", { assetId: null });
    add("b", { assetId: "abc" });
    layer.sync(scene, dirty, null);
    const waiting = [...host.children].filter((el) => el.classList.contains("is-waiting"));
    expect(waiting.length).toBe(1);
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
