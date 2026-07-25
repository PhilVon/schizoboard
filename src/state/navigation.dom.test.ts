/**
 * @vitest-environment happy-dom
 *
 * The wiring, not the arithmetic — camera.test.ts already covers the maths.
 * What is worth pinning down here is that a real event reaches the camera, and
 * that it does so *in the INPUT phase* rather than the instant it is
 * dispatched. If a listener ever mutates the camera directly, the DOM phase's
 * version check silently starts missing frames, and that is the kind of bug
 * that shows up as "it feels laggy sometimes".
 */

import { beforeEach, describe, expect, it } from "vitest";

import { Camera } from "@/state/camera";
import { Navigation } from "@/state/navigation";
import { World } from "@/render/world";

let root: HTMLDivElement;
let camera: Camera;
let navigation: Navigation;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.append(root);
  // happy-dom has no pointer capture; the calls only need to not throw.
  root.setPointerCapture = () => {};
  root.releasePointerCapture = () => {};
  root.hasPointerCapture = () => false;

  camera = new Camera();
  camera.resize(1000, 600);
  navigation = new Navigation(camera, root);
});

function wheel(init: Partial<WheelEventInit> & { clientX?: number; clientY?: number }): void {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  // happy-dom's WheelEvent ignores the MouseEventInit coordinates, which would
  // quietly feed the camera `undefined` and make every assertion NaN.
  if (event.clientX !== (init.clientX ?? 0)) {
    Object.defineProperty(event, "clientX", { value: init.clientX ?? 0 });
    Object.defineProperty(event, "clientY", { value: init.clientY ?? 0 });
  }
  root.dispatchEvent(event);
}

describe("Navigation", () => {
  it("does not touch the camera until the INPUT phase flushes", () => {
    const version = camera.version;
    wheel({ deltaY: -100, clientX: 500, clientY: 300 });
    expect(camera.version).toBe(version);
    expect(camera.zoom).toBe(1);

    navigation.flush();
    expect(camera.zoom).toBeGreaterThan(1);
    expect(navigation.gestured).toBe(true);
  });

  it("composes several wheel events landing in the same frame", () => {
    wheel({ deltaY: -100, clientX: 500, clientY: 300 });
    wheel({ deltaY: -100, clientX: 500, clientY: 300 });
    navigation.flush();
    const twoEvents = camera.zoom;

    const single = new Camera();
    single.resize(1000, 600);
    const factor = Math.exp(100 * 0.0015);
    single.zoomBy(factor * factor, 500, 300);

    expect(twoEvents).toBeCloseTo(single.zoom, 9);
  });

  it("zooms about the cursor, not the viewport centre", () => {
    const cursor = { x: 120, y: 90 };
    const before = camera.screenToBoard(cursor.x, cursor.y);
    wheel({ deltaY: -240, clientX: cursor.x, clientY: cursor.y });
    navigation.flush();
    const after = camera.screenToBoard(cursor.x, cursor.y);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("pans on a trackpad two-finger scroll", () => {
    wheel({ deltaX: 30, deltaY: 12 });
    navigation.flush();
    expect(camera.x).toBeCloseTo(30, 9);
    expect(camera.y).toBeCloseTo(12, 9);
    expect(camera.zoom).toBe(1);
  });

  it("pans on a middle-drag and reports no gesture on an idle frame", () => {
    root.dispatchEvent(
      new PointerEvent("pointerdown", { button: 1, pointerId: 7, clientX: 200, clientY: 200, bubbles: true, cancelable: true }),
    );
    root.dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 7, clientX: 260, clientY: 170, bubbles: true }),
    );
    navigation.flush();
    // Board dragged right 60 and up 30, so the camera moved the other way.
    expect(camera.x).toBeCloseTo(-60, 9);
    expect(camera.y).toBeCloseTo(30, 9);

    navigation.flush();
    expect(navigation.gestured).toBe(false);
  });

  it("ignores a primary drag unless space is held", () => {
    root.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, pointerId: 3, clientX: 100, clientY: 100, bubbles: true, cancelable: true }),
    );
    root.dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 3, clientX: 400, clientY: 100, bubbles: true }),
    );
    navigation.flush();
    expect(camera.x).toBe(0);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    root.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, pointerId: 4, clientX: 100, clientY: 100, bubbles: true, cancelable: true }),
    );
    root.dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 4, clientX: 400, clientY: 100, bubbles: true }),
    );
    navigation.flush();
    expect(camera.x).toBeCloseTo(-300, 9);
  });

  it("releases a stuck pan when the window loses focus mid-gesture", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    expect(navigation.panReady).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(navigation.panReady).toBe(false);
  });
});

describe("World", () => {
  it("writes the camera transform once and skips untouched frames", () => {
    const world = new World(root);
    camera.zoomTo(2, 0, 0);
    camera.x = 10;
    camera.y = -20;

    expect(world.applyCamera(camera)).toBe(true);
    expect(world.layers.world.style.transform).toBe("translate(-20px, 40px) scale(2)");

    expect(world.applyCamera(camera)).toBe(false);
    camera.panByBoard(1, 0);
    expect(world.applyCamera(camera)).toBe(true);
  });
});
