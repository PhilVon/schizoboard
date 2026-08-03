/**
 * `Ctrl`+`Alt` on a string, from every tool.
 *
 * The gesture's own cases — what it beats, what it swallows, what it leaves the
 * pins — live in `select.test.ts`, which drives it through the tool it will be
 * used from most. What is asserted here is the words **in any tool** (Q-186):
 * the same cut from a pen and from the note tool, and, in every one of them, the
 * pin that must survive a press aimed at a string.
 *
 * That last case is the sharp one and it is why this file drives all six rather
 * than trusting the shared object. `state/tools/quickpull.ts` is offered every
 * press too, and it takes `Alt` on a pin — so a scissors press that landed on a
 * pin removed the pin, healing its strings on the way out, in whichever tools
 * had been wired up wrongly. Nothing about that failure is visible from the
 * object under test; it is a fact about six call sites.
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
import { SelectTool } from "@/state/tools/select";
import { StringTool } from "@/state/tools/string";
import type { PointerSample, StringHit, Tool, ToolContext } from "@/state/tools/tool";

type Write =
  | { kind: "deleteStrings"; ids: string[] }
  | { kind: "unpin"; ids: string[] }
  | { kind: "other" };

let scene: Scene;
let ctx: ToolContext;
let writes: Write[];

const PIN_GRAB = 10;

/** Two pins 200 apart with a taut string between them; the middle is (100, 0). */
function taut(): void {
  for (const [id, wx] of [
    ["p0", 0],
    ["p1", 200],
  ] as const) {
    scene.putPin({ id, parent: null, lx: wx, ly: 0, kind: "pushpin", color: "#c8352f", page: null, wx, wy: 0 });
  }
  scene.putString({
    id: "s",
    nodes: [
      { nodeId: "s-n0", pin: "p0", slackAfter: 0.2 },
      { nodeId: "s-n1", pin: "p1", slackAfter: 0.2 },
    ],
    color: "#a8322c",
    thickness: 3,
    material: "string",
    layer: "over",
    closed: false,
  });
}

function hitPin(sx: number, sy: number): string | null {
  let best: string | null = null;
  let bestDist = PIN_GRAB * PIN_GRAB;
  for (const [id, pin] of scene.pins) {
    const dist = (pin.wx - sx) ** 2 + (pin.wy - sy) ** 2;
    if (dist > bestDist) continue;
    bestDist = dist;
    best = id;
  }
  return best;
}

/** Against the chord, which for a taut string is where the real one finds it. */
function hitString(bx: number, by: number, reach: number): StringHit | null {
  const a = scene.pins.get("p0");
  const b = scene.pins.get("p1");
  if (!a || !b || !scene.strings.has("s")) return null;
  const dx = b.wx - a.wx;
  const dy = b.wy - a.wy;
  const span = dx * dx + dy * dy;
  const u = Math.min(1, Math.max(0, ((bx - a.wx) * dx + (by - a.wy) * dy) / span));
  const x = a.wx + dx * u;
  const y = a.wy + dy * u;
  const distance = Math.hypot(bx - x, by - y);
  return distance < reach ? { string: "s", node: 0, t: u, x, y, distance } : null;
}

function at(x: number, y: number, mods: Partial<PointerSample> = {}): PointerSample {
  return { x, y, shift: false, ctrl: false, alt: false, ...mods };
}

const SCISSORS = { ctrl: true, alt: true };

/** The whole gesture: press, a little travel, release. */
function snip(tool: Tool, x: number, y: number, mods: Partial<PointerSample> = SCISSORS): void {
  tool.handle({ kind: "down", at: at(x, y, mods) }, ctx);
  tool.handle({ kind: "move", at: at(x + 6, y + 6, mods) }, ctx);
  tool.handle({ kind: "up", at: at(x + 6, y + 6, mods) }, ctx);
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
    hitTest: () => null,
    inkHitTest: () => null,
    shownPage: () => null,
    hitPin,
    hitString,
    edit: () => undefined,
    open: () => false,
    turnPage: () => false,
    follow: () => false,
    clip: () => undefined,
    held: new Set<string>(),
    write: {
      deleteStrings: (ids) => writes.push({ kind: "deleteStrings", ids: [...ids] }),
      deletePins: (ids) => writes.push({ kind: "unpin", ids: [...ids] }),
      setPoses: () => writes.push({ kind: "other" }),
      setSizes: () => writes.push({ kind: "other" }),
      deleteItems: () => writes.push({ kind: "other" }),
      setItemStyle: () => writes.push({ kind: "other" }),
      bringToFront: () => writes.push({ kind: "other" }),
      sendToBack: () => writes.push({ kind: "other" }),
      createNote: () => writes.push({ kind: "other" }),
      createPin: () => writes.push({ kind: "other" }),
      placePin: () => writes.push({ kind: "other" }),
      createString: () => writes.push({ kind: "other" }),
      insertPin: () => writes.push({ kind: "other" }),
      setNodeSlack: () => writes.push({ kind: "other" }),
      scaleNodeSlack: () => writes.push({ kind: "other" }),
      setStringSlack: () => writes.push({ kind: "other" }),
      scaleStringSlack: () => writes.push({ kind: "other" }),
      setStringLayer: () => writes.push({ kind: "other" }),
      setStringStyle: () => writes.push({ kind: "other" }),
      movePins: () => writes.push({ kind: "other" }),
      commitStrokes: () => writes.push({ kind: "other" }),
      eraseStrokes: () => writes.push({ kind: "other" }),
    },
  };
});

/** Every tool the board has, by the letter that reaches it (DESIGN 3.9). */
const TOOLS: [string, () => Tool][] = [
  ["V — select", () => new SelectTool()],
  ["N — the note tool", () => new NoteTool({})],
  ["P — the pin tool", () => new PinTool({})],
  ["S — the string tool", () => new StringTool({})],
  ["M — the marker", () => new MarkerTool({})],
  ["H — the highlighter", () => new MarkerTool({ tool: "highlighter" })],
  ["E — the eraser", () => new EraserTool({})],
];

describe.each(TOOLS)("%s", (_name, make) => {
  it("cuts the string under a Ctrl+Alt press", () => {
    taut();
    snip(make(), 100, 0);

    expect(writes).toEqual([{ kind: "deleteStrings", ids: ["s"] }]);
  });

  /** The tool must not get the moves either. A pen offered them would draw a
   *  stroke that started nowhere. */
  it("keeps the rest of the gesture, so the tool draws nothing behind it", () => {
    taut();
    const tool = make();
    tool.handle({ kind: "down", at: at(100, 0, SCISSORS) }, ctx);
    tool.handle({ kind: "move", at: at(300, 200, SCISSORS) }, ctx);
    tool.handle({ kind: "up", at: at(300, 200, SCISSORS) }, ctx);

    expect(writes.filter((w) => w.kind === "other")).toEqual([]);
  });

  it("does not remove the pin a scissors press lands on", () => {
    taut();
    snip(make(), 0, 0);

    expect(writes.some((w) => w.kind === "unpin")).toBe(false);
    expect(scene.pins.has("p0")).toBe(true);
  });

  it("cuts nothing when the press misses the string", () => {
    taut();
    snip(make(), 100, 300);

    expect(writes.some((w) => w.kind === "deleteStrings")).toBe(false);
  });

  /** Neither half on its own. `Alt` alone over a string is not on a pin either,
   *  so it reaches the tool exactly as it always did. */
  it("leaves a press with only one of the two modifiers alone", () => {
    taut();
    snip(make(), 100, 0, { alt: true });
    snip(make(), 100, 0, { ctrl: true });

    expect(writes.some((w) => w.kind === "deleteStrings")).toBe(false);
  });
});
