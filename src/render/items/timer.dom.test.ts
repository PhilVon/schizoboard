/**
 * @vitest-environment happy-dom
 *
 * The travel clock's face — T-395.
 *
 * Its own file rather than more of `dom.test.ts`, on the arrangement the deck,
 * the editor, the page and the redaction already have: this face has a resolver
 * of its own to wire and a reading that moves without anybody touching the
 * board, so every test here needs a fixture the other faces do not.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { NO_TIMER, timerFace, type TimerFace, type TimerFields } from "@/lib/timer";
import { DomItemLayer } from "@/render/items/dom";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemCold } from "@/state/scene";

let host: HTMLDivElement;
let scene: Scene;
let dirty: DirtySets;
let layer: DomItemLayer;

/** The instant every reading here is taken at, unless a test moves it. */
const T0 = 1_700_000_000_000;
let now = T0;
let detailed = true;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  host.className = "layer-world";
  document.body.append(host);
  scene = new Scene();
  dirty = new DirtySets();
  now = T0;
  detailed = true;
  layer = new DomItemLayer(
    host,
    () => ({ url: "", phase: "ready", fraction: 0 }),
    undefined,
    undefined,
    undefined,
    undefined,
    // The shape `app/main.ts` wires: the mirror's record, and the frame's one
    // reading of the wall clock.
    (id) => {
      const fields = scene.cold(id)?.timer;
      return fields === null || fields === undefined ? null : timerFace(fields, now, detailed);
    },
  );
});

function put(id: string, timer: Partial<TimerFields> | null, over: Partial<ItemCold> = {}): void {
  scene.putItem(
    {
      id,
      type: timer === null ? "note" : "timer",
      z: "a0",
      seed: 1,
      assetId: null,
      createdBy: 1,
      createdAt: 0,
      text: "",
      timer: timer === null ? null : { ...NO_TIMER, ...timer },
      ...over,
    },
    { x: 0, y: 0, rot: 0, w: 90, h: 70 },
  );
  dirty.item(id);
}

function frame(): void {
  layer.sync(scene, dirty, null);
  dirty.clear();
}

/** The one clock on the board, or the first of them. */
const faceOf = (): HTMLElement => host.querySelector<HTMLElement>(".item-timer")!;
const digitsOf = (): HTMLElement => host.querySelector<HTMLElement>(".timer-digits")!;

describe("the clock's face", () => {
  it("mounts as its own archetype rather than as paper", () => {
    put("t", { mode: "clock" });
    put("n", null);
    frame();
    expect(host.querySelectorAll(".item-timer")).toHaveLength(1);
    // The note beside it is unaffected — the archetype test is on the type and
    // must not catch anything else.
    expect(host.querySelectorAll(".item-paper")).toHaveLength(1);
    expect(faceOf().querySelector(".timer-glass")).not.toBeNull();
  });

  it("stays a timer even carrying an assetId a peer wrote", () => {
    // `archetypeOf` asks the type first, before the mime switch, so a stray
    // asset on a timer cannot turn it into a photograph or a folder. This is
    // why that line is first rather than a case inside the switch.
    put("t", { mode: "clock" }, { assetId: "sha256-whatever" });
    frame();
    expect(host.querySelectorAll(".item-timer")).toHaveLength(1);
    expect(host.querySelectorAll(".item-polaroid")).toHaveLength(0);
  });

  it("has no silhouette, so nothing tries to cut a torn edge into it", () => {
    put("t", { mode: "clock" });
    frame();
    // A machine in a moulded case. The rectangle standing is the answer rather
    // than the absence of one.
    expect(layer.silhouetteOf(scene, "t")).toBeNull();
  });

  it("prints the time of day on a clock", () => {
    put("t", { mode: "clock" });
    frame();
    // Local time, off `now`, with no timezone of its own — the clock on the wall
    // says what time it is here. Compared against the formatter rather than a
    // literal, so the test does not depend on the machine running it.
    expect(digitsOf().textContent).toBe(timerFace({ ...NO_TIMER }, T0, true).label);
    expect(digitsOf().textContent).toMatch(/^\d\d:\d\d$/);
  });

  it("counts a countdown down, and lights up when it runs out", () => {
    put("t", { mode: "countdown", runsFor: 90_000, runFrom: T0 });
    frame();
    expect(digitsOf().textContent).toBe("1:30");
    expect(faceOf().classList.contains("is-expired")).toBe(false);

    now = T0 + 60_000;
    dirty.item("t");
    frame();
    expect(digitsOf().textContent).toBe("0:30");

    now = T0 + 90_000;
    dirty.item("t");
    frame();
    // Ceiled, so `0:00` arrives at the instant it expires and not a second
    // before — `lib/timer.ts` argues that one at length.
    expect(digitsOf().textContent).toBe("0:00");
    expect(faceOf().classList.contains("is-expired")).toBe(true);
  });

  it("hangs the lamp over the dial and under the glass", () => {
    // T-402, and the reason it is asserted on the *order* rather than on a
    // colour: `.timer-dial`'s background is opaque, so a lamp appended before it
    // is painted and then painted straight out again. Nothing throws, no class
    // is missing, `is-expired` still reaches the export — the clock simply never
    // lights, and the only amber left is the ring of bezel outside the dial.
    //
    // Under the glass still, because the reflection is on top of what it
    // reflects and a bulb that outshone it would be a lamp on the window.
    put("t", { mode: "countdown", runsFor: 1, runFrom: T0 });
    frame();
    const inside = [...faceOf().querySelector(".timer-body")!.children].map(
      (child) => child.className,
    );
    expect(inside).toEqual(["timer-dial", "timer-lamp", "timer-glass"]);
  });

  it("wears its mode, so the stylesheet can dress the three differently", () => {
    put("t", { mode: "stopwatch", runFrom: T0 });
    frame();
    expect(faceOf().dataset["mode"]).toBe("stopwatch");
  });

  it("prints the caption, and hides the line when there is none", () => {
    put("t", { mode: "countdown", runsFor: 1_000 }, { text: "  tea  " });
    frame();
    const caption = host.querySelector<HTMLElement>(".timer-caption")!;
    expect(caption.textContent).toBe("tea");
    expect(caption.classList.contains("is-empty")).toBe(false);

    put("t2", { mode: "clock" });
    frame();
    const empty = host.querySelectorAll<HTMLElement>(".timer-caption")[1]!;
    expect(empty.textContent).toBe("");
    expect(empty.classList.contains("is-empty")).toBe(true);
  });

  it("declares tabular figures, and adds no font of its own", () => {
    put("t", { mode: "clock" });
    frame();
    // The class is the contract with `items.css`; `tests/timer-face-css.test.ts`
    // is what checks the declaration is actually on it, in the arrangement
    // `card-title-css` already has with this stylesheet.
    expect(digitsOf().classList.contains("timer-digits")).toBe(true);
    // A text node and never `writeHand` — a clock's numerals are printed on a
    // dial. A hand would have put one span per character in here.
    expect(digitsOf().children.length).toBe(0);
  });

  it("says its reading out loud, because nobody touched it to change it", () => {
    put("t", { mode: "clock" });
    frame();
    expect(digitsOf().getAttribute("role")).toBe("status");
  });
});

describe("what the face refuses to write", () => {
  it("writes nothing to the DOM when the quantised value has not moved", () => {
    put("t", { mode: "countdown", runsFor: 600_000, runFrom: T0 });
    frame();
    const before = digitsOf().textContent;

    // Half a second later, and the item dirtied by something else entirely — a
    // drag, a peer's edit. The label has not moved, so the guard has to refuse.
    now = T0 + 500;
    dirty.item("t");
    frame();
    expect(digitsOf().textContent).toBe(before);

    // And it does move when the second does.
    now = T0 + 1_000;
    dirty.item("t");
    frame();
    expect(digitsOf().textContent).not.toBe(before);
  });

  it("keeps the same text node rather than replacing it on a no-op", () => {
    // The stronger form of the criterion, and the one a `textContent` compare
    // cannot see: assigning the same string still tears down and rebuilds the
    // node, which is a DOM write and would show up in a paint.
    put("t", { mode: "countdown", runsFor: 600_000, runFrom: T0 });
    frame();
    const node = digitsOf().firstChild;
    expect(node).not.toBeNull();

    for (let i = 1; i <= 20; i += 1) {
      now = T0 + i * 16;
      dirty.item("t");
      frame();
    }
    // Three hundred and twenty milliseconds of dirty frames, and the same text
    // node throughout.
    expect(digitsOf().firstChild).toBe(node);

    now = T0 + 1_000;
    dirty.item("t");
    frame();
    expect(digitsOf().firstChild).not.toBe(node);
  });

  it("still writes when the mode changes under an unmoved quantum", () => {
    // The case that says why `mode` is in the guard beside the quantum, and it
    // is not contrived: a stopwatch four seconds in reads `0:04` at quantum 4,
    // and a countdown with four seconds left reads `0:04` at quantum 4 as well.
    // The quantum alone cannot tell them apart, so a guard naming only the
    // quantum leaves a device that has been turned to countdown still saying it
    // is a stopwatch — to the stylesheet and to anything else reading the
    // attribute.
    put("t", { mode: "stopwatch", runFrom: T0 - 4_000 });
    frame();
    expect(digitsOf().textContent).toBe("0:04");
    expect(faceOf().dataset["mode"]).toBe("stopwatch");

    put("t", { mode: "countdown", runsFor: 8_000, runFrom: T0 - 4_000 });
    frame();
    expect(digitsOf().textContent).toBe("0:04");
    expect(faceOf().dataset["mode"]).toBe("countdown");
  });

  it("still lights up when expiry flips under an unmoved quantum", () => {
    // And the case for `expired`. A countdown with no length at all quantises to
    // zero and has not expired — zero is a countdown nobody set. Give it a
    // length shorter than the run already on it and it is expired *at the same
    // quantum*, which is exactly what setting a length on a running countdown
    // does.
    put("t", { mode: "countdown", runsFor: 0, runFrom: T0 - 5_000 });
    frame();
    expect(digitsOf().textContent).toBe("0:00");
    expect(faceOf().classList.contains("is-expired")).toBe(false);

    put("t", { mode: "countdown", runsFor: 1_000, runFrom: T0 - 5_000 });
    frame();
    expect(digitsOf().textContent).toBe("0:00");
    expect(faceOf().classList.contains("is-expired")).toBe(true);
  });

  it("shrinks the figures for a reading with an hours field", () => {
    // A countdown set for an afternoon reads `2:00:00`, which is seven glyphs on
    // a dial cut for five. Found at 3x on the running app: at the full size it
    // ran off both ends and the case clipped it.
    put("t", { mode: "countdown", runsFor: 2 * 60 * 60 * 1_000, runFrom: T0 });
    frame();
    expect(digitsOf().textContent).toBe("2:00:00");
    expect(faceOf().style.getPropertyValue("--digit-fit")).toBe((5 / 7).toFixed(3));

    // And gives the size back when the reading gets short again — an hour later,
    // the same countdown reads `1:00:00`, and under an hour it is five again.
    put("t", { mode: "countdown", runsFor: 90_000, runFrom: T0 });
    frame();
    expect(digitsOf().textContent).toBe("1:30");
    expect(faceOf().style.getPropertyValue("--digit-fit")).toBe("");
  });

  it("reads a running countdown to the minute below the full tier", () => {
    put("t", { mode: "countdown", runsFor: 600_000, runFrom: T0 });
    detailed = false;
    frame();
    expect(digitsOf().textContent).toBe("10:00");

    // Nine seconds on. At the full tier this is `9:51`; here nobody can read a
    // seconds digit, and a face that printed one would be showing whichever
    // second happened to fall on the one frame a minute it was allowed to write.
    now = T0 + 9_000;
    dirty.item("t");
    frame();
    expect(digitsOf().textContent).toBe("10:00");

    now = T0 + 61_000;
    dirty.item("t");
    frame();
    expect(digitsOf().textContent).toBe("9:00");
  });

  it("draws a blank dial for a caller with no clock behind it", () => {
    // The default resolver. A blank face says "nobody wired the clock"; a
    // default of zero would have said half past one on the first of January
    // 1970 and looked like a working timer somebody had set wrong.
    const bare = new DomItemLayer(host, () => ({ url: "", phase: "ready", fraction: 0 }));
    put("t", { mode: "clock" });
    bare.sync(scene, dirty, null);
    expect(host.querySelector<HTMLElement>(".timer-digits")!.textContent).toBe("");
    bare.destroy();
  });
});

describe("the pool", () => {
  it("shows the second timer's reading on a node released from the first", () => {
    // AC-1105, and the reason every guard in `TimerView` is cleared in
    // `release`: a pooled node comes back wearing the last object's subtree, and
    // a guard that survived the release would refuse to write the new one's
    // time. The first is a stopwatch reading four seconds; the second is a
    // countdown with a minute and a half on it, so a node that kept either the
    // digits or the mode is unmistakable.
    put("a", { mode: "stopwatch", runFrom: T0 - 4_000 });
    frame();
    const node = host.querySelector<HTMLElement>(".item-timer")!;
    expect(node.querySelector(".timer-digits")!.textContent).toBe("0:04");

    scene.removeItem("a");
    dirty.item("a");
    frame();
    expect(host.querySelectorAll(".item-timer")).toHaveLength(0);

    put("b", { mode: "countdown", runsFor: 90_000, runFrom: T0 }, { text: "b" });
    frame();
    const second = host.querySelector<HTMLElement>(".item-timer")!;
    // The same node, recycled — which is what makes the assertion below mean
    // anything at all.
    expect(second).toBe(node);
    expect(second.querySelector(".timer-digits")!.textContent).toBe("1:30");
    expect(second.dataset["mode"]).toBe("countdown");
    expect(second.querySelector(".timer-caption")!.textContent).toBe("b");
  });

  it("clears the guard, not just the picture, when a node goes back", () => {
    // The sharpest form of AC-1105, and the one a differently-reading second
    // timer cannot make: both of these read `0:04`, at quantum 4. So the pooled
    // node's guard would *match* on the first frame of the second object, and a
    // release that put the subtree back without clearing `boundQuantum` and
    // `boundMode` would hand back a face that silently refuses to be rebound.
    // Nothing about the digits would look wrong; the mode would be a lie.
    put("a", { mode: "stopwatch", runFrom: T0 - 4_000 });
    frame();
    const node = host.querySelector<HTMLElement>(".item-timer")!;
    expect(node.dataset["mode"]).toBe("stopwatch");

    scene.removeItem("a");
    dirty.item("a");
    frame();

    put("b", { mode: "countdown", runsFor: 8_000, runFrom: T0 - 4_000 });
    frame();
    const second = host.querySelector<HTMLElement>(".item-timer")!;
    expect(second).toBe(node);
    expect(second.dataset["mode"]).toBe("countdown");
    expect(second.querySelector(".timer-digits")!.textContent).toBe("0:04");
  });

  it("gives back a node that had gone off, without the lamp still on", () => {
    put("a", { mode: "countdown", runsFor: 1_000, runFrom: T0 - 5_000 });
    frame();
    const node = host.querySelector<HTMLElement>(".item-timer")!;
    expect(node.classList.contains("is-expired")).toBe(true);

    scene.removeItem("a");
    dirty.item("a");
    frame();
    put("b", { mode: "clock" });
    frame();
    const second = host.querySelector<HTMLElement>(".item-timer")!;
    expect(second).toBe(node);
    // A clock has nothing to expire, and a lamp left on would be this node's
    // last life showing through.
    expect(second.classList.contains("is-expired")).toBe(false);
    expect(second.dataset["mode"]).toBe("clock");
  });

  it("swaps the face when an item stops being a timer", () => {
    put("a", { mode: "clock" });
    frame();
    expect(host.querySelectorAll(".item-timer")).toHaveLength(1);

    // A peer writing a different type is the only way this happens — the type is
    // immutable to this build — and the layer already handles it by releasing
    // the view and taking one from the other pool.
    put("a", null);
    frame();
    expect(host.querySelectorAll(".item-timer")).toHaveLength(0);
    expect(host.querySelectorAll(".item-paper")).toHaveLength(1);
  });

  it("releases every pooled clock when the layer is torn down", () => {
    put("a", { mode: "clock" });
    frame();
    scene.removeItem("a");
    dirty.item("a");
    frame();
    // Into the pool, not the tree. `destroy` iterates the pool record by value
    // rather than naming buckets, which is what stops the seventh face being the
    // fourth thing that line forgets (T-339).
    expect(() => layer.destroy()).not.toThrow();
    expect(host.children.length).toBe(0);
  });
});

describe("the light", () => {
  it("counter-rotates, so a crooked clock is lit from the board's own light", () => {
    put("t", { mode: "clock" });
    scene.setPose("t", { rot: 0.7 });
    dirty.item("t");
    frame();
    const el = faceOf();
    const turn = el.style.getPropertyValue("--turn");
    expect(turn).not.toBe("");
    // Against the item's own rotation, in degrees. Without this the reflection
    // on the glass would be fixed in the clock's frame, and a wall of clocks at
    // a wall of angles would each be lit from its own private sun (T-313).
    expect(Number.parseFloat(turn)).toBeCloseTo((-0.7 * 180) / Math.PI, 1);
    expect(el.style.getPropertyValue("--lx")).not.toBe("");
    expect(el.style.getPropertyValue("--ly")).not.toBe("");
  });
});

describe("the reading the face is handed", () => {
  it("is the same quantum the tick dirtied the item for", () => {
    // The coupling that keeps the two layers honest, asserted directly rather
    // than through either of them: `readingQuantum` decides when the item is
    // dirtied and `timerFace` decides what is printed, and they are one
    // function so that a face cannot change on a frame nothing dirtied.
    const fields: TimerFields = { ...NO_TIMER, mode: "countdown", runsFor: 90_000, runFrom: T0 };
    const seen = new Map<number, string>();
    for (let ms = 0; ms <= 3_000; ms += 100) {
      const face: TimerFace = timerFace(fields, T0 + ms, true);
      const held = seen.get(face.quantum);
      // One label per quantum, in both directions: a quantum that carried two
      // labels would be a digit that changed with nothing dirtying it, and two
      // quanta carrying one label would be an item dirtied for nothing.
      if (held !== undefined) expect(held).toBe(face.label);
      else seen.set(face.quantum, face.label);
    }
    // Thirty-one samples across three seconds, and exactly four distinct
    // quanta — 90, 89, 88, 87 seconds left. Asserted so the loop above cannot
    // pass by finding nothing: a quantum that never moved would be one entry,
    // and one that moved every sample would be thirty-one.
    expect(seen.size).toBe(4);
    expect([...seen.values()]).toEqual(["1:30", "1:29", "1:28", "1:27"]);
  });
});
