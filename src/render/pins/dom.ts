/**
 * The pin layer: one pooled node per visible pin, in screen space.
 *
 * > Pins (DOM) — hit targets … above items and above string, because they're
 * > physically on top of both. — DESIGN sections 6.2 and 4.5
 *
 * ## Why this layer is not inside the camera transform
 *
 * Every other piece of board content lives in the world wrapper and lets one
 * CSS transform carry it. Pins cannot, because of the one rule that makes them
 * usable:
 *
 * > Pin head diameter stays within a range in *screen* space as you zoom out,
 * > so pins remain visible and clickable on a zoomed-out board rather than
 * > vanishing. This is a deliberate break from strict physical scaling and it's
 * > worth it. — DESIGN section 4.5
 *
 * A node inside a `scale()` is scaled by it, definitionally. Counter-scaling
 * each pin would mean writing a per-pin transform on every frame of every zoom
 * *anyway*, and doing it with a compounding pair of scales that quantises badly
 * at the ends of the range. So the pins sit in a full-viewport layer and are
 * positioned in CSS pixels, converted from the scene's world positions here.
 *
 * The cost is honest: a pan rewrites every mounted pin's transform. That is one
 * composited property on a few dozen nodes — the layer culls to the viewport —
 * against a permanent floor on how small a pin can get, which is what stops a
 * zoomed-out board from being a picture of some photographs with nothing
 * holding them up.
 *
 * ## No layout reads
 *
 * Same rule as the item layer. Nothing here calls `getBoundingClientRect` or
 * `elementFromPoint`; `hitTest` answers from the scene and the camera, so the
 * pointer and the paint can never disagree about where a pin is.
 */

import "@/render/pins/pins.css";

import type { CameraPose } from "@/render/cork";
import { tucked, type ShownPage } from "@/render/facing";
import {
  HEAD_FRACTION,
  pinSprite,
  type PinKind,
  type PinSprite,
} from "@/render/pins/sprite";
import type { Camera } from "@/state/camera";
import type { DirtySets } from "@/state/dirty";
import type { Scene } from "@/state/scene";

/**
 * The sprite box at 100% zoom, in board units.
 *
 * The *box*, not the head: the box also has to hold the shaft below the head
 * and the cast shadow beside it, so a pushpin's head is a little over half of
 * this. That works out at about 15 board units of head against the 170 to 330
 * units an item arrives at (`lib/polaroid.ts`) — roughly a 10 mm pushpin on a
 * 130 mm print, which is what a real one looks like.
 */
export const PIN_BOARD_SIZE = 30;

/**
 * The screen-space range from DESIGN section 4.5.
 *
 * The floor does the work the section is about: at the 5% zoom floor a pin
 * would otherwise be 1.5 px of box and under a pixel of head, and there would
 * be nothing to see or aim at. The ceiling is quieter and is about the bake — a
 * sprite is baked once at 128 device pixels (`sprite.ts`), so this is exactly
 * what a device pixel ratio of 2 can still resolve. At the 400% zoom ceiling
 * true scaling would want 120 px, so this trims the very largest pins by about
 * half; nobody has ever complained that a pushpin was too small at four
 * hundred percent.
 */
export const MIN_PIN_PX = 15;
export const MAX_PIN_PX = 64;

/**
 * The smallest a pin's grab radius may be, in screen pixels.
 *
 * At the floor the head is 9 px across, and "remain visible **and clickable**"
 * is one requirement with two halves. So the target is allowed to be larger
 * than the thing it is a target for — an 18 px circle, which is the usual
 * minimum for something you aim at with a mouse.
 */
const MIN_HIT_PX = 9;

/** Pins this far outside the viewport are still mounted, so one drifting in at
 *  the edge is already there rather than appearing. Screen pixels. */
const CULL_MARGIN_PX = 48;

/** The sprite box, in screen pixels, at a given zoom. */
export function pinScreenSize(zoom: number): number {
  return Math.min(MAX_PIN_PX, Math.max(MIN_PIN_PX, PIN_BOARD_SIZE * zoom));
}

/** How near the cursor has to be to a pin's centre to have hold of it. */
export function pinHitRadius(zoom: number): number {
  return Math.max(MIN_HIT_PX, pinScreenSize(zoom) * HEAD_FRACTION);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The part of a canvas context an export's pin pass touches.
 *
 * Narrow for the same reason `RasterTarget` is: placement, size and how many
 * pins reached the file are all readable from the calls made against this, and
 * none of them needs a real canvas.
 */
export type PinTarget = Pick<CanvasRenderingContext2D, "drawImage">;

class PinView {
  readonly el: HTMLDivElement;

  /** What has actually been written, so an untouched pin costs comparisons
   *  rather than style invalidations. NaN until the first write. */
  private sprite = "";
  private wx = Number.NaN;
  private wy = Number.NaN;
  private size = Number.NaN;
  private hovered = false;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pin";
  }

  bind(kind: string, color: string): void {
    const key = `${kind}|${color}`;
    if (key === this.sprite) return;
    this.sprite = key;
    const { url } = pinSprite(kind as PinKind, color);
    // An empty url is a context the browser would not give us. Draw nothing
    // rather than pointing the element at a request for the page itself.
    this.el.style.backgroundImage = url ? `url(${url})` : "";
  }

  place(screenX: number, screenY: number, size: number): void {
    if (size !== this.size) {
      this.size = size;
      this.el.style.width = `${round(size)}px`;
      this.el.style.height = `${round(size)}px`;
    }
    const x = round(screenX - size / 2);
    const y = round(screenY - size / 2);
    if (x === this.wx && y === this.wy) return;
    this.wx = x;
    this.wy = y;
    this.el.style.transform = `translate(${x}px, ${y}px)`;
  }

  hover(on: boolean): void {
    if (on === this.hovered) return;
    this.hovered = on;
    this.el.classList.toggle("is-hovered", on);
  }

  release(): void {
    // The sprite key goes with it: a node recycled onto a pin of the same kind
    // and colour would otherwise pass the guard and keep an image it was never
    // given. Position does not, because `place` is called before it is shown.
    this.sprite = "";
    this.el.style.backgroundImage = "";
    this.hover(false);
  }
}

export class PinLayer {
  private readonly host: HTMLElement;
  private readonly views = new Map<string, PinView>();
  private readonly pool: PinView[] = [];
  /**
   * The eyelet is the one thing this layer draws that nothing dirties. Moving
   * the cursor from one pin to the next changes no board state at all — it is
   * not a document write, not a scene mutation, and not a camera move — so the
   * frame it happens on is otherwise a clean one that this method returns from.
   */
  private hovered: string | null = null;
  /** See [`setShownPage`]. */
  private shownPage: ShownPage | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  /**
   * Which face each item is showing — T-330, and the same function the item
   * layer, the overlay and the pen are handed.
   *
   * A tape belongs to a page, so a thread taped to page four is inside the
   * folder when it shuts and behind the sheet when you turn past it. The pin
   * itself is the easy half of that: it is simply not drawn, not exported and
   * not grabbable while its page is not the page on show.
   *
   * Set rather than passed, because it is fixed for the life of the shell and
   * `sync` runs every frame. Null until the shell wires it, which is a board
   * with nothing open — see `tucked`.
   */
  setShownPage(resolve: ShownPage): void {
    this.shownPage = resolve;
  }

  get mounted(): number {
    return this.views.size;
  }

  /**
   * DOM phase (5). Positions every pin near the viewport and pools the rest.
   *
   * Reads `pin.wx`/`wy`, which the LAYOUT phase has already recomputed for
   * every pin whose item moved — this never resolves a parent itself, which is
   * what keeps the two phases from disagreeing about where a pin is.
   */
  sync(scene: Scene, camera: Camera, dirty: DirtySets, hovered: string | null): void {
    if (dirty.isClean && hovered === this.hovered) return;
    this.hovered = hovered;

    const size = pinScreenSize(camera.zoom);
    const zoom = camera.zoom;
    const margin = CULL_MARGIN_PX + size;

    for (const [id, view] of this.views) {
      if (scene.pins.has(id)) continue;
      this.unmount(id, view);
    }

    for (const [id, pin] of scene.pins) {
      // Inside a shut folder, or under the sheet on show — T-330. Pooled like
      // an off-screen pin rather than hidden with a class, because it is the
      // same fact: a pin nobody can see costs a node for nothing, and this one
      // stays away for as long as somebody reads another page.
      if (tucked(pin, this.shownPage)) {
        const view = this.views.get(id);
        if (view) this.unmount(id, view);
        continue;
      }
      const sx = (pin.wx - camera.x) * zoom;
      const sy = (pin.wy - camera.y) * zoom;
      if (
        sx < -margin ||
        sy < -margin ||
        sx > camera.width + margin ||
        sy > camera.height + margin
      ) {
        const view = this.views.get(id);
        if (view) this.unmount(id, view);
        continue;
      }

      let view = this.views.get(id);
      if (!view) {
        view = this.pool.pop() ?? new PinView();
        this.views.set(id, view);
        this.host.append(view.el);
      }
      view.bind(pin.kind, pin.color);
      view.place(sx, sy, size);
      view.hover(id === hovered);
    }
  }

  /**
   * EXPORT. Draw every pin into `ctx` at an export camera (T-214).
   *
   * The sixth painter, and it exists because "only the items are DOM" — the
   * sentence D-34, D-37 and `render/items/raster.ts` were all written on — was
   * not true. This layer is DOM as well, and it had no painter, so an image
   * export of a corkboard came back with the string running to nothing and not
   * a pushpin in it. The PDF route never had the fault, because Chromium prints
   * the live document.
   *
   * ## Three things this owes to the layer above rather than to the export
   *
   * 1. **It walks the scene, not the mounted views.** A pin outside the
   *    viewport has no node at all, and an export frames the whole board — so
   *    drawing what is mounted would draw whatever the window happened to be
   *    looking at.
   * 2. **The size is `pinScreenSize` of the export's own zoom.** Not a
   *    board-unit constant: the clamp is what keeps a pin visible on a board
   *    scaled down to fit a canvas ceiling, which is exactly the export that
   *    would otherwise lose them. At the ordinary 2× it does not bite at all,
   *    and a pin comes out at its true `PIN_BOARD_SIZE`.
   * 3. **The sprite is the bake, not its data URL.** Same cache the layer
   *    fills, so a board of one colour bakes once for the screen and the file
   *    both.
   *
   * Last of the six, because that is where DESIGN section 6.2 puts this layer:
   * above the items and above both rope canvases, since a pin is physically on
   * top of what it holds. Nothing here interleaves with paint order inside the
   * item layer, and it must not — pins have no paint order of their own.
   */
  drawInto(
    ctx: PinTarget,
    scene: Scene,
    camera: CameraPose,
    /**
     * How a kind and a colour become pixels.
     *
     * A seam for one reason, and it is not elegance: happy-dom hands back no 2D
     * context, so every bake there is `{ url: "", canvas: null }` and a test
     * against the real one would assert that nothing is drawn — while passing.
     * The bake itself is checked in `sprite.test.ts`; what this needs to prove
     * is where each pin lands and how big it is.
     */
    sprite: (kind: PinKind, color: string) => PinSprite = pinSprite,
  ): number {
    const size = pinScreenSize(camera.zoom);
    let drawn = 0;
    for (const pin of scene.pins.values()) {
      // A shut folder exports shut and an open one exports with its page
      // showing (DESIGN section 3.7), so a tape on page four is in neither
      // picture — T-330. The same rule the screen draws by, asked of the same
      // resolver, because an export that disagreed with the window about what
      // is on the board would be the worse of the two.
      if (tucked(pin, this.shownPage)) continue;
      const { canvas } = sprite(pin.kind as PinKind, pin.color);
      // No 2D context to bake with. Draw nothing rather than a black square —
      // the same answer `bind` gives the element.
      if (canvas === null) continue;
      const x = (pin.wx - camera.x) * camera.zoom - size / 2;
      const y = (pin.wy - camera.y) * camera.zoom - size / 2;
      ctx.drawImage(canvas, x, y, size, size);
      drawn += 1;
    }
    return drawn;
  }

  private unmount(id: string, view: PinView): void {
    view.release();
    view.el.remove();
    this.pool.push(view);
    this.views.delete(id);
  }

  /**
   * The pin under a screen point, or null.
   *
   * Nearest centre within the grab radius rather than first match, because pins
   * overlap freely — a hub pin with six strings on it usually has neighbours —
   * and "the one I was aiming at" is the nearest one, not whichever the map
   * happened to yield first. Pins have no paint order of their own to break the
   * tie with; they are all on the same layer, on top of everything.
   *
   * Walks every pin on the board rather than only the mounted ones. The two
   * sets are the same modulo the cull margin, and answering from the scene
   * means the answer cannot depend on what happens to be in the DOM.
   */
  hitTest(scene: Scene, camera: Camera, screenX: number, screenY: number): string | null {
    const radius = pinHitRadius(camera.zoom);
    let best: string | null = null;
    let bestDist = radius * radius;
    for (const [id, pin] of scene.pins) {
      // You cannot grab what you cannot see — T-330. Without this a tape inside
      // a shut folder still takes a press: it drags, it cuts, and the scissors
      // offer to cut a thread at a point on a cover with nothing drawn on it.
      if (tucked(pin, this.shownPage)) continue;
      const dx = (pin.wx - camera.x) * camera.zoom - screenX;
      const dy = (pin.wy - camera.y) * camera.zoom - screenY;
      const dist = dx * dx + dy * dy;
      if (dist > bestDist) continue;
      bestDist = dist;
      best = id;
    }
    return best;
  }

  destroy(): void {
    for (const view of this.views.values()) view.el.remove();
    this.views.clear();
    this.pool.length = 0;
  }
}
