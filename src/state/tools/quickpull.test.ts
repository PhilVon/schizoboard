/**
 * `Alt` on a pin, from a tool that is not the select tool.
 *
 * > | Quick pull | `Alt`+drag from a pin, **in any tool** | Pulls a new string
 * > out without switching tools | — DESIGN section 3.4
 *
 * The gesture itself is covered in `select.test.ts`, which drove it for six
 * phases before it moved out of that file and drives it still — 13 tests over
 * both endings, unchanged by the extraction. What is new is the words "in any
 * tool", and that is the whole of what is asserted here: the same gesture, from
 * a pen and from the note tool, and the pen's own gesture still working when
 * `Alt` is not held.
 *
 * Driven through `Tool.handle`, so what is under test is the delegation each
 * tool does rather than the object it delegates to.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";
import { Selection } from "@/state/selection";
import { EraserTool } from "@/state/tools/eraser";
import { MarkerTool } from "@/state/tools/marker";
import { NoteTool } from "@/state/tools/note";
import { PinTool } from "@/state/tools/pin";
import { StringTool } from "@/state/tools/string";
import type { PointerSample, StringAnchor, Tool, ToolContext } from "@/state/tools/tool";

type Write =
  | { kind: "string"; anchors: StringAnchor[] }
  | { kind: "unpin"; ids: string[] }
  | { kind: "strokes"; count: number }
  | { kind: "note"; x: number; y: number }
  | { kind: "pin"; parent: string | null };

let scene: Scene;
let ctx: ToolContext;
let writes: Write[];

const PIN_GRAB = 10;

function at(x: number, y: number, alt = false): PointerSample {
  return { x, y, shift: false, ctrl: false, alt };
}

function pull(tool: Tool, from: [number, number], to: [number, number]): void {
  tool.handle({ kind: "down", at: at(from[0], from[1], true) }, ctx);
  tool.handle({ kind: "move", at: at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, true) }, ctx);
  tool.handle({ kind: "up", at: at(to[0], to[1], true) }, ctx);
}

function putPin(id: string, parent: string | null, wx: number, wy: number): void {
  scene.putPin({ id, parent, lx: wx, ly: wy, kind: "pushpin", color: "#c8352f", wx, wy });
}

function putItem(id: string, x: number, y: number): void {
  scene.putItem(
    { id, type: "note", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x, y, rot: 0, w: 200, h: 160 },
  );
}

function hitTest(bx: number, by: number): string | null {
  for (const id of [...scene.itemIds()].reverse()) {
    const slot = scene.slotOf(id)!;
    if (
      Math.abs(bx - scene.x[slot]!) <= scene.w[slot]! / 2 &&
      Math.abs(by - scene.y[slot]!) <= scene.h[slot]! / 2
    ) {
      return id;
    }
  }
  return null;
}

function hitPin(sx: number, sy: number): string | null {
  let best: string | null = null;
  let bestDist = PIN_GRAB * PIN_GRAB;
  for (const [id, pin] of scene.pins) {
    const dx = pin.wx - sx;
    const dy = pin.wy - sy;
    const dist = dx * dx + dy * dy;
    if (dist <= bestDist) {
      best = id;
      bestDist = dist;
    }
  }
  return best;
}

beforeEach(() => {
  scene = new Scene();
  writes = [];
  const camera = new Camera();
  camera.resize(1000, 800);
  ctx = {
    scene,
    dirty: new DirtySets(),
    camera,
    selection: new Selection(),
    hitTest,
    inkHitTest: hitTest,
    shownPage: () => null,
    hitPin,
    hitString: () => null,
    edit: () => undefined,
    open: () => false,
    turnPage: () => false,
    held: new Set<string>(),
    write: {
      setPoses: () => {},
      setSizes: () => {},
      deleteItems: () => {},
      setItemStyle: () => {},
      bringToFront: () => {},
      sendToBack: () => {},
      createNote: (x, y) => writes.push({ kind: "note", x, y }),
      createPin: (parent) => writes.push({ kind: "pin", parent }),
      placePin: () => {},
      createString: (anchors) => writes.push({ kind: "string", anchors: [...anchors] }),
      insertPin: () => {},
      setNodeSlack: () => {},
      scaleNodeSlack: () => {},
      setStringSlack: () => {},
      scaleStringSlack: () => {},
      setStringLayer: () => {},
      deleteStrings: () => {},
      setStringStyle: () => {},
      movePins: () => {},
      commitStrokes: (runs) => writes.push({ kind: "strokes", count: runs.length }),
      eraseStrokes: () => {},
      deletePins: (ids) => writes.push({ kind: "unpin", ids: [...ids] }),
    },
  };
});

/** Every tool the board has, by the letter that reaches it (DESIGN 3.9). */
const TOOLS: [string, () => Tool][] = [
  ["N — the note tool", () => new NoteTool({})],
  ["P — the pin tool", () => new PinTool({})],
  ["S — the string tool", () => new StringTool({})],
  ["M — the marker", () => new MarkerTool({})],
  ["H — the highlighter", () => new MarkerTool({ tool: "highlighter" })],
  ["E — the eraser", () => new EraserTool({})],
];

describe.each(TOOLS)("%s", (_name, make) => {
  it("pulls a string out of a pin without being put down", () => {
    putPin("from", null, 0, 0);
    putPin("to", null, 300, 120);
    const tool = make();

    pull(tool, [0, 0], [300, 120]);

    expect(writes).toEqual([
      { kind: "string", anchors: [{ pin: "from" }, { pin: "to" }] },
    ]);
  });

  it("pins a bare item at the far end, the same fast path the string tool has", () => {
    putPin("from", null, 0, 0);
    putItem("note", 400, 0);
    const tool = make();

    pull(tool, [0, 0], [400, 0]);

    expect(writes).toEqual([
      { kind: "string", anchors: [{ pin: "from" }, { parent: "note", lx: 0, ly: 0 }] },
    ]);
  });

  it("removes the pin when the pointer never moved", () => {
    putPin("p", null, 0, 0);
    const tool = make();

    tool.handle({ kind: "down", at: at(0, 0, true) }, ctx);
    tool.handle({ kind: "up", at: at(0, 0, true) }, ctx);

    expect(writes).toEqual([{ kind: "unpin", ids: ["p"] }]);
  });

  it("reverts on Escape, writing nothing and removing nothing", () => {
    putPin("from", null, 0, 0);
    const tool = make();

    tool.handle({ kind: "down", at: at(0, 0, true) }, ctx);
    tool.handle({ kind: "move", at: at(200, 200, true) }, ctx);
    tool.handle({ kind: "key", code: "Escape", shift: false, ctrl: false, alt: true }, ctx);
    tool.handle({ kind: "up", at: at(300, 300, true) }, ctx);

    expect(writes).toEqual([]);
    expect(scene.pins.has("from")).toBe(true);
  });

  /**
   * The failure this guards is not visible on the gesture that causes it. A
   * tool switched away from mid-pull keeps the gesture in the instance that was
   * abandoned, and the *next* press in that tool then has its moves swallowed
   * by a pull nobody is making — which reads as the tool having died.
   */
  it("is not left holding a gesture that was taken away", () => {
    putPin("from", null, 0, 0);
    const tool = make();

    tool.handle({ kind: "down", at: at(0, 0, true) }, ctx);
    tool.handle({ kind: "move", at: at(200, 200, true) }, ctx);
    tool.cancel(ctx);
    tool.handle({ kind: "up", at: at(300, 300, true) }, ctx);

    expect(writes).toEqual([]);
    expect(tool.pullPreview?.({ x: 5, y: 5 })).toBeNull();
  });

  it("leaves a press with no Alt to the tool", () => {
    putPin("p", null, 0, 0);
    const tool = make();

    tool.handle({ kind: "down", at: at(0, 0) }, ctx);
    tool.handle({ kind: "move", at: at(60, 40) }, ctx);
    tool.handle({ kind: "up", at: at(60, 40) }, ctx);

    // Whatever each tool does with a press, none of them removes a pin or
    // strings anything — that is the modifier's, and it was not held.
    expect(writes.some((w) => w.kind === "unpin" || w.kind === "string")).toBe(false);
  });

  it("leaves an Alt press that is not on a pin to the tool", () => {
    putPin("elsewhere", null, 900, 900);
    const tool = make();

    tool.handle({ kind: "down", at: at(0, 0, true) }, ctx);
    tool.handle({ kind: "up", at: at(0, 0, true) }, ctx);

    expect(writes.some((w) => w.kind === "unpin" || w.kind === "string")).toBe(false);
    expect(scene.pins.has("elsewhere")).toBe(true);
  });

  /**
   * `Ctrl`+`Alt` is the scissors (`state/tools/frame.ts`, Q-183), and this is
   * offered every press before any tool sees it — so a decline here is the only
   * thing standing between a scissors press that happened to land on a pin and
   * that pin being removed. Removed, and its strings healed on the way out,
   * which is the least recoverable thing on the board to do by accident.
   *
   * Asserted in every tool rather than only in the select tool, because the
   * quick pull runs in every tool and so does this hazard — the cut itself is
   * the select tool's (`select.test.ts`), but the pin surviving is not.
   */
  it("declines a Ctrl+Alt press, which is the scissors and not a pull", () => {
    putPin("p", null, 0, 0);
    const tool = make();
    const scissors = { ...at(0, 0, true), ctrl: true };

    tool.handle({ kind: "down", at: scissors }, ctx);
    tool.handle({ kind: "up", at: scissors }, ctx);

    expect(writes.some((w) => w.kind === "unpin")).toBe(false);
    expect(scene.pins.has("p")).toBe(true);
  });
});

describe("the pen keeps its own gesture", () => {
  it("still commits a stroke when Alt is not held", () => {
    putPin("p", null, 0, 0);
    const marker = new MarkerTool({});

    marker.handle({ kind: "down", at: at(200, 200) }, ctx);
    marker.handle({ kind: "move", at: at(240, 220) }, ctx);
    marker.handle({ kind: "up", at: at(280, 240) }, ctx);

    expect(writes).toEqual([{ kind: "strokes", count: 1 }]);
  });

  it("draws the pull for the overlay while one is in flight", () => {
    putPin("from", null, 40, 20);
    const marker = new MarkerTool({});
    expect(marker.pullPreview?.({ x: 1, y: 1 })).toBeNull();

    marker.handle({ kind: "down", at: at(40, 20, true) }, ctx);
    marker.handle({ kind: "move", at: at(200, 200, true) }, ctx);

    expect(marker.pullPreview?.({ x: 260, y: 180 })).toEqual([
      { x: 40, y: 20 },
      { x: 260, y: 180 },
    ]);
    marker.handle({ kind: "up", at: at(260, 180, true) }, ctx);
    expect(marker.pullPreview?.({ x: 260, y: 180 })).toBeNull();
  });
});
