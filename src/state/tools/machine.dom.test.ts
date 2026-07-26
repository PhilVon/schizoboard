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
import type { Tool, ToolContext, ToolInput } from "@/state/tools/tool";

class RecordingTool implements Tool {
  readonly id = "recording";
  readonly seen: ToolInput[] = [];
  readonly heldAtHandle: string[][] = [];
  ticks = 0;
  cancels = 0;

  handle(input: ToolInput, ctx: ToolContext): void {
    this.seen.push(input);
    this.heldAtHandle.push([...ctx.held]);
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

function pointer(type: string, init: Record<string, unknown>): void {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
  // happy-dom's PointerEvent drops the MouseEventInit coordinates.
  for (const k of ["clientX", "clientY"] as const) {
    if (event[k] !== (init[k] ?? 0)) Object.defineProperty(event, k, { value: init[k] ?? 0 });
  }
  (init["target"] as HTMLElement | undefined ?? root).dispatchEvent(event);
}

function kinds(): string[] {
  return tool.seen.map((i) => i.kind);
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
  const scene = new Scene();
  machine = new ToolMachine(tool, root, {
    scene,
    dirty: new DirtySets(),
    camera: new Camera(),
    selection: new Selection(),
    write: { setPoses: () => {}, deleteItems: () => {} },
    hitTest: () => null,
    suppressed: () => suppressed,
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

  it("stops listening once destroyed", () => {
    machine.destroy();
    pointer("pointerdown", { button: 0, pointerId: 10, clientX: 0, clientY: 0 });
    machine.flush(16);
    expect(tool.seen).toEqual([]);
  });
});
