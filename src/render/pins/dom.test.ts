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
  return { id, parent: null, lx: wx, ly: wy, kind: "pushpin", color: "#c8352f", page: null, wx, wy };
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

/**
 * T-214. The export was built on "only the items are DOM" — a sentence in D-34,
 * D-37 and `render/items/raster.ts` — and this layer is DOM too. So an image
 * export of a corkboard came back with the string running to nothing and not
 * one pushpin in it, while reporting that every item had been drawn.
 */
describe("drawing the pins into an export", () => {
  /** A sprite that is a bitmap rather than nothing, which happy-dom's canvas
   *  cannot be. Named so the assertions can say which pin got which. */
  const sprites = (): ((kind: string, color: string) => { url: string; canvas: unknown }) => {
    const made = new Map<string, { url: string; canvas: unknown }>();
    return (kind: string, color: string) => {
      const key = `${kind}|${color}`;
      let hit = made.get(key);
      if (!hit) {
        hit = { url: `bake:${key}`, canvas: { key } };
        made.set(key, hit);
      }
      return hit;
    };
  };

  /** Every `drawImage` the pass made, as the four numbers that matter. */
  function recorder(): {
    ctx: { drawImage: (...args: unknown[]) => void };
    calls: { key: unknown; x: number; y: number; w: number; h: number }[];
  } {
    const calls: { key: unknown; x: number; y: number; w: number; h: number }[] = [];
    return {
      ctx: {
        drawImage: (...args: unknown[]) => {
          const [image, x, y, w, h] = args as [{ key: string }, number, number, number, number];
          calls.push({ key: image.key, x, y, w, h });
        },
      },
      calls,
    };
  }

  const draw = (
    view: { x: number; y: number; zoom: number },
    sprite = sprites(),
  ): ReturnType<typeof recorder> & { drawn: number } => {
    const rec = recorder();
    const drawn = layer.drawInto(
      rec.ctx as never,
      scene,
      view,
      sprite as never,
    );
    return { ...rec, drawn };
  };

  /** The sprite's centre is the pin's board position — `sprite.ts` anchors on
   *  the head so a string genuinely appears to pass beneath it. */
  it("centres the sprite on the pin, at the export camera", () => {
    scene.putPin(pin("p", 300, 200));
    const { calls, drawn } = draw({ x: 100, y: 100, zoom: 2 });

    expect(drawn).toBe(1);
    // 30 board units at 2x, and the clamp does not bite there.
    expect(calls[0]!.w).toBe(60);
    expect(calls[0]!.h).toBe(60);
    expect(calls[0]!.x).toBe((300 - 100) * 2 - 30);
    expect(calls[0]!.y).toBe((200 - 100) * 2 - 30);
  });

  /**
   * The whole reason this walks `scene.pins` rather than the mounted views: an
   * export frames the board and the window was framing something else, so what
   * is mounted is whatever the user happened to be looking at.
   */
  it("draws every pin on the board, not the ones the window had mounted", () => {
    scene.putPin(pin("here", 10, 10));
    scene.putPin(pin("far", 90_000, 90_000));
    sync();
    expect(layer.mounted).toBe(1);

    expect(draw({ x: 0, y: 0, zoom: 1 }).drawn).toBe(2);
  });

  /**
   * The clamp is not decoration in an export either: a board scaled down to fit
   * the canvas ceiling is exactly the file that would otherwise lose its pins
   * to a fraction of a pixel.
   */
  it("keeps a pin visible on a board scaled right down", () => {
    scene.putPin(pin("p", 0, 0));
    expect(draw({ x: 0, y: 0, zoom: 0.02 }).calls[0]!.w).toBe(MIN_PIN_PX);
    expect(draw({ x: 0, y: 0, zoom: 40 }).calls[0]!.w).toBe(MAX_PIN_PX);
  });

  it("takes one bake per kind and colour, however many pins wear it", () => {
    const sprite = sprites();
    for (let i = 0; i < 5; i++) scene.putPin(pin(`p${i}`, i * 40, 0));
    const { calls } = draw({ x: 0, y: 0, zoom: 1 }, sprite);
    expect(calls).toHaveLength(5);
    expect(new Set(calls.map((c) => c.key)).size).toBe(1);
  });

  /** No 2D context is a bake of nothing, and drawing nothing is better than
   *  drawing a black square — the answer `bind` already gives the element. */
  it("draws nothing for a sprite that could not be baked", () => {
    scene.putPin(pin("p", 0, 0));
    const { calls, drawn } = draw({ x: 0, y: 0, zoom: 1 }, (() => ({
      url: "",
      canvas: null,
    })) as never);
    expect(drawn).toBe(0);
    expect(calls).toEqual([]);
  });
});

/**
 * A tape belongs to a page, not to the folder — T-330.
 *
 * The pin's half of it is the easy half and is one rule: it is drawn, exported
 * and grabbable only while its page is the page on show. A shut folder shows no
 * page, so a tape inside one is never on show — the same sentence covering the
 * folder being shut and the reader being on page twelve, which is Q-291's whole
 * point. What the *thread* does is `render/ropes/paint.ts`'s.
 */
describe("a tape stuck to a page", () => {
  function tape(id: string, page: number): PinNode {
    return {
      id,
      parent: "folder",
      lx: 100,
      ly: 100,
      kind: "tape",
      color: "#c8352f",
      page,
      wx: 100,
      wy: 100,
    };
  }

  beforeEach(() => {
    scene.putPin(tape("t", 4));
    scene.putPin(pin("ordinary", 200, 200));
  });

  it("is mounted when the folder is open at its page", () => {
    layer.setShownPage(() => 4);
    sync();
    expect(layer.mounted).toBe(2);
  });

  it("is not mounted when the reader has turned past it", () => {
    layer.setShownPage(() => 12);
    sync();
    expect(layer.mounted).toBe(1);
  });

  it("is not mounted when the folder is shut", () => {
    layer.setShownPage(() => null);
    sync();
    expect(layer.mounted).toBe(1);
  });

  /** And it comes back, rather than being unmounted once and forgotten. */
  it("comes back when the page is turned to again", () => {
    let page: number | null = null;
    layer.setShownPage(() => page);
    sync();
    expect(layer.mounted).toBe(1);
    page = 4;
    sync();
    expect(layer.mounted).toBe(2);
  });

  /**
   * You cannot grab what you cannot see. Without this a tape inside a shut
   * folder still takes a press: it drags, it cuts, and the scissors offer to cut
   * a thread at a point on a cover with nothing drawn on it.
   */
  it("takes no press while it is put away", () => {
    layer.setShownPage(() => null);
    sync();
    expect(layer.hitTest(scene, camera, 100, 100)).toBeNull();
    layer.setShownPage(() => 4);
    expect(layer.hitTest(scene, camera, 100, 100)).toBe("t");
  });

  /**
   * An export of a shut folder is an export of a shut folder. The rule is asked
   * of the same resolver the screen asks, because an export that disagreed with
   * the window about what is on the board would be the worse of the two.
   */
  it("is not in an export of a shut folder", () => {
    const drawn: unknown[] = [];
    const ctx = { drawImage: (...args: unknown[]) => drawn.push(args) };
    const sprite = (): { url: string; canvas: HTMLCanvasElement } => ({
      url: "",
      canvas: document.createElement("canvas"),
    });
    layer.setShownPage(() => null);
    expect(layer.drawInto(ctx, scene, camera, sprite)).toBe(1);
    layer.setShownPage(() => 4);
    expect(layer.drawInto(ctx, scene, camera, sprite)).toBe(2);
  });

  /** A pin with no page is on the object, and nothing about it changes — which
   *  is every pin on every board that has never quoted a case file. */
  it("leaves an ordinary pin alone whatever is open", () => {
    layer.setShownPage(() => 99);
    sync();
    expect(layer.hitTest(scene, camera, 200, 200)).toBe("ordinary");
  });
});
