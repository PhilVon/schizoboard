/**
 * @vitest-environment happy-dom
 *
 * The debug overlay's shell: which key it answers to, and the promise that it
 * is *nothing at all* when it is off.
 *
 * The marks themselves are not tested here and could not usefully be — happy-dom
 * has no 2D context, so every stroke would be asserted against a double of the
 * canvas API rather than against pixels. What is worth pinning down is the part
 * a mistake in would be invisible: a canvas left in the tree after the overlay
 * was switched off is a full-viewport element over the board that nothing draws
 * to and nothing clears, and the first symptom of that is somebody else's paint
 * bug two tasks later. The drawing is checked by driving the real window.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RemoteDebugPainter } from "@/render/presence/remotedebug";
import { Camera } from "@/state/camera";
import type { RemoteDebug } from "@/state/remote";

let host: HTMLElement;
let painter: RemoteDebugPainter;
let camera: Camera;

const NO_PEERS: readonly RemoteDebug[] = [];

/** happy-dom lays nothing out, so a host is 0×0 and the painter — which
 *  declines to make a canvas for a viewport with no area — would never make
 *  one. These are the numbers a real `ui` layer would have. */
function size(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
}

const canvas = (): HTMLCanvasElement | null => host.querySelector("canvas.remote-debug");

const backquote = (init: KeyboardEventInit = {}): void => {
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote", ...init }));
};

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  size(host, 1200, 800);
  document.body.append(host);
  camera = new Camera();
  camera.resize(1200, 800);
  painter = new RemoteDebugPainter(host);
});

afterEach(() => {
  painter.destroy();
});

describe("the remote-drag debug overlay", () => {
  it("starts off, with no canvas in the tree", () => {
    expect(painter.visible).toBe(false);
    painter.draw(camera, NO_PEERS);
    expect(canvas()).toBeNull();
  });

  it("opens on Alt+backquote and closes on it", () => {
    backquote({ altKey: true });
    expect(painter.visible).toBe(true);
    backquote({ altKey: true });
    expect(painter.visible).toBe(false);
  });

  /**
   * The other two are taken: a bare backquote is the HUD and a shifted one is
   * the physics panel. Answering to either would open two things on one press.
   */
  it("leaves the bare and shifted backquotes to the HUD and the physics panel", () => {
    backquote();
    expect(painter.visible).toBe(false);
    backquote({ shiftKey: true });
    expect(painter.visible).toBe(false);
    backquote({ ctrlKey: true });
    expect(painter.visible).toBe(false);
  });

  it("makes its canvas on the first frame after it is switched on", () => {
    backquote({ altKey: true });
    expect(canvas()).toBeNull();
    painter.draw(camera, NO_PEERS);
    expect(canvas()).not.toBeNull();
  });

  /** Off means gone. A blank full-viewport canvas left over the board is the
   *  failure this exists to rule out. */
  it("takes its canvas back out of the tree when it is switched off", () => {
    backquote({ altKey: true });
    painter.draw(camera, NO_PEERS);
    expect(canvas()).not.toBeNull();

    backquote({ altKey: true });
    expect(canvas()).toBeNull();
    painter.draw(camera, NO_PEERS);
    expect(canvas()).toBeNull();
  });

  it("leaves nothing behind when it is destroyed, and stops answering the key", () => {
    backquote({ altKey: true });
    painter.draw(camera, NO_PEERS);
    painter.destroy();

    expect(canvas()).toBeNull();
    backquote({ altKey: true });
    expect(painter.visible).toBe(false);
  });
});
