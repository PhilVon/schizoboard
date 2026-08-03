/**
 * @vitest-environment happy-dom
 *
 * Does what is on screen agree with what the scene thinks?
 *
 * Everything that answers "where is this item" — `hitTest`, `intersectsRect`,
 * `chromeFrame`, the selection outline — reads the scene, and the DOM node
 * wears a transform written from the same three numbers. If those two ever
 * drift apart the board stops being clickable where it is visible, and that is
 * exactly the shape of T-107: clicks miss the paper, a marquee over it selects
 * nothing, and the chrome is drawn somewhere else.
 *
 * So this file drives the real loop order — SIM, LAYOUT, DOM — over a hanging
 * item, and reads the transform back off the node.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { DomItemLayer } from "@/render/items/dom";
import { Torsion } from "@/sim/torsion";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { chromeFrame, emptyFrame } from "@/state/handles";
import { Scene, type ItemPose } from "@/state/scene";
import { Selection } from "@/state/selection";

let host: HTMLDivElement;
let scene: Scene;
let dirty: DirtySets;
let camera: Camera;
let sim: Torsion;
let items: DomItemLayer;

const ID = "a";

function put(pose: Partial<ItemPose> = {}): void {
  scene.putItem(
    { id: ID, type: "note", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x: 0, y: 0, rot: 0, w: 240, h: 110, ...pose },
  );
  dirty.item(ID);
}

function pin(lx: number, ly: number): void {
  scene.putPin({ id: "p", parent: ID, lx, ly, kind: "pushpin", color: "#c8352f", page: null, wx: 0, wy: 0 });
  dirty.pin("p");
  dirty.item(ID);
}

/** One frame, in the loop's own phase order (`app/main.ts`). */
function frame(): void {
  sim.step(scene, dirty, 1000 / 60, new Set(), 0);
  if (dirty.all) scene.layoutPins();
  else if (dirty.items.size > 0 || dirty.pins.size > 0) scene.layoutPins(dirty.items);
  items.sync(scene, dirty, null);
  dirty.clear();
}

function settle(): void {
  frame();
  for (let i = 0; i < 900 && sim.awake > 0; i++) frame();
  // One more, so the frame that wrote the sleeping pose has reached the DOM.
  dirty.item(ID);
  frame();
}

/** The centre the node is actually drawn about, parsed back off its transform. */
function drawnCentre(): { x: number; y: number; rot: number } {
  const el = host.firstElementChild as HTMLDivElement;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) rotate\((-?[\d.]+)rad\)/.exec(
    el.style.transform,
  );
  if (!m) throw new Error(`unparsed transform: ${el.style.transform}`);
  const w = parseFloat(el.style.width);
  const h = parseFloat(el.style.height);
  return { x: Number(m[1]) + w / 2, y: Number(m[2]) + h / 2, rot: Number(m[3]) };
}

beforeEach(() => {
  host = document.createElement("div");
  scene = new Scene();
  dirty = new DirtySets();
  camera = new Camera();
  camera.resize(1000, 800);
  sim = new Torsion();
  items = new DomItemLayer(host, () => ({ url: "", phase: "unknown", fraction: 0 }));
});

describe("a hanging item", () => {
  it("is drawn where the scene says it is", () => {
    put({ rot: 0.4 });
    pin(-90, -40);
    settle();

    const slot = scene.slotOf(ID)!;
    const drawn = drawnCentre();
    expect(drawn.x).toBeCloseTo(scene.renderX(slot), 1);
    expect(drawn.y).toBeCloseTo(scene.renderY(slot), 1);
    expect(drawn.rot).toBeCloseTo(scene.rot[slot]! + scene.swing[slot]!, 3);
  });

  it("hit-tests where it is drawn", () => {
    put({ rot: 0.4 });
    pin(-90, -40);
    settle();

    const drawn = drawnCentre();
    expect(items.hitTest(scene, drawn.x, drawn.y)).toBe(ID);
  });

  it("is caught by a marquee over where it is drawn", () => {
    put({ rot: 0.4 });
    pin(-90, -40);
    settle();

    const drawn = drawnCentre();
    const rect = { minX: drawn.x - 10, minY: drawn.y - 10, maxX: drawn.x + 10, maxY: drawn.y + 10 };
    expect(scene.intersectsRect(ID, rect)).toBe(true);
  });

  it("carries its selection chrome on the paper, not beside it", () => {
    put({ rot: 0.4 });
    pin(-90, -40);
    settle();

    const selection = new Selection();
    selection.replace([ID]);
    const frameOut = chromeFrame(camera, scene, selection, emptyFrame())!;
    const drawn = drawnCentre();
    expect(frameOut.cx).toBeCloseTo(camera.boardToScreen(drawn.x, drawn.y).x, 1);
    expect(frameOut.cy).toBeCloseTo(camera.boardToScreen(drawn.x, drawn.y).y, 1);
  });
});

/**
 * The reported sequence (T-107): rotate it while it is hanging, let it settle
 * back to plumb, then take the pin out. By then the authored rotation is not
 * what is on screen — the swing has been carrying the difference — and the
 * paper must not jump when that transient stops existing.
 *
 * Which it will, unless the pin removal writes the pose the item was drawn at.
 * `select.ts` computes that pose and `crdt/ops/pins.ts` writes it in the same
 * transaction; the two lines below stand in for the round trip through the
 * document, which the tests either side of this file cover on their own.
 */
describe("taking the last pin out of a hanging item", () => {
  function turnWhilePinned(): { x: number; y: number; rot: number } {
    put({ rot: 0.4 });
    pin(0, -40);
    settle();
    const hanging = drawnCentre();

    // Turned by the handle while pinned, which writes the authored rotation,
    // then let go so the swing carries it back to plumb.
    scene.setPose(ID, { rot: 1.3 });
    dirty.item(ID);
    settle();
    const afterTurn = drawnCentre();
    expect(afterTurn.rot).toBeCloseTo(hanging.rot, 3);
    return afterTurn;
  }

  /** What `settleOnUnpin` works out and `deletePins` writes. */
  function unpinAndSettle(): void {
    const slot = scene.slotOf(ID)!;
    const settled = {
      x: scene.renderX(slot),
      y: scene.renderY(slot),
      rot: scene.rot[slot]! + scene.swing[slot]!,
    };
    scene.removePin("p");
    scene.setPose(ID, settled);
    dirty.pin("p");
    dirty.item(ID);
    settle();
  }

  it("leaves the paper exactly where it was drawn", () => {
    const afterTurn = turnWhilePinned();
    unpinAndSettle();

    const loose = drawnCentre();
    expect(loose.rot).toBeCloseTo(afterTurn.rot, 3);
    expect(loose.x).toBeCloseTo(afterTurn.x, 1);
    expect(loose.y).toBeCloseTo(afterTurn.y, 1);
  });

  it("stays hit-testable at the place it was left", () => {
    turnWhilePinned();
    unpinAndSettle();

    const drawn = drawnCentre();
    expect(items.hitTest(scene, drawn.x, drawn.y)).toBe(ID);
  });

  /** And the transients really are gone, so nothing is hiding an angle any
   *  more: what is stored is what is drawn. */
  it("leaves nothing transient behind to hide the angle again", () => {
    turnWhilePinned();
    unpinAndSettle();

    const slot = scene.slotOf(ID)!;
    expect(scene.swing[slot]).toBe(0);
    expect(scene.driftX[slot]).toBe(0);
    expect(scene.driftY[slot]).toBe(0);
    expect(scene.renderX(slot)).toBe(scene.x[slot]);
  });
});
