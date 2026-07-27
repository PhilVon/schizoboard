/**
 * @vitest-environment happy-dom
 *
 * The re-raster contract, which is the half of `World` that is not one line of
 * CSS: when everything holding its own bitmap is told to rebuild it, and at what
 * scale.
 *
 * > **will-change goes on at gesture start and comes off on a debounced gesture
 * > end**, at which point the world layer re-rasterises and everything holding
 * > its own bitmap is told to re-raster at devicePixelRatio * zoom. Never leave
 * > it on at steady state. — DESIGN section 6.6
 *
 * Everything here is about *when*, so the timers are fake and the assertions are
 * on the notifications. What the listeners do with the number is
 * `render/items/dom.ts`'s business (the ink canvas and the photograph's variant
 * choice), and it is tested there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { World } from "@/render/world";

let host: HTMLElement;
let world: World;
let scales: number[];

/** The one number every re-raster is a multiple of. Read rather than assumed,
 *  because happy-dom's is 1 and a browser's very often is not. */
const DPR = (): number => window.devicePixelRatio;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  world = new World(host);
  scales = [];
  world.onRasterize((scale) => scales.push(scale));
});

afterEach(() => {
  vi.useRealTimers();
  host.remove();
});

describe("the settled camera", () => {
  it("re-rasters at once, without waiting for a gesture that is not coming", () => {
    // The opening `camera.fit`. Nobody gestured into this zoom, so nothing would
    // ever end and every bitmap would be built for a scale of 1 (T-63).
    world.settle(0.5);
    expect(scales).toEqual([0.5 * DPR()]);
  });

  it("ignores a change too small to see", () => {
    world.settle(1);
    // A 1.25x swing is where a stretched bitmap starts being visible; re-rastering
    // the board for a hair either side of that is pure waste.
    world.settle(1.1);
    expect(scales).toEqual([1 * DPR()]);

    world.settle(2);
    expect(scales).toEqual([1 * DPR(), 2 * DPR()]);
  });

  it("takes over a gesture that is still settling, rather than firing twice", () => {
    world.gestureTick(4);
    world.settle(4);
    vi.runAllTimers();

    // Both are statements about where the camera ended up, and they agree. The
    // debounced one arriving afterwards would re-raster the whole board a second
    // time for nothing.
    expect(scales).toEqual([4 * DPR()]);
  });
});

describe("a gesture", () => {
  it("promotes the world layer while it runs and drops it when it stops", () => {
    world.gestureTick(2);
    // Never left on at steady state — a layer pinned at a stale scale is the
    // zoom-blur trap DESIGN section 6.6 spends a paragraph on.
    expect(host.querySelector<HTMLElement>(".layer-world")!.style.willChange).toBe("transform");
    expect(scales).toEqual([]);

    vi.runAllTimers();
    expect(host.querySelector<HTMLElement>(".layer-world")!.style.willChange).toBe("");
    expect(scales).toEqual([2 * DPR()]);
  });

  it("re-rasters once for a roll of the wheel, not once per notch", () => {
    for (const zoom of [1.1, 1.3, 1.6, 2, 2.5]) {
      world.gestureTick(zoom);
      vi.advanceTimersByTime(30);
    }
    expect(scales).toEqual([]);

    vi.runAllTimers();
    // The debounce is the whole point: the scale that matters is the one the
    // hand stopped at.
    expect(scales).toEqual([2.5 * DPR()]);
  });
});
