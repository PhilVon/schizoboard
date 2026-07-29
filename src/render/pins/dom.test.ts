/**
 * @vitest-environment happy-dom
 *
 * happy-dom has no 2D context, so `pinSprite` hands back an empty url and no
 * pin gets a background image. That is deliberately not stubbed here: what is
 * worth pinning down is the geometry — where a pin is written, how big, which
 * ones are mounted at all, and what the cursor is over — and none of it depends
 * on the bitmap. `sprite.test.ts` covers the bake.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_PIN_PX,
  MIN_PIN_PX,
  PIN_BOARD_SIZE,
  PinLayer,
  pinHitRadius,
  pinScreenSize,
} from "@/render/pins/dom";
import { HEAD_FRACTION } from "@/render/pins/sprite";
import { Camera, MIN_ZOOM } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene, type PinNode } from "@/state/scene";

let host: HTMLDivElement;
let scene: Scene;
let camera: Camera;
let dirty: DirtySets;
let layer: PinLayer;

function pin(id: string, wx: number, wy: number): PinNode {
  return { id, parent: null, lx: wx, ly: wy, kind: "pushpin", color: "#c8352f", wx, wy };
}

/** The layer only redraws a dirty frame, which is what the loop hands it. */
function sync(hovered: string | null = null): void {
  dirty.everything();
  layer.sync(scene, camera, dirty, hovered);
  dirty.clear();
}

beforeEach(() => {
  host = document.createElement("div");
  scene = new Scene();
  camera = new Camera();
  camera.resize(800, 600);
  dirty = new DirtySets();
  layer = new PinLayer(host);
});

describe("the screen-space clamp", () => {
  it("scales with the board through the middle of the zoom range", () => {
    expect(pinScreenSize(1)).toBe(PIN_BOARD_SIZE);
    expect(pinScreenSize(1.5)).toBe(PIN_BOARD_SIZE * 1.5);
  });

  /** AC-58, and the whole reason this layer is not inside the camera
   *  transform: 5% zoom would otherwise be 1.3 px of pin. */
  it("holds a floor at the bottom of the zoom range, so a pin never vanishes", () => {
    expect(pinScreenSize(0.05)).toBe(MIN_PIN_PX);
    expect(pinScreenSize(0.2)).toBe(MIN_PIN_PX);
  });

  it("stops growing before the sprite would be scaled past its bake", () => {
    expect(pinScreenSize(4)).toBe(MAX_PIN_PX);
  });

  it("keeps a pin clickable at the floor, where its head is under 10 px across", () => {
    const head = pinScreenSize(0.05) * HEAD_FRACTION;
    expect(head).toBeLessThan(10);
    expect(pinHitRadius(0.05)).toBeGreaterThan(head);
    expect(pinHitRadius(0.05) * 2).toBeGreaterThanOrEqual(18);
  });

  it("lets the grab radius grow with the head once the head is big enough", () => {
    expect(pinHitRadius(4)).toBeGreaterThan(pinHitRadius(1));
  });
});

describe("PinLayer", () => {
  it("mounts a pin at its screen position, centred on the head", () => {
    scene.putPin(pin("p", 100, 50));
    sync();

    const el = host.firstElementChild as HTMLDivElement;
    const size = pinScreenSize(1);
    expect(el.className).toBe("pin");
    expect(el.style.width).toBe(`${size}px`);
    expect(el.style.transform).toBe(`translate(${100 - size / 2}px, ${50 - size / 2}px)`);
  });

  it("follows the camera, because the layer is not inside its transform", () => {
    scene.putPin(pin("p", 100, 50));
    sync();
    camera.panByBoard(40, 0);
    sync();

    const el = host.firstElementChild as HTMLDivElement;
    const size = pinScreenSize(1);
    expect(el.style.transform).toBe(`translate(${60 - size / 2}px, ${50 - size / 2}px)`);
  });

  it("pools a pin that leaves the viewport and reuses the node when it returns", () => {
    scene.putPin(pin("p", 100, 100));
    sync();
    const first = host.firstElementChild;
    expect(layer.mounted).toBe(1);

    camera.panByBoard(5000, 0);
    sync();
    expect(layer.mounted).toBe(0);
    expect(host.childElementCount).toBe(0);

    camera.panByBoard(-5000, 0);
    sync();
    expect(layer.mounted).toBe(1);
    expect(host.firstElementChild).toBe(first);
  });

  it("unmounts a pin that left the board", () => {
    scene.putPin(pin("p", 10, 10));
    sync();
    scene.removePin("p");
    sync();
    expect(layer.mounted).toBe(0);
  });

  it("draws nothing on a clean frame", () => {
    scene.putPin(pin("p", 10, 10));
    sync();
    const el = host.firstElementChild as HTMLDivElement;
    el.style.transform = "scribbled-on";
    layer.sync(scene, camera, dirty, null);
    expect(el.style.transform).toBe("scribbled-on");
  });

  /** Moving the cursor changes no board state at all, so the frame it happens
   *  on is otherwise clean. */
  it("redraws for a hover even though nothing else changed", () => {
    scene.putPin(pin("p", 10, 10));
    sync();
    layer.sync(scene, camera, dirty, "p");
    const el = host.firstElementChild as HTMLDivElement;
    expect(el.classList.contains("is-hovered")).toBe(true);

    layer.sync(scene, camera, dirty, null);
    expect(el.classList.contains("is-hovered")).toBe(false);
  });

  it("does not leave the eyelet on a pooled node", () => {
    scene.putPin(pin("p", 10, 10));
    scene.putPin(pin("q", 5000, 10));
    sync("p");
    const el = host.firstElementChild as HTMLDivElement;

    scene.removePin("p");
    sync();
    // `q` is off screen, so the pool hands `p`'s node back for it next.
    camera.panByBoard(4900, 0);
    sync();
    expect(host.firstElementChild).toBe(el);
    expect(el.classList.contains("is-hovered")).toBe(false);
  });
});

describe("PinLayer.hitTest", () => {
  it("finds the pin under the cursor", () => {
    scene.putPin(pin("p", 200, 200));
    expect(layer.hitTest(scene, camera, 202, 198)).toBe("p");
  });

  it("finds nothing outside the grab radius", () => {
    scene.putPin(pin("p", 200, 200));
    const just = pinHitRadius(1) + 1;
    expect(layer.hitTest(scene, camera, 200 + just, 200)).toBeNull();
  });

  /** Pins overlap freely — a hub pin usually has neighbours — and they have no
   *  paint order of their own to break the tie with. */
  it("takes the nearest of two overlapping pins, not the first", () => {
    scene.putPin(pin("far", 200, 200));
    scene.putPin(pin("near", 204, 200));
    expect(layer.hitTest(scene, camera, 205, 200)).toBe("near");
  });

  /** The floor on the grab radius is what makes this true. */
  it("still finds a pin on a board zoomed out as far as it goes", () => {
    scene.putPin(pin("p", 1000, 1000));
    // The floor, not a literal: `setView` clamps, so a hard-coded zoom below it
    // would place the camera for one zoom and be read at another (T-204).
    camera.setView(1000 - 400 / MIN_ZOOM, 1000 - 300 / MIN_ZOOM, MIN_ZOOM);
    expect(layer.hitTest(scene, camera, 400, 300)).toBe("p");
    expect(layer.hitTest(scene, camera, 406, 300)).toBe("p");
  });

  it("answers from the scene, not from what happens to be mounted", () => {
    scene.putPin(pin("p", 200, 200));
    expect(layer.mounted).toBe(0);
    expect(layer.hitTest(scene, camera, 200, 200)).toBe("p");
  });
});
