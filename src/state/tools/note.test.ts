/**
 * The note tool, with no document, no renderer and no browser — same seam the
 * select tool's tests use.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";
import { Selection } from "@/state/selection";
import { NoteTool } from "@/state/tools/note";
import type { PointerSample, ToolContext } from "@/state/tools/tool";

let created: { x: number; y: number }[];
let done: number;
let tool: NoteTool;
let ctx: ToolContext;

function at(x: number, y: number): PointerSample {
  return { x, y, shift: false, ctrl: false, alt: false };
}

function down(x: number, y: number): void {
  tool.handle({ kind: "down", at: at(x, y) }, ctx);
}
function up(x: number, y: number): void {
  tool.handle({ kind: "up", at: at(x, y) }, ctx);
}

beforeEach(() => {
  created = [];
  done = 0;
  const camera = new Camera();
  camera.resize(1000, 800);
  tool = new NoteTool({ onDone: () => done++ });
  ctx = {
    scene: new Scene(),
    dirty: new DirtySets(),
    camera,
    selection: new Selection(),
    hitTest: () => null,
    hitPin: () => null,
    hitString: () => null,
    held: new Set<string>(),
    write: {
      setPoses: () => {},
      setSizes: () => {},
      deleteItems: () => {},
      createPin: () => {},
      placePin: () => {},
      deletePins: () => {},
    createString: () => {},
    insertPin: () => {},
    setNodeSlack: () => {},
    scaleNodeSlack: () => {},
    setStringSlack: () => {},
    scaleStringSlack: () => {},
    setStringLayer: () => {},
    deleteStrings: () => {},
    setStringStyle: () => {},
    movePins: () => {},
    commitStrokes: () => {},
    eraseStrokes: () => {},
      createNote: (x, y) => created.push({ x, y }),
    },
  };
});

describe("placing a sheet", () => {
  it("puts one down where the click was", () => {
    down(120, 340);
    up(120, 340);
    expect(created).toEqual([{ x: 120, y: 340 }]);
  });

  it("puts it where the press went down, not where the hand drifted to", () => {
    down(200, 200);
    up(214, 191);
    expect(created).toEqual([{ x: 200, y: 200 }]);
  });

  it("converts through the camera, so it lands under the cursor at any zoom", () => {
    ctx.camera.zoomTo(2, 0, 0);
    ctx.camera.panByBoard(300, -50);
    const expected = ctx.camera.screenToBoard(400, 400);
    down(400, 400);
    up(400, 400);
    expect(created[0]!.x).toBeCloseTo(expected.x, 9);
    expect(created[0]!.y).toBeCloseTo(expected.y, 9);
  });

  it("hands the board back after one sheet, so the tool cannot stay armed", () => {
    down(10, 10);
    up(10, 10);
    expect(done).toBe(1);
  });

  it("ignores a release that had no press before it", () => {
    up(50, 50);
    expect(created).toEqual([]);
    expect(done).toBe(0);
  });
});

describe("giving up", () => {
  it("places nothing on Escape, and goes back to select", () => {
    down(10, 10);
    tool.handle({ kind: "key", code: "Escape", shift: false, ctrl: false, alt: false }, ctx);
    up(10, 10);
    expect(created).toEqual([]);
    expect(done).toBe(1);
  });

  it("forgets a lost pointer without switching tool underneath the user", () => {
    down(10, 10);
    tool.handle({ kind: "cancel" }, ctx);
    up(10, 10);
    expect(created).toEqual([]);
    // A window that lost focus mid-click has not finished with the tool; coming
    // back to find the board in a different one is its own surprise.
    expect(done).toBe(0);
  });
});
