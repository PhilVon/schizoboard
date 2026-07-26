/**
 * The DOM item layer: four archetypes, one pool, one write phase.
 *
 * > They differ only in styling and defaults. Every archetype can hold text,
 * > can hold ink, can hold an image, and can be pinned. A scrap is not a
 * > special type in the code — it's a note that happens to have no text yet,
 * > which is exactly what a blank piece of paper is. — DESIGN section 2.1
 *
 * So there are two *views*, not four: a polaroid, and a sheet of paper. Note,
 * scrap and card are the same view with different stock.
 *
 * ## Pooling
 *
 * Off-screen items return their node to a pool and are removed from the tree
 * (DESIGN section 9.1 — "at high counts, removal genuinely beats hiding").
 * A pooled node keeps its subtree, so recycling one costs a few attribute
 * writes rather than a fresh `createElement` storm at the viewport edge.
 *
 * ## No layout reads
 *
 * Nothing here calls `getBoundingClientRect`, reads `offsetWidth`, or hit-tests
 * with `elementFromPoint`. Every geometry value comes from the scene, including
 * `hitTest`. One stray read in this file forces a synchronous layout and costs
 * the frame (ARCHITECTURE section 3).
 */

import "@/render/items/items.css";

import {
  defaultStock,
  grainPosition,
  paperGrainUrl,
  sheetTint,
  stockBase,
  stockRuling,
} from "@/render/items/paper";
import { counterRotate, shadowSprite, type Elevation } from "@/render/items/shadow";
import type { ItemLayer } from "@/render/items/view";
import type { DirtySets } from "@/state/dirty";
import type { ItemCold, Scene } from "@/state/scene";

export type AssetResolver = (sha256: string) => string;

type Archetype = "polaroid" | "paper";

function archetypeOf(type: string): Archetype {
  return type === "polaroid" ? "polaroid" : "paper";
}

interface View {
  readonly el: HTMLDivElement;
  readonly archetype: Archetype;
  bind(cold: ItemCold, assetUrl: AssetResolver): void;
  /** `lift` is the scene's carry transient, 0 at rest and 1 while carried. */
  transform(x: number, y: number, rot: number, w: number, h: number, lift: number): void;
  release(): void;
}

/**
 * The item's shadow, as a nine-slice sitting behind it.
 *
 * It is a child of the item so its silhouette rotates with the item, and its
 * offset is counter-rotated so the *light* does not. Every item on the board
 * therefore agrees about where the light is, which is the single cheapest
 * thing that makes a surface read as real (DESIGN section 4.1).
 */
class ShadowNode {
  readonly el: HTMLDivElement;
  private elevation: Elevation = "rest";
  private sprite = shadowSprite("rest");
  private writtenRot = Number.NaN;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "item-shadow";
    this.applySprite();
  }

  setElevation(elevation: Elevation): void {
    if (elevation === this.elevation) return;
    this.elevation = elevation;
    this.sprite = shadowSprite(elevation);
    this.applySprite();
    this.writtenRot = Number.NaN;
  }

  private applySprite(): void {
    const { url, slice } = this.sprite;
    if (!url) return;
    this.el.style.inset = `${-slice}px`;
    this.el.style.borderWidth = `${slice}px`;
    this.el.style.borderImageSource = `url(${url})`;
    this.el.style.borderImageSlice = `${slice} fill`;
  }

  update(rot: number): void {
    if (rot === this.writtenRot) return;
    this.writtenRot = rot;
    const offset = counterRotate(this.sprite.offsetX, this.sprite.offsetY, rot);
    this.el.style.transform = `translate(${offset.x.toFixed(2)}px, ${offset.y.toFixed(2)}px)`;
  }

  reset(): void {
    this.setElevation("rest");
  }
}

/**
 * How much bigger a carried item is. "it scales up by about 2%" — DESIGN
 * section 3.2. Applied to the transform rather than to the width, so it costs
 * no layout and does not change the item's real geometry: hit testing, pins and
 * the marquee all continue to agree about where the item is.
 */
const CARRY_SCALE = 0.02;

/** Shared by both views: position, rotation, size, and the carry. */
function writeTransform(
  el: HTMLDivElement,
  x: number,
  y: number,
  rot: number,
  w: number,
  h: number,
  lift: number,
): void {
  // Positioned entirely by transform. Writing left/top would invalidate layout
  // for every item that moved; a transform is composited.
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  // Rounded, because the scene stores Float32: 0.1 + 0.4 comes back as
  // 0.5000000074505806, and writing seventeen significant digits per item per
  // frame is a lot of string for sub-nanometre precision. Two decimals of a
  // board unit is well under a device pixel at the 400% zoom ceiling; five of
  // a radian moves the corner of a 300-unit item by three thousandths of one.
  const tx = round(x - w / 2, 100);
  const ty = round(y - h / 2, 100);
  const base = `translate(${tx}px, ${ty}px) rotate(${round(rot, 1e5)}rad)`;
  el.style.transform =
    lift > 0 ? `${base} scale(${round(1 + lift * CARRY_SCALE, 1e4)})` : base;
}

function round(value: number, factor: number): number {
  return Math.round(value * factor) / factor;
}

/**
 * The classic frame, as fractions of the photograph's width: a thin border on
 * three sides and a thick one at the bottom (DESIGN section 4.3).
 *
 * Written in pixels rather than as CSS percentages, and that is not a style
 * preference. Percentage padding resolves against the *containing block's*
 * width — and the world wrapper is a zero-width point carrying the camera
 * transform, so every percentage in an item would silently compute to zero.
 */
const FRAME_SIDE = 0.045;
const FRAME_BOTTOM = 0.17;

class PolaroidView implements View {
  readonly archetype = "polaroid" as const;
  readonly el: HTMLDivElement;
  private readonly photo: HTMLImageElement;
  private readonly caption: HTMLDivElement;
  private boundAsset: string | null = null;
  private boundCold: ItemCold | null = null;
  private framedFor = -1;

  private readonly shadow = new ShadowNode();
  private readonly frame: HTMLDivElement;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "item item-polaroid";

    // The frame is a separate box from the item so the shadow can extend past
    // the item's edge without being clipped by the frame's own containment.
    this.frame = document.createElement("div");
    this.frame.className = "pol-frame";

    const window_ = document.createElement("div");
    window_.className = "pol-window";

    this.photo = document.createElement("img");
    this.photo.className = "pol-photo";
    this.photo.decoding = "async";
    this.photo.draggable = false;
    this.photo.alt = "";

    const gloss = document.createElement("div");
    gloss.className = "pol-gloss";

    this.caption = document.createElement("div");
    this.caption.className = "pol-caption";

    window_.append(this.photo, gloss);
    this.frame.append(window_, this.caption);
    this.el.append(this.shadow.el, this.frame);
  }

  bind(cold: ItemCold, assetUrl: AssetResolver): void {
    // Two inputs, so two guards. The binding mints a fresh cold record every
    // time the *document* changes and `setPose` leaves it alone, so identity
    // covers everything the document can say — that is what lets a drag skip
    // sixty rebinds a second. The resolved URL is the other input, and it
    // changes with no document write at all when an item's bytes finally
    // arrive (DESIGN section 7.5); guarding on the record alone would leave
    // that photograph undeveloped for good.
    const url = cold.assetId ? assetUrl(cold.assetId) : "";
    if (this.boundCold === cold && url === this.boundAsset) return;
    this.boundCold = cold;
    if (url !== this.boundAsset) {
      this.boundAsset = url;
      // An empty src would trigger a network request for the page itself.
      if (url) this.photo.src = url;
      else this.photo.removeAttribute("src");
    }
    // Missing is a render state, not an error: the item is fully usable —
    // pinnable, stringable, annotatable — before its bytes arrive
    // (DESIGN section 7.5). The proper undeveloped-film treatment is T-75.
    this.el.classList.toggle("is-waiting", !url);
    this.caption.textContent = cold.text;
    this.caption.classList.toggle("is-empty", cold.text.length === 0);
    this.el.style.filter = sheetTint(cold.seed);
  }

  transform(x: number, y: number, rot: number, w: number, h: number, lift: number): void {
    if (w !== this.framedFor) {
      this.framedFor = w;
      const side = w * FRAME_SIDE;
      const bottom = w * FRAME_BOTTOM;
      this.frame.style.padding = `${side.toFixed(1)}px ${side.toFixed(1)}px ${bottom.toFixed(1)}px`;
      this.caption.style.fontSize = `${Math.max(9, w * 0.055).toFixed(1)}px`;
    }
    writeTransform(this.el, x, y, rot, w, h, lift);
    // Elevation before the offset: swapping sprites invalidates the written
    // rotation, so doing it the other way round leaves the new sprite wearing
    // the old sprite's offset for a frame and the shadow jumps sideways.
    setCarried(this.el, this.shadow, lift);
    this.shadow.update(rot);
  }

  release(): void {
    this.caption.textContent = "";
    this.boundCold = null;
    this.el.classList.remove("is-selected", "is-lifted");
    this.shadow.reset();
  }
}

/**
 * The shadow has exactly two bakes — resting and lifted — because they are
 * shared by every item on the board (`shadow.ts`). So the swap is a threshold
 * rather than a blend, taken halfway up, by which point the item is already
 * visibly growing and the change reads as part of the same movement.
 */
function setCarried(el: HTMLDivElement, shadow: ShadowNode, lift: number): void {
  const carried = lift > 0.5;
  shadow.setElevation(carried ? "lift" : "rest");
  el.classList.toggle("is-lifted", carried);
}

class PaperView implements View {
  readonly archetype = "paper" as const;
  readonly el: HTMLDivElement;
  private readonly shadow = new ShadowNode();
  private readonly surface: HTMLDivElement;
  private readonly grain: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private boundCold: ItemCold | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "item item-paper";

    // The sheet clips its own grain and text; the shadow lives outside it.
    this.surface = document.createElement("div");
    this.surface.className = "paper-surface";

    this.grain = document.createElement("div");
    this.grain.className = "paper-grain";

    this.body = document.createElement("div");
    this.body.className = "paper-text";

    this.surface.append(this.grain, this.body);
    this.el.append(this.shadow.el, this.surface);
  }

  bind(cold: ItemCold, _assetUrl: AssetResolver): void {
    if (this.boundCold === cold) return;
    this.boundCold = cold;
    const stock = defaultStock(cold.type, cold.seed);
    this.el.dataset["stock"] = stock;
    this.surface.style.background = stockBase(stock);
    this.surface.style.backgroundImage = stockRuling(stock);
    this.grain.style.backgroundImage = `url(${paperGrainUrl(cold.seed)})`;
    this.grain.style.backgroundPosition = grainPosition(cold.seed);
    this.surface.style.filter = sheetTint(cold.seed);
    this.body.textContent = cold.text;
  }

  transform(x: number, y: number, rot: number, w: number, h: number, lift: number): void {
    writeTransform(this.el, x, y, rot, w, h, lift);
    // Elevation before the offset: swapping sprites invalidates the written
    // rotation, so doing it the other way round leaves the new sprite wearing
    // the old sprite's offset for a frame and the shadow jumps sideways.
    setCarried(this.el, this.shadow, lift);
    this.shadow.update(rot);
  }

  release(): void {
    this.body.textContent = "";
    this.boundCold = null;
    this.el.classList.remove("is-selected", "is-lifted");
    this.shadow.reset();
  }
}

export class DomItemLayer implements ItemLayer {
  private readonly host: HTMLElement;
  private readonly assetUrl: AssetResolver;
  private readonly views = new Map<string, View>();
  private readonly pool: Record<Archetype, View[]> = { polaroid: [], paper: [] };

  /** Item ids in paint order, and the z keys the order was computed from. */
  private order: string[] = [];
  private readonly orderedBy = new Map<string, string>();

  /**
   * The last selection it was told about, kept so a view that mounts *later*
   * still gets its chrome. Everything else the layer draws arrives through the
   * scene and is therefore right on mount by construction; selection does not,
   * so it has to be remembered. Culling (T-27) is what makes this load-bearing
   * — a selected item panned off screen and back is a fresh mount.
   */
  private selected: ReadonlySet<string> = new Set();

  constructor(host: HTMLElement, assetUrl: AssetResolver) {
    this.host = host;
    this.assetUrl = assetUrl;
  }

  get mounted(): number {
    return this.views.size;
  }

  sync(scene: Scene, dirty: DirtySets, visible: ReadonlySet<string> | null): void {
    if (dirty.isClean) return;

    const wanted = visible ?? new Set(scene.itemIds());

    // Unmount anything that left the scene or the viewport.
    for (const [id, view] of this.views) {
      if (wanted.has(id) && scene.has(id)) continue;
      view.release();
      view.el.remove();
      this.pool[view.archetype].push(view);
      this.views.delete(id);
      this.orderedBy.delete(id);
    }

    let orderChanged = false;

    for (const id of wanted) {
      const cold = scene.cold(id);
      const pose = scene.poseOf(id);
      if (!cold || !pose) continue;

      let view = this.views.get(id);
      const isNew = view === undefined;
      const archetype = archetypeOf(cold.type);

      if (view && view.archetype !== archetype) {
        // Type is immutable after creation, so this only happens if a peer
        // wrote something strange. Swap rather than render the wrong thing.
        view.release();
        view.el.remove();
        this.pool[view.archetype].push(view);
        view = undefined;
      }

      if (!view) {
        view = this.pool[archetype].pop() ?? this.create(archetype);
        this.views.set(id, view);
        this.host.append(view.el);
        if (this.selected.has(id)) view.el.classList.add("is-selected");
      }

      if (isNew || dirty.all || dirty.items.has(id)) {
        const slot = scene.slotOf(id)!;
        view.bind(cold, this.assetUrl);
        view.transform(
          pose.x,
          pose.y,
          pose.rot + scene.swing[slot]!,
          pose.w,
          pose.h,
          scene.lift[slot]!,
        );
      }

      if (this.orderedBy.get(id) !== cold.z) {
        this.orderedBy.set(id, cold.z);
        orderChanged = true;
      }
    }

    if (orderChanged || this.order.length !== this.views.size) this.reorder(scene);
  }

  /**
   * Paint order.
   *
   * `z` is a fractional-index *string*, so it cannot be handed to CSS. The
   * sorted position becomes the `z-index` instead. Sorting runs only when a
   * key actually changed — dragging a photograph around does not reorder
   * anything, and neither does typing.
   */
  private reorder(scene: Scene): void {
    this.order = [...this.views.keys()].sort((a, b) => {
      const ca = scene.cold(a);
      const cb = scene.cold(b);
      if (!ca || !cb) return 0;
      if (ca.z !== cb.z) return ca.z < cb.z ? -1 : 1;
      // The same tie-break as compareOrder, so paint order matches the
      // document's total order on every peer (invariant 9).
      if (ca.createdBy !== cb.createdBy) return ca.createdBy - cb.createdBy;
      return ca.id < cb.id ? -1 : 1;
    });
    for (let i = 0; i < this.order.length; i++) {
      this.views.get(this.order[i]!)!.el.style.zIndex = String(i + 1);
    }
  }

  /**
   * Topmost item containing a board point, from the scene alone.
   *
   * Walks the paint order backwards, transforming the point into each item's
   * local frame rather than transforming the item into board space — one
   * rotation per candidate instead of four corners.
   */
  hitTest(scene: Scene, boardX: number, boardY: number): string | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const id = this.order[i]!;
      const slot = scene.slotOf(id);
      if (slot === undefined) continue;
      const angle = -(scene.rot[slot]! + scene.swing[slot]!);
      const dx = boardX - scene.x[slot]!;
      const dy = boardY - scene.y[slot]!;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      if (Math.abs(lx) <= scene.w[slot]! / 2 && Math.abs(ly) <= scene.h[slot]! / 2) return id;
    }
    return null;
  }

  /** Which items the layer is currently painting, bottom to top. */
  paintOrder(): readonly string[] {
    return this.order;
  }

  /**
   * Selection chrome. A class toggle per mounted view, so the caller is
   * expected to gate it on `Selection.version` rather than call it per frame.
   *
   * There is no matching `setLifted`: being carried is a *scene* value, not a
   * set the renderer is told about, so it arrives through `sync` with the rest
   * of the geometry. Selection is genuinely not in the scene — it is
   * per-person and never in the document — which is why it comes in by hand.
   */
  setSelected(ids: ReadonlySet<string>): void {
    // Copied, because the caller's set is live and this outlives the call.
    this.selected = new Set(ids);
    for (const [id, view] of this.views) {
      view.el.classList.toggle("is-selected", ids.has(id));
    }
  }

  private create(archetype: Archetype): View {
    return archetype === "polaroid" ? new PolaroidView() : new PaperView();
  }

  destroy(): void {
    for (const view of this.views.values()) view.el.remove();
    this.views.clear();
    this.pool.polaroid.length = 0;
    this.pool.paper.length = 0;
    this.order = [];
    this.orderedBy.clear();
  }
}
