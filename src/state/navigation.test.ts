import { describe, expect, it } from "vitest";

import { classifyWheel } from "@/state/navigation";

function wheel(init: Partial<WheelEvent>): WheelEvent {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    ...init,
  } as WheelEvent;
}

describe("classifyWheel", () => {
  it("treats a synthesised ctrl+wheel as a pinch, whatever its magnitude", () => {
    expect(classifyWheel(wheel({ deltaY: 3, ctrlKey: true }))).toBe("zoom");
    expect(classifyWheel(wheel({ deltaY: -0.5, metaKey: true }))).toBe("zoom");
  });

  it("treats line and page deltas as a real wheel", () => {
    expect(classifyWheel(wheel({ deltaY: 3, deltaMode: 1 }))).toBe("zoom");
    expect(classifyWheel(wheel({ deltaY: 1, deltaMode: 2 }))).toBe("zoom");
  });

  it("treats any horizontal component as a two-finger scroll", () => {
    expect(classifyWheel(wheel({ deltaX: -12, deltaY: 4 }))).toBe("pan");
    expect(classifyWheel(wheel({ deltaX: 2, deltaY: 220 }))).toBe("pan");
  });

  it("splits pure vertical on magnitude — a notch zooms, inertia pans", () => {
    expect(classifyWheel(wheel({ deltaY: 100 }))).toBe("zoom");
    expect(classifyWheel(wheel({ deltaY: -120 }))).toBe("zoom");
    expect(classifyWheel(wheel({ deltaY: 8.5 }))).toBe("pan");
    expect(classifyWheel(wheel({ deltaY: -3 }))).toBe("pan");
  });
});
