/**
 * The selection chrome's geometry, with no canvas and no pointer.
 *
 * Everything here is arithmetic shared by the module that draws the handles and
 * the module that lets you grab them, which is the whole reason it is one module
 * — so these tests are the contract between `render/overlay.ts` and
 * `state/tools/select.ts` rather than tests of either.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { Camera } from "@/state/camera";
import {
  chromeFrame,
  emptyFrame,
  EDGE_GRAB_IN,
  EDGE_GRAB_OUT,
  handleAt,
  handleAxes,
  handleCursor,
  HANDLE_STALK,
  rotateHandle,
  SELECT_PAD,
  type HandleFrame,
} from "@/state/handles";
import { Scene } from "@/state/scene";
import { Selection } from "@/state/selection";

let camera: Camera;
let scene: Scene;
let selection: Selection;
let out: HandleFrame;

/** The camera sits at the origin at 100%, so board coordinates *are* screen ones. */
beforeEach(() => {
  camera = new Camera();
  camera.resize(1000, 800);
  scene = new Scene();
  selection = new Selection();
  out = emptyFrame();
});

function put(id: string, type: string, x = 200, y = 200, w = 200, h = 100, rot = 0): void {
  scene.putItem(
    { id, type, z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x, y, rot, w, h },
  );
}

function frameOf(): HandleFrame {
  const frame = chromeFrame(camera, scene, selection, out);
  if (!frame) throw new Error("expected a frame");
  return frame;
}

describe("whose handles", () => {
  it("gives none to an empty selection", () => {
    put("a", "note");
    expect(chromeFrame(camera, scene, selection, out)).toBeNull();
  });

  it("gives none to a group, which rotates with R+drag instead", () => {
    put("a", "note", 100, 100);
    put("b", "note", 400, 100);
    selection.replace(["a", "b"]);
    expect(chromeFrame(camera, scene, selection, out)).toBeNull();
  });

  it("gives none for an item a collaborator has just deleted", () => {
    put("a", "note");
    selection.replace(["a"]);
    scene.removeItem("a");
    expect(chromeFrame(camera, scene, selection, out)).toBeNull();
  });

  it("marks paper resizable and a photograph not — a photograph is the size it is", () => {
    put("a", "note");
    selection.replace(["a"]);
    expect(frameOf().resizable).toBe(true);

    scene.clear();
    put("b", "polaroid");
    selection.replace(["b"]);
    expect(frameOf().resizable).toBe(false);
  });
});

describe("the rotation handle", () => {
  it("stands the same screen distance off the paper at every zoom", () => {
    put("a", "note");
    selection.replace(["a"]);

    const offsets: number[] = [];
    for (const zoom of [0.05, 1, 4]) {
      camera.zoomTo(zoom, 0, 0);
      const frame = frameOf();
      const knob = rotateHandle(frame, { x: 0, y: 0 });
      offsets.push(Math.hypot(knob.x - frame.cx, knob.y - frame.cy) - frame.hh);
    }
    for (const offset of offsets) expect(offset).toBeCloseTo(HANDLE_STALK, 6);
  });

  it("rides the item's rotation, so it says which way is up on the paper", () => {
    // A quarter turn puts the paper's top edge towards screen east.
    put("a", "note", 200, 200, 200, 100, Math.PI / 2);
    selection.replace(["a"]);
    const frame = frameOf();
    const knob = rotateHandle(frame, { x: 0, y: 0 });
    // Approximate because the scene stores Float32: a quarter turn comes back as
    // 1.5707963705062866, whose cosine is three millionths rather than zero.
    expect(knob.x).toBeCloseTo(200 + 50 + SELECT_PAD + HANDLE_STALK, 4);
    expect(knob.y).toBeCloseTo(200, 4);
  });

  it("claims a press that lands on it, even over bare cork", () => {
    put("a", "note");
    selection.replace(["a"]);
    const frame = frameOf();
    const knob = rotateHandle(frame, { x: 0, y: 0 });
    expect(handleAt(frame, knob.x, knob.y)).toBe("rotate");
    // And the knob is out in the open, well clear of the paper it belongs to.
    expect(knob.y).toBeLessThan(200 - 50);
  });

  it("is the one handle a photograph keeps", () => {
    put("a", "polaroid");
    selection.replace(["a"]);
    const frame = frameOf();
    const knob = rotateHandle(frame, { x: 0, y: 0 });
    expect(handleAt(frame, knob.x, knob.y)).toBe("rotate");
    expect(handleAt(frame, 200 + 100, 200)).toBeNull();
  });
});

describe("the resize band", () => {
  beforeEach(() => {
    put("a", "note", 200, 200, 200, 100);
    selection.replace(["a"]);
  });

  it("reaches further into the cork than into the paper", () => {
    const frame = frameOf();
    // The paper's east edge is at 300, and the band is measured from there.
    expect(handleAt(frame, 300 + EDGE_GRAB_OUT - 0.5, 200)).toBe("e");
    expect(handleAt(frame, 300 + EDGE_GRAB_OUT + 2, 200)).toBeNull();
    expect(handleAt(frame, 300 - EDGE_GRAB_IN + 0.5, 200)).toBe("e");
    expect(handleAt(frame, 300 - EDGE_GRAB_IN - 2, 200)).toBeNull();
  });

  it("names each edge and corner in the item's own frame", () => {
    const frame = frameOf();
    expect(handleAt(frame, 200, 150)).toBe("n");
    expect(handleAt(frame, 200, 250)).toBe("s");
    expect(handleAt(frame, 100, 200)).toBe("w");
    expect(handleAt(frame, 300, 200)).toBe("e");
    expect(handleAt(frame, 300, 250)).toBe("se");
    expect(handleAt(frame, 100, 150)).toBe("nw");
  });

  it("leaves the middle of the paper alone, so a note can still be dragged", () => {
    expect(handleAt(frameOf(), 200, 200)).toBeNull();
  });

  it("turns with the item — the paper's east edge, not the screen's", () => {
    scene.setPose("a", { rot: Math.PI / 2 });
    const frame = frameOf();
    // A quarter turn: the paper is now 100 wide and 200 tall on screen, and its
    // own east edge points south.
    expect(handleAt(frame, 200, 300)).toBe("e");
    expect(handleAt(frame, 250, 200)).toBe("n");
  });

  it("resolves a point inside a note too small to have a middle", () => {
    scene.setPose("a", { w: 4, h: 4 });
    const frame = frameOf();
    // Every part of it is within reach of two edges; the nearer ones win.
    expect(handleAt(frame, 199, 199)).toBe("nw");
    expect(handleAt(frame, 201, 201)).toBe("se");
  });
});

describe("which way a handle pushes", () => {
  it("maps each compass point to its axes", () => {
    expect(handleAxes("e")).toEqual({ u: 1, v: 0 });
    expect(handleAxes("nw")).toEqual({ u: -1, v: -1 });
    expect(handleAxes("s")).toEqual({ u: 0, v: 1 });
    expect(handleAxes("rotate")).toEqual({ u: 0, v: 0 });
  });
});

describe("the cursor", () => {
  it("is the only affordance a resize edge has, and it turns with the item", () => {
    expect(handleCursor("e", 0)).toBe("ew-resize");
    expect(handleCursor("n", 0)).toBe("ns-resize");
    expect(handleCursor("se", 0)).toBe("nwse-resize");
    expect(handleCursor("ne", 0)).toBe("nesw-resize");

    // Turn the item a quarter turn and the east edge points south.
    expect(handleCursor("e", Math.PI / 2)).toBe("ns-resize");
    expect(handleCursor("se", Math.PI / 2)).toBe("nesw-resize");
    // Half a turn is the same pair of cursors as none at all.
    expect(handleCursor("e", Math.PI)).toBe("ew-resize");
    expect(handleCursor("se", -Math.PI)).toBe("nwse-resize");
  });

  it("says take hold of it for the knob, there being no rotate cursor in CSS", () => {
    expect(handleCursor("rotate", 1.2)).toBe("grab");
  });
});
