import { describe, expect, it } from "vitest";

import { FrameLoop, PHASES } from "@/render/loop";

describe("FrameLoop", () => {
  it("runs every phase in the documented order", () => {
    const loop = new FrameLoop();
    const seen: string[] = [];
    // Register backwards to prove ordering comes from the phase list, not
    // from registration order.
    for (const phase of [...PHASES].reverse()) {
      loop.on(phase, () => seen.push(phase));
    }
    loop.step(16);
    expect(seen).toEqual([...PHASES]);
  });

  it("clamps dt so a backgrounded tab cannot detonate the solver", () => {
    const loop = new FrameLoop();
    let dt = -1;
    loop.on("sim", (frame) => {
      dt = frame.dt;
    });
    loop.step(0);
    loop.step(30_000);
    expect(dt).toBe(250);
  });

  /**
   * The other end of the same clamp, and the one that cost T-194 two sessions.
   *
   * `start()` seeds `last` from `performance.now()` while the rAF callback is
   * handed the timestamp the frame *began* at, so the very first frame of a run
   * can be older than the loop is. Driving `step()` by hand beside a live rAF —
   * which is how this application is meant to be driven a frame at a time —
   * makes the gap hundreds of milliseconds.
   */
  it("never hands a phase a negative dt, however far back the clock goes", () => {
    const loop = new FrameLoop();
    const seen: number[] = [];
    loop.on("sim", (frame) => seen.push(frame.dt));
    loop.step(1000);
    loop.step(1016);
    // A clock that has gone backwards by more than half a second.
    loop.step(400);
    // And one that has not moved at all.
    loop.step(400);
    expect(seen).toEqual([250, 16, 0, 0]);
  });

  it("counts frames monotonically and times each phase", () => {
    const loop = new FrameLoop();
    const indices: number[] = [];
    loop.on("input", (frame) => indices.push(frame.index));
    loop.step(0);
    loop.step(16);
    loop.step(32);
    expect(indices).toEqual([0, 1, 2]);
    expect(loop.timings.length).toBe(PHASES.length);
    // Phases nobody registered for cost exactly nothing, not "about nothing".
    expect(loop.timings[PHASES.indexOf("ropes")]).toBe(0);
  });

  it("stops calling a handler once it is unregistered", () => {
    const loop = new FrameLoop();
    let calls = 0;
    const off = loop.on("dom", () => calls++);
    loop.step(0);
    off();
    loop.step(16);
    expect(calls).toBe(1);
  });
});
