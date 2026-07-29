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
let settled: number[];

/** The one number every re-raster is a multiple of. Read rather than assumed,
 *  because happy-dom's is 1 and a browser's very often is not. */
const DPR = (): number => window.devicePixelRatio;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  world = new World(host);
  scales = [];
  settled = [];
  world.onRasterize((scale) => scales.push(scale));
  world.onSettle((zoom) => settled.push(zoom));
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

/**
 * The LOD tier's wake-up (T-197). Deliberately not the re-raster's, because the
 * re-raster is gated on a 1.25x swing and a tier boundary is not something a
 * gate may be applied to.
 */
describe("the settle notification", () => {
  it("reports the zoom, not devicePixelRatio times the zoom", () => {
    world.settle(0.5);
    // The re-raster is choosing a bitmap resolution and wants device pixels.
    // A tier is choosing how much of an item to lay out, which happens in CSS
    // pixels on every display — see `render/lod.ts`.
    expect(settled).toEqual([0.5]);
    expect(scales).toEqual([0.5 * DPR()]);
  });

  it("fires for a swing far too small to re-raster for", () => {
    world.settle(0.36);
    world.settle(0.34);

    // 0.36 -> 0.34 is a swing of 1.06 and crosses DESIGN section 6.6's 35%
    // boundary. If this shared the raster gate, the tier would silently never
    // switch at the one zoom it exists for.
    expect(settled).toEqual([0.36, 0.34]);
    expect(scales).toEqual([0.36 * DPR()]);
  });

  it("waits out the debounce with everything else", () => {
    for (const zoom of [0.9, 0.7, 0.5, 0.3]) {
      world.gestureTick(zoom);
      vi.advanceTimersByTime(30);
    }
    expect(settled).toEqual([]);

    vi.runAllTimers();
    // One switch for a roll of the wheel. Changing tier mid-gesture would
    // rebuild every mounted item on a frame that is already promoted and
    // showing a cached layer, which nobody would see and everybody would pay
    // for.
    expect(settled).toEqual([0.3]);
  });

  it("stops telling a listener that has unsubscribed", () => {
    const off = world.onSettle((zoom) => settled.push(zoom * 100));
    world.settle(1);
    off();
    world.settle(2);

    expect(settled).toEqual([1, 100, 2]);
  });
});

describe("a gesture", () => {
  it("promotes the world layer while it runs and drops it in the write phase", () => {
    const promoted = (): string =>
      host.querySelector<HTMLElement>(".layer-world")!.style.willChange;

    world.gestureTick(2);
    // Never left on at steady state — a layer pinned at a stale scale is the
    // zoom-blur trap DESIGN section 6.6 spends a paragraph on.
    expect(promoted()).toBe("transform");
    expect(scales).toEqual([]);

    vi.runAllTimers();
    // Still promoted, deliberately (T-201). The re-raster and the LOD tier have
    // just been announced and nothing has written their consequences yet;
    // demoting now would repaint five hundred items as they were, and the next
    // frame would repaint them all again as they are. Measured at 562 ms then
    // 743 ms, of which the second was pure waste.
    expect(promoted()).toBe("transform");
    expect(scales).toEqual([2 * DPR()]);

    // The end of the DOM phase, after `items.sync`.
    world.flushDemote();
    expect(promoted()).toBe("");
  });

  it("keeps the promotion if a new gesture started before the demote flushed", () => {
    const promoted = (): string =>
      host.querySelector<HTMLElement>(".layer-world")!.style.willChange;

    world.gestureTick(2);
    vi.runAllTimers();
    // A hand that came back to the wheel in the one frame the demote was queued
    // for. Demoting into a live gesture is the blur trap, and this gesture has
    // its own debounce to queue its own demote.
    world.gestureTick(2.4);
    world.flushDemote();
    expect(promoted()).toBe("transform");

    vi.runAllTimers();
    world.flushDemote();
    expect(promoted()).toBe("");
  });

  it("costs nothing on a frame with no demote queued", () => {
    const promoted = (): string =>
      host.querySelector<HTMLElement>(".layer-world")!.style.willChange;

    world.gestureTick(2);
    // A board at rest calls this sixty times a second and it must not undo a
    // promotion nobody asked it to undo.
    world.flushDemote();
    world.flushDemote();
    expect(promoted()).toBe("transform");
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
