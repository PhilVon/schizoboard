/**
 * The string tool, with no document, no renderer and no browser.
 *
 * AC-68 is "the click-a-bare-item fast path exists — it is the primary verb",
 * and the suite named for it is the one that matters: DESIGN section 3.4 says
 * making someone place a pin first would double the interaction cost of the
 * thing the whole application is for.
 *
 * Everything here reads the run the tool would *write* rather than any
 * document, because a tool's writes are queued and it never sees an id — which
 * is itself the reason a run is handed over whole. See the module comment.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { StringTool } from "@/state/tools/string";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemPose } from "@/state/scene";
import { Selection } from "@/state/selection";
import type { StringAnchor, ToolContext, WritePose } from "@/state/tools/tool";
import { Torsion } from "@/sim/torsion";

let scene: Scene;
let dirty: DirtySets;
let camera: Camera;
let tool: StringTool;
let ctx: ToolContext;
let written: Array<{ anchors: readonly StringAnchor[]; closed: boolean }>;
/** Kept beside `written` rather than in it, so the run assertions stay about
 *  the run. */
let settles: Array<Map<string, WritePose>>;
let done: number;
let clock: number;

/** Items are hit by rectangle; pins by a screen-space radius, as in the app. */
let pinHits: Array<{ id: string; sx: number; sy: number }>;

function item(id: string, pose: Partial<ItemPose> = {}): void {
  scene.putItem(
    { id, type: "note", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x: 0, y: 0, rot: 0, w: 200, h: 160, ...pose },
  );
}

function pin(id: string, wx: number, wy: number, parent: string | null = null): void {
  scene.putPin({ id, parent, lx: wx, ly: wy, kind: "pushpin", color: "#c8352f", wx, wy });
  const screen = camera.boardToScreen(wx, wy);
  pinHits.push({ id, sx: screen.x, sy: screen.y });
}

function click(x: number, y: number, shift = false): void {
  tool.handle({ kind: "up", at: { x, y, shift, ctrl: false, alt: false } }, ctx);
}

/** The cursor the caller would hand `preview` — board space, since the default
 *  camera makes screen and board coincide. */
let cursor: { x: number; y: number } | null = null;
function move(x: number, y: number): void {
  cursor = { ...camera.screenToBoard(x, y) };
}

function key(code: string): void {
  tool.handle({ kind: "key", code, shift: false, ctrl: false, alt: false }, ctx);
}

/** The run the tool committed, if it committed one. */
function run(): { anchors: readonly StringAnchor[]; closed: boolean } | undefined {
  return written[0];
}

beforeEach(() => {
  scene = new Scene();
  dirty = new DirtySets();
  camera = new Camera();
  camera.resize(1000, 800);
  written = [];
  settles = [];
  done = 0;
  clock = 1000;
  cursor = null;
  pinHits = [];
  tool = new StringTool({ onDone: () => done++, now: () => clock });
  ctx = {
    scene,
    dirty,
    camera,
    selection: new Selection(),
    held: new Set<string>(),
    hitTest: (bx, by) => {
      for (const id of scene.itemIds()) {
        const pose = scene.poseOf(id);
        if (!pose) continue;
        if (
          Math.abs(bx - pose.x) <= pose.w / 2 &&
          Math.abs(by - pose.y) <= pose.h / 2
        ) {
          return id;
        }
      }
      return null;
    },
    hitPin: (sx, sy) => {
      for (const hit of pinHits) {
        if (Math.hypot(hit.sx - sx, hit.sy - sy) <= 12) return hit.id;
      }
      return null;
    },
    // The string tool builds runs from clicks; grabbing an existing one in the
    // middle belongs to the select tool.
    hitString: () => null,
    write: {
      setPoses: () => {},
      setSizes: () => {},
      deleteItems: () => {},
      createNote: () => {},
      createPin: () => {
        throw new Error("the string tool creates pins through the run, not one at a time");
      },
      placePin: () => {},
      deletePins: () => {},
      createString: (anchors, closed, settle) => {
        written.push({ anchors: anchors.map((a) => ({ ...a })), closed });
        settles.push(new Map(settle));
      },
      insertPin: () => {
        throw new Error("the string tool does not insert into an existing run");
      },
      setNodeSlack: () => {
        throw new Error("the string tool does not edit an existing run's slack");
      },
      scaleNodeSlack: () => {
        throw new Error("the string tool does not edit an existing run's slack");
      },
      setStringSlack: () => {
        throw new Error("the string tool does not edit an existing run's slack");
      },
      scaleStringSlack: () => {
        throw new Error("the string tool does not edit an existing run's slack");
      },
      setStringLayer: () => {
        throw new Error("the string tool does not restyle an existing run");
      },
    },
  };
});

describe("the fast path (AC-68)", () => {
  /**
   * > Click an *item* rather than a pin while stringing | A pin is created
   * > there automatically and the run continues — DESIGN section 3.4
   *
   * No mode, no modifier, no dialog. This is the primary verb and it has to be
   * one click.
   */
  it("pushes a pin into the item you clicked and carries on", () => {
    item("photo", { x: 0, y: 0 });
    item("note", { x: 400, y: 0 });
    // Board and screen coincide at the default camera.
    click(0, 0);
    click(400, 0);
    key("Enter");

    expect(run()!.anchors).toEqual([
      { parent: "photo", lx: 0, ly: 0 },
      { parent: "note", lx: 0, ly: 0 },
    ]);
  });

  it("pins where on the paper you clicked, not at its centre", () => {
    item("photo", { x: 0, y: 0, w: 200, h: 160 });
    click(60, -40);
    click(400, 0);
    key("Enter");
    expect(run()!.anchors[0]).toEqual({ parent: "photo", lx: 60, ly: -40 });
  });

  /** A pin is a bigger target than the paper under it, so the precise path
   *  stays available without a modifier. */
  it("uses the pin when there is one under the cursor", () => {
    item("photo", { x: 0, y: 0 });
    pin("p1", 0, 0, "photo");
    click(0, 0);
    click(400, 0);
    key("Enter");
    expect(run()!.anchors[0]).toEqual({ pin: "p1" });
  });

  /** > Click empty cork while stringing | A free pin is pushed in and the run
   *  > continues — DESIGN section 3.4 */
  it("pushes a free pin into bare cork", () => {
    click(120, 90);
    click(400, 0);
    key("Enter");
    expect(run()!.anchors[0]).toEqual({ parent: null, lx: 120, ly: 90 });
  });

  it("mixes all three in one run", () => {
    item("photo", { x: 0, y: 0 });
    pin("p1", 400, 0);
    click(0, 0);
    click(400, 0);
    click(600, 200);
    key("Enter");
    expect(run()!.anchors).toEqual([
      { parent: "photo", lx: 0, ly: 0 },
      { pin: "p1" },
      { parent: null, lx: 600, ly: 200 },
    ]);
  });
});

describe("building a run", () => {
  it("keeps appending stops for as long as you keep clicking", () => {
    for (let i = 0; i < 6; i++) click(i * 100, 0);
    key("Enter");
    expect(run()!.anchors).toHaveLength(6);
  });

  it("writes once, at the end, and not before", () => {
    click(0, 0);
    click(200, 0);
    click(400, 0);
    expect(written).toHaveLength(0);
    key("Enter");
    expect(written).toHaveLength(1);
  });

  /** One click is somebody who changed their mind. It leaves nothing behind —
   *  not even the pin a written-as-you-go run would have pushed in. */
  it("leaves no litter when a run never got a second stop", () => {
    click(0, 0);
    key("Escape");
    expect(written).toHaveLength(0);
    expect(done).toBe(1);
  });

  it("starts fresh after a run ends", () => {
    click(0, 0);
    click(200, 0);
    key("Enter");
    click(500, 500);
    click(700, 500);
    key("Enter");
    expect(written).toHaveLength(2);
    expect(written[1].anchors).toHaveLength(2);
  });
});

describe("ending a run", () => {
  /** > Finish | `Enter`, `Esc`, or double-click | Ends the run
   *  > — DESIGN section 3.4. `Esc` ends it rather than reverting it; the one
   *  place section 3.4 says revert is the mid-string drag, and it says so. */
  it.each(["Enter", "Escape"])("commits what is there on %s", (code) => {
    click(0, 0);
    click(200, 0);
    key(code);
    expect(written).toHaveLength(1);
    expect(done).toBe(1);
  });

  it("ends on a double-click rather than stacking a stop on a stop", () => {
    click(0, 0);
    click(200, 0);
    clock += 100;
    click(202, 1);
    expect(written).toHaveLength(1);
    expect(written[0].anchors).toHaveLength(2);
  });

  it("treats two slow clicks in the same place as two stops", () => {
    click(0, 0);
    click(200, 0);
    clock += 900;
    click(200, 0);
    expect(written).toHaveLength(0);
    key("Enter");
    expect(written[0].anchors).toHaveLength(3);
  });

  it("throws the run away when the gesture is taken off it", () => {
    click(0, 0);
    click(200, 0);
    tool.handle({ kind: "cancel" }, ctx);
    key("Enter");
    expect(written).toHaveLength(0);
  });
});

describe("closing a loop", () => {
  /** > Shift+click the first node | Loops the run back; the last node's slack
   *  > becomes the wrap segment — DESIGN section 3.4 */
  it("closes when Shift+clicking the first stop", () => {
    pin("p1", 0, 0);
    click(0, 0);
    click(300, 0);
    click(300, 300);
    click(0, 0, true);
    expect(run()!.closed).toBe(true);
    expect(run()!.anchors).toHaveLength(3);
  });

  it("closes on a first stop that was bare cork, by proximity", () => {
    click(0, 0);
    click(300, 0);
    click(300, 300);
    click(4, -3, true);
    expect(run()!.closed).toBe(true);
  });

  /** Two stops looped back is the same segment drawn twice. */
  it("will not close a run of two", () => {
    pin("p1", 0, 0);
    click(0, 0);
    click(300, 0);
    click(0, 0, true);
    expect(written).toHaveLength(0);
    key("Enter");
    expect(run()!.closed).toBe(false);
    expect(run()!.anchors).toHaveLength(3);
  });

  it("does not close without Shift — that is just another stop" , () => {
    pin("p1", 0, 0);
    click(0, 0);
    click(300, 0);
    click(300, 300);
    click(0, 0);
    key("Enter");
    expect(run()!.closed).toBe(false);
    expect(run()!.anchors).toHaveLength(4);
  });
});

describe("the run on screen", () => {
  it("shows nothing before the first click", () => {
    move(100, 100);
    expect(tool.preview(cursor)).toBeNull();
  });

  /** The last leg follows the pointer — the whole of the feedback, and why a
   *  deferred write does not feel like a deferred anything. */
  it("draws the stops and then the cursor", () => {
    click(0, 0);
    click(300, 100);
    move(450, 250);
    expect(tool.preview(cursor)).toEqual([
      { x: 0, y: 0 },
      { x: 300, y: 100 },
      { x: 450, y: 250 },
    ]);
  });

  it("snaps a stop to the pin it landed on, not to the click point", () => {
    pin("p1", 300, 100);
    click(304, 96);
    expect(tool.preview(cursor)![0]).toEqual({ x: 300, y: 100 });
  });

  it("has nothing left to draw once the run ends", () => {
    click(0, 0);
    click(200, 0);
    key("Enter");
    expect(tool.preview(cursor)).toBeNull();
  });
});

/**
 * A run's fast path pushes a pin into every bare item it touches, and any of
 * those items may be hanging — so a run is also the one gesture that can stop
 * *several* items hanging at once.
 */
describe("stringing through items that hang", () => {
  /** One pin at the top left of a 200-square, settled with no motion the way a
   *  load is, which leaves it a long way from its authored rotation. */
  function hang(id: string, x: number): void {
    item(id, { x, y: 0, w: 200, h: 200 });
    scene.putPin({
      id: `${id}-hook`,
      parent: id,
      lx: -80,
      ly: -60,
      kind: "pushpin",
      color: "#c8352f",
      wx: x - 80,
      wy: -60,
    });
    dirty.all = true;
    new Torsion().step(scene, dirty, 16);
    scene.layoutPins();
  }

  function drawn(id: string): WritePose {
    const slot = scene.slotOf(id)!;
    return {
      x: scene.renderX(slot),
      y: scene.renderY(slot),
      rot: scene.rot[slot]! + scene.swing[slot]!,
    };
  }

  it("settles every item the run pinned, in the one write the run already is", () => {
    hang("photo", 0);
    hang("note", 600);
    expect(Math.abs(scene.swing[scene.slotOf("photo")!]!)).toBeGreaterThan(0.5);

    click(0, 0);
    click(600, 0);
    key("Enter");

    expect(written).toHaveLength(1);
    const settle = settles[0]!;
    expect(settle.get("photo")).toEqual(drawn("photo"));
    expect(settle.get("note")).toEqual(drawn("note"));
  });

  /** A run may stop on the same paper twice. It hangs on one pin either way, so
   *  it settles once — a second copy of the same pose would be the same write. */
  it("settles an item twice-stopped-on only once", () => {
    hang("photo", 0);
    click(-40, 0);
    click(600, 0);
    click(40, 0);
    key("Enter");
    expect([...settles[0]!.keys()]).toEqual(["photo"]);
  });

  /** A run made entirely of existing pins and bare cork changes nobody's count. */
  it("settles nothing for a run that pinned no item", () => {
    hang("photo", 0);
    pin("p1", 900, 0);
    click(900, 0);
    click(1200, 400);
    key("Enter");
    expect(settles[0]!.size).toBe(0);
  });
});
