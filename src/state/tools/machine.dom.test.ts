/**
 * @vitest-environment happy-dom
 *
 * The wiring, not the gesture — `select.test.ts` covers what the inputs mean.
 * What matters here is that a real event reaches the tool, that it does so *in
 * the INPUT phase* rather than the instant it is dispatched, and that the
 * machine stays out of navigation's way.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";
import { Selection } from "@/state/selection";
import { ToolMachine } from "@/state/tools/machine";
import type { PointerSample, Tool, ToolContext, ToolInput } from "@/state/tools/tool";

class RecordingTool implements Tool {
  readonly id = "recording";
  readonly seen: ToolInput[] = [];
  readonly heldAtHandle: string[][] = [];
  ticks = 0;
  cancels = 0;

  /** Off by default, so every test that predates the wheel still sees the
   *  camera keep it. */
  wantsWheel = false;

  handle(input: ToolInput, ctx: ToolContext): void {
    this.seen.push(input);
    this.heldAtHandle.push([...ctx.held]);
  }
  /** Every sample it was asked about — `wheelClaimed` builds one out of the
   *  hover and the held keys rather than out of an event. */
  readonly askedWith: PointerSample[] = [];

  claimsWheel(at: PointerSample): boolean {
    this.askedWith.push(at);
    return this.wantsWheel;
  }
  tick(): void {
    this.ticks++;
  }
  cancel(): void {
    this.cancels++;
  }
}

let root: HTMLDivElement;
let tool: RecordingTool;
let machine: ToolMachine;
let suppressed: boolean;
/** The machine's clock, so the double-click window is a thing the test sets
 *  rather than a thing it waits for. */
let now: number;

function pointer(type: string, init: Record<string, unknown>): void {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
  // happy-dom's PointerEvent drops the MouseEventInit coordinates.
  for (const k of ["clientX", "clientY"] as const) {
    if (event[k] !== (init[k] ?? 0)) Object.defineProperty(event, k, { value: init[k] ?? 0 });
  }
  (init["target"] as HTMLElement | undefined ?? root).dispatchEvent(event);
}

/**
 * A move whose samples the browser hid inside it.
 *
 * happy-dom has no `getCoalescedEvents`, which is one of the two reasons
 * `machine.ts` falls back to the event itself — so the method is stubbed on the
 * event here rather than on the prototype, and the fallback stays testable by
 * simply not calling this.
 */
function coalescedMove(
  samples: ReadonlyArray<Record<string, unknown>>,
  pointerId = 1,
): void {
  const inner = samples.map((init) => {
    const e = new PointerEvent("pointermove", { ...init });
    for (const k of ["clientX", "clientY"] as const) {
      if (e[k] !== (init[k] ?? 0)) Object.defineProperty(e, k, { value: init[k] ?? 0 });
    }
    return e;
  });
  const last = samples[samples.length - 1] ?? {};
  const event = new PointerEvent("pointermove", { bubbles: true, pointerId, ...last });
  for (const k of ["clientX", "clientY"] as const) {
    if (event[k] !== (last[k] ?? 0)) Object.defineProperty(event, k, { value: last[k] ?? 0 });
  }
  Object.defineProperty(event, "getCoalescedEvents", { value: () => inner });
  root.dispatchEvent(event);
}

function trail(index: number): ReadonlyArray<PointerSample> {
  const input = tool.seen[index]!;
  if (input.kind !== "move") throw new Error(`input ${index} is a ${input.kind}, not a move`);
  return input.trail ?? [];
}

function kinds(): string[] {
  return tool.seen.map((i) => i.kind);
}

function key(code: string, init: Record<string, unknown> = {}): void {
  const target = init["target"] as HTMLElement | undefined;
  const event = new KeyboardEvent("keydown", { code, bubbles: true, ...init });
  (target ?? window).dispatchEvent(event);
}

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.append(root);
  root.setPointerCapture = () => {};
  root.releasePointerCapture = () => {};
  root.hasPointerCapture = () => false;

  tool = new RecordingTool();
  suppressed = false;
  now = 1000;
  const scene = new Scene();
  machine = new ToolMachine(tool, root, {
    scene,
    dirty: new DirtySets(),
    camera: new Camera(),
    selection: new Selection(),
    write: {
      setPoses: () => {},
      setSizes: () => {},
      deleteItems: () => {},
      createNote: () => {},
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
    },
    hitTest: () => null,
    hitPin: () => null,
    hitString: () => null,
    suppressed: () => suppressed,
    now: () => now,
  });
});

describe("ToolMachine", () => {
  it("buffers input and delivers none of it until the INPUT phase", () => {
    pointer("pointerdown", { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    pointer("pointermove", { pointerId: 1, clientX: 40, clientY: 10 });
    expect(tool.seen).toEqual([]);

    machine.flush(16);
    expect(kinds()).toEqual(["down", "move"]);
    expect(tool.ticks).toBe(1);
  });

  it("steps the tool on an idle frame too, so anything easing keeps easing", () => {
    machine.flush(16);
    machine.flush(16);
    expect(tool.seen).toEqual([]);
    expect(tool.ticks).toBe(2);
  });

  it("collapses the moves that landed in one frame down to the last position", () => {
    pointer("pointerdown", { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    for (let x = 1; x <= 8; x++) pointer("pointermove", { pointerId: 1, clientX: x * 10, clientY: 0 });
    pointer("pointerup", { pointerId: 1, clientX: 80, clientY: 0 });
    machine.flush(16);

    // The intermediate positions are history; only where the pointer ended up
    // is a fact the tool can use.
    expect(kinds()).toEqual(["down", "move", "up"]);
    const move = tool.seen[1]!;
    expect(move.kind === "move" && move.at.x).toBe(80);
  });

  /**
   * The other half of that collapse, and the whole of AC-76's input side.
   *
   * The position collapses; the samples must not. A stroke is the path the hand
   * took, and the samples the browser hid inside one `pointermove` are that path
   * — throw them away and the hand is sampled at frame rate, which at speed is a
   * visible polygon (DESIGN section 6.5).
   */
  it("keeps every coalesced sample, so a fast stroke is not sampled at frame rate", () => {
    pointer("pointerdown", { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    coalescedMove([
      { clientX: 10, clientY: 1 },
      { clientX: 20, clientY: 4 },
      { clientX: 30, clientY: 9 },
      { clientX: 40, clientY: 16 },
    ]);
    machine.flush(16);

    expect(trail(1).map((s) => s.x)).toEqual([10, 20, 30, 40]);
    // And the last of them is still the position, for every tool that only
    // wants that.
    const move = tool.seen[1]!;
    expect(move.kind === "move" && move.at.x).toBe(40);
  });

  it("concatenates the trails when several moves collapse into one frame", () => {
    pointer("pointerdown", { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    coalescedMove([{ clientX: 10, clientY: 0 }, { clientX: 20, clientY: 0 }]);
    coalescedMove([{ clientX: 30, clientY: 0 }, { clientX: 40, clientY: 0 }]);
    coalescedMove([{ clientX: 50, clientY: 0 }, { clientX: 60, clientY: 0 }]);
    machine.flush(16);

    // One move, six samples. Collapsing to the last *event's* trail would keep
    // two of the six, which is the same bug as not asking for them at all — it
    // just needs a busier frame to show.
    expect(kinds()).toEqual(["down", "move"]);
    expect(trail(1).map((s) => s.x)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it("falls back to the event itself where the browser coalesces nothing", () => {
    pointer("pointerdown", { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    // No `getCoalescedEvents` at all — happy-dom, and every non-Chromium engine.
    pointer("pointermove", { pointerId: 1, clientX: 33, clientY: 44 });
    machine.flush(16);

    expect(trail(1).map((s) => [s.x, s.y])).toEqual([[33, 44]]);
  });

  it("carries pressure and pointer type, and invents neither", () => {
    pointer("pointerdown", { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    coalescedMove([{ clientX: 5, clientY: 5, pressure: 0.75, pointerType: "pen" }]);
    machine.flush(16);

    const sample = trail(1)[0]!;
    expect(sample.pressure).toBe(0.75);
    expect(sample.pointer).toBe("pen");
  });

  it("ignores every button but the primary one — the rest belong to the camera", () => {
    pointer("pointerdown", { button: 1, pointerId: 2, clientX: 0, clientY: 0 });
    pointer("pointermove", { pointerId: 2, clientX: 50, clientY: 0 });
    machine.flush(16);
    expect(tool.seen).toEqual([]);
  });

  it("stands down while navigation has the pointer", () => {
    suppressed = true;
    pointer("pointerdown", { button: 0, pointerId: 3, clientX: 0, clientY: 0 });
    machine.flush(16);
    expect(tool.seen).toEqual([]);

    suppressed = false;
    pointer("pointerdown", { button: 0, pointerId: 4, clientX: 0, clientY: 0 });
    machine.flush(16);
    expect(kinds()).toEqual(["down"]);
  });

  it("leaves clicks on the UI chrome to the UI", () => {
    const ui = document.createElement("div");
    ui.className = "layer-ui";
    const button = document.createElement("button");
    ui.append(button);
    root.append(ui);

    pointer("pointerdown", { button: 0, pointerId: 5, clientX: 0, clientY: 0, target: button });
    machine.flush(16);
    expect(tool.seen).toEqual([]);
  });

  it("reports held keys as a level rather than queueing them", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR" }));
    pointer("pointerdown", { button: 0, pointerId: 6, clientX: 0, clientY: 0 });
    machine.flush(16);
    expect(kinds()).toEqual(["down"]);
    expect(tool.heldAtHandle[0]).toEqual(["KeyR"]);

    pointer("pointerup", { pointerId: 6, clientX: 0, clientY: 0 });
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyR" }));
    pointer("pointerdown", { button: 0, pointerId: 7, clientX: 0, clientY: 0 });
    machine.flush(16);
    expect(tool.heldAtHandle[2]).toEqual([]);
  });

  it("takes one gesture at a time, so a second finger cannot hijack it", () => {
    pointer("pointerdown", { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    pointer("pointerdown", { button: 0, pointerId: 2, clientX: 400, clientY: 400 });
    pointer("pointermove", { pointerId: 2, clientX: 500, clientY: 400 });
    // The first pointer's release must still be the one that lands, or
    // whatever it was carrying never gets put down.
    pointer("pointerup", { pointerId: 1, clientX: 0, clientY: 0 });
    machine.flush(16);
    expect(kinds()).toEqual(["down", "up"]);
  });

  it("queues the keys that are actions, and only those", () => {
    for (const code of ["Escape", "Delete", "Backspace", "KeyQ", "KeyR"]) {
      window.dispatchEvent(new KeyboardEvent("keydown", { code }));
    }
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
    machine.flush(16);

    expect(tool.seen.map((i) => (i.kind === "key" ? i.code : i.kind))).toEqual([
      "Escape",
      "Delete",
      "Backspace",
      "KeyA",
    ]);
  });

  it("lets a text field have its own keys", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const event = new KeyboardEvent("keydown", { code: "Delete", bubbles: true });
    input.dispatchEvent(event);
    machine.flush(16);
    expect(tool.seen).toEqual([]);
  });

  it("abandons the gesture when the window loses focus, through the queue", () => {
    pointer("pointerdown", { button: 0, pointerId: 8, clientX: 0, clientY: 0 });
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR" }));
    window.dispatchEvent(new Event("blur"));

    // Not cancelled yet: a listener must not touch the scene mid-frame.
    expect(tool.cancels).toBe(0);
    machine.flush(16);
    expect(kinds()).toEqual(["down", "cancel"]);
    // A key held through a focus change never delivers its keyup.
    expect(tool.heldAtHandle[0]).toEqual([]);
  });

  it("keeps a release that landed in the same frame as the blur", () => {
    pointer("pointerdown", { button: 0, pointerId: 9, clientX: 0, clientY: 0 });
    pointer("pointermove", { pointerId: 9, clientX: 90, clientY: 0 });
    pointer("pointerup", { pointerId: 9, clientX: 90, clientY: 0 });
    // Letting go and then losing focus within the same 16 ms is not rare, and
    // discarding the release would silently undo a finished drag.
    window.dispatchEvent(new Event("blur"));
    machine.flush(16);
    expect(kinds()).toEqual(["down", "move", "up", "cancel"]);
  });

  it("cancels the outgoing tool when tools are switched", () => {
    const next = new RecordingTool();
    machine.setTool(next);
    expect(tool.cancels).toBe(1);
    expect(machine.active).toBe(next);

    pointer("pointerdown", { button: 0, pointerId: 9, clientX: 0, clientY: 0 });
    machine.flush(16);
    expect(tool.seen).toEqual([]);
    expect(next.seen).toHaveLength(1);
  });

  it("raises gestureEnded for the frame that delivered the release", () => {
    pointer("pointerdown", { button: 0, pointerId: 11, clientX: 0, clientY: 0 });
    machine.flush(16);
    expect(machine.gestureEnded).toBe(false);

    pointer("pointerup", { pointerId: 11, clientX: 30, clientY: 0 });
    // Still false: the release is buffered, and the undo boundary it triggers
    // has to land after the write the tool makes when it finally sees it.
    expect(machine.gestureEnded).toBe(false);

    machine.flush(16);
    expect(machine.gestureEnded).toBe(true);
    machine.flush(16);
    expect(machine.gestureEnded).toBe(false);
  });

  it("raises gestureEnded for a cancel and for a tool change", () => {
    pointer("pointerdown", { button: 0, pointerId: 12, clientX: 0, clientY: 0 });
    machine.flush(16);
    pointer("pointercancel", { pointerId: 12, clientX: 0, clientY: 0 });
    machine.flush(16);
    expect(machine.gestureEnded).toBe(true);

    machine.flush(16);
    machine.setTool(new RecordingTool());
    machine.flush(16);
    expect(machine.gestureEnded).toBe(true);
  });

  it("stops listening once destroyed", () => {
    machine.destroy();
    pointer("pointerdown", { button: 0, pointerId: 10, clientX: 0, clientY: 0 });
    machine.flush(16);
    expect(tool.seen).toEqual([]);
  });
});

/**
 * The two inputs T-49 added, both of which are the machine's job rather than a
 * tool's: deciding that two presses were a double-click, and deciding that a
 * wheel notch belongs to the board rather than to the camera.
 */
describe("the second press of a double-click", () => {
  function press(x: number, y: number, id = 40): void {
    pointer("pointerdown", { button: 0, pointerId: id, clientX: x, clientY: y });
    pointer("pointerup", { pointerId: id, clientX: x, clientY: y });
  }

  function doubles(): Array<boolean | undefined> {
    return tool.seen
      .filter((i): i is Extract<ToolInput, { kind: "down" }> => i.kind === "down")
      .map((i) => i.double);
  }

  it("flags the second press and not the first", () => {
    press(10, 10, 41);
    press(10, 10, 42);
    machine.flush(16);
    expect(doubles()).toEqual([false, true]);
  });

  /** Ours rather than the DOM's `dblclick`, which never fires: `pointerdown`
   *  calls `preventDefault` and that suppresses the compatibility mouse
   *  events. */
  it("is decided by our own clock, not by the DOM", () => {
    now = 1000;
    press(10, 10, 43);
    now = 1500;
    press(10, 10, 44);
    machine.flush(16);
    expect(doubles()).toEqual([false, false]);
  });

  it("is not a double when the second press has wandered", () => {
    press(10, 10, 45);
    press(40, 10, 46);
    machine.flush(16);
    expect(doubles()).toEqual([false, false]);
  });

  /** A third press in the same spot is not a second double-click — click,
   *  double, click, which is what every text field does. */
  it("does not chain into a second double on a triple press", () => {
    press(10, 10, 47);
    press(10, 10, 48);
    press(10, 10, 49);
    machine.flush(16);
    expect(doubles()).toEqual([false, true, false]);
  });
});

describe("the 1-9 slack presets", () => {
  function codes(): string[] {
    return tool.seen
      .filter((i): i is Extract<ToolInput, { kind: "key" }> => i.kind === "key")
      .map((i) => i.code);
  }

  it("forwards a bare digit, by code so it survives a foreign layout", () => {
    key("Digit3");
    key("Numpad9");
    machine.flush(16);
    expect(codes()).toEqual(["Digit3", "Numpad9"]);
  });

  /** `Ctrl`+`0` fits the board and `Ctrl`+`1` is actual size (DESIGN section
   *  3.7). Forwarding those would fire a preset every time someone reset the
   *  zoom. */
  it("leaves Ctrl and Alt digits to the camera", () => {
    key("Digit1", { ctrlKey: true });
    key("Digit0");
    key("Digit4", { altKey: true });
    machine.flush(16);
    expect(codes()).toEqual([]);
  });

  it("is not board input while someone is writing on a note", () => {
    const field = document.createElement("input");
    document.body.append(field);
    key("Digit5", { target: field });
    machine.flush(16);
    expect(codes()).toEqual([]);
  });

  /**
   * `B` tucks a selected string behind the items — DESIGN section 3.4's row,
   * whose context menu arrives with the restyle verbs (T-52). It rides here
   * because it is forwarded on the same terms as the digits: bare only, and
   * left alone inside a text field.
   */
});

/**
 * The wheel, which is the one input the camera and the board both want — it
 * zooms (DESIGN section 3.7) and it adjusts a selected segment's slack (section
 * 3.4). There is no wheel listener on the machine at all: navigation owns the
 * only one and offers each notch here first.
 */
describe("offering a wheel notch to the tool", () => {
  function scroll(dy: number): boolean {
    const event = new WheelEvent("wheel", { deltaY: dy, clientX: 5, clientY: 6 });
    // happy-dom drops the MouseEventInit fields on a WheelEvent exactly as it
    // does on a PointerEvent — see `pointer` above.
    for (const [k, v] of [["clientX", 5], ["clientY", 6]] as const) {
      Object.defineProperty(event, k, { value: v });
    }
    for (const k of ["shiftKey", "ctrlKey", "altKey"] as const) {
      Object.defineProperty(event, k, { value: false });
    }
    Object.defineProperty(event, "target", { value: root });
    return machine.claimWheel(event);
  }

  it("declines, and delivers nothing, when the tool does not want it", () => {
    expect(scroll(-100)).toBe(false);
    machine.flush(16);
    expect(kinds()).toEqual([]);
  });

  it("claims and delivers when the tool wants it", () => {
    tool.wantsWheel = true;
    expect(scroll(-100)).toBe(true);
    // Buffered like every other input — the tool must not be stepped from
    // inside a listener.
    expect(tool.seen).toEqual([]);
    machine.flush(16);
    // `toMatchObject` rather than `toEqual`: every sample also carries the
    // event's timestamp, and the ink fields a wheel has nothing to say about.
    expect(tool.seen).toHaveLength(1);
    expect(tool.seen[0]).toMatchObject({
      kind: "wheel",
      at: { x: 5, y: 6, shift: false, ctrl: false, alt: false },
      dy: -100,
    });
  });

  /**
   * A fast roll delivers several notches between frames and they are all part
   * of the same turn of the wheel. Stepping the tool once per notch would be
   * several document writes in one frame, each read from a scene the previous
   * one had not reached yet.
   */
  it("sums the notches that land in one frame", () => {
    tool.wantsWheel = true;
    scroll(-100);
    scroll(-100);
    scroll(-40);
    machine.flush(16);
    const wheels = tool.seen.filter((i) => i.kind === "wheel");
    expect(wheels).toHaveLength(1);
    expect(wheels[0]).toMatchObject({ dy: -240 });
  });

  it("does not collapse across a press that landed between the notches", () => {
    tool.wantsWheel = true;
    scroll(-100);
    pointer("pointerdown", { button: 0, pointerId: 50, clientX: 5, clientY: 6 });
    scroll(-100);
    machine.flush(16);
    expect(kinds()).toEqual(["wheel", "down", "wheel"]);
  });

  /** While the space bar is down the pointer belongs to the camera, and so
   *  does the wheel. */
  it("declines while navigation owns the pointer", () => {
    tool.wantsWheel = true;
    suppressed = true;
    expect(scroll(-100)).toBe(false);
    machine.flush(16);
    expect(kinds()).toEqual([]);
  });
});

/**
 * The same question without a notch, so that something can be *drawn* about the
 * answer before the user spends a gesture finding it out (T-116). `app/main.ts`
 * reads it once a frame and turns it into a cursor.
 */
describe("whether a wheel notch would be the tool's", () => {
  it("is nobody's while the pointer is off the board", () => {
    tool.wantsWheel = true;
    expect(machine.wheelClaimed).toBe(false);
    expect(tool.askedWith).toEqual([]);
  });

  it("asks the tool about the hover, and answers what it says", () => {
    pointer("pointermove", { pointerId: 1, clientX: 40, clientY: 90 });
    expect(machine.wheelClaimed).toBe(false);
    tool.wantsWheel = true;
    expect(machine.wheelClaimed).toBe(true);
    expect(tool.askedWith.at(-1)).toEqual({
      x: 40,
      y: 90,
      shift: false,
      ctrl: false,
      alt: false,
    });
  });

  /**
   * `Alt`+wheel is a different gesture from a bare one — "adjust the whole
   * string" against one segment (DESIGN section 3.4) — so an affordance that
   * ignored the modifiers would be pointing at the wrong one of the two.
   */
  it("carries the modifiers that are held, with no event to read them from", () => {
    pointer("pointermove", { pointerId: 1, clientX: 40, clientY: 90 });
    key("AltRight");
    key("ControlLeft");
    void machine.wheelClaimed;
    expect(tool.askedWith.at(-1)).toMatchObject({ alt: true, ctrl: true, shift: false });
  });

  it("lets go of them again", () => {
    pointer("pointermove", { pointerId: 1, clientX: 40, clientY: 90 });
    key("AltLeft");
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "AltLeft" }));
    void machine.wheelClaimed;
    expect(tool.askedWith.at(-1)).toMatchObject({ alt: false });
  });

  /** The same truce `claimWheel` keeps: while the space bar is down the wheel
   *  is the camera's, so nothing may say otherwise. */
  it("is false while navigation owns the pointer", () => {
    pointer("pointermove", { pointerId: 1, clientX: 40, clientY: 90 });
    tool.wantsWheel = true;
    suppressed = true;
    expect(machine.wheelClaimed).toBe(false);
  });

  it("goes back to nobody's when the pointer leaves the board", () => {
    pointer("pointermove", { pointerId: 1, clientX: 40, clientY: 90 });
    tool.wantsWheel = true;
    expect(machine.wheelClaimed).toBe(true);
    pointer("pointerleave", { pointerId: 1 });
    expect(machine.wheelClaimed).toBe(false);
  });
});
