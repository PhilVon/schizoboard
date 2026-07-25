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
