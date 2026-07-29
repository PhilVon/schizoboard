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

// The frame proportions live in lib/ because paste has to size an item to the
// same shape this draws it at, and a mismatch is silently a crop rather than
// visibly a bug.
//
// Written in pixels rather than as CSS percentages, and that is not a style
// preference. Percentage padding resolves against the *containing block's*
// width — and the world wrapper is a zero-width point carrying the camera
// transform, so every percentage in an item would silently compute to zero.
import { carryScale } from "@/lib/carry";
import type { InkSample } from "@/lib/ink";
import { FRAME_BOTTOM, FRAME_SIDE } from "@/lib/polaroid";
import { rotateIn, type Point } from "@/lib/rotate";
import {
  defaultStock,
  grainPosition,
  paperGrainUrl,
  sheetTint,
  stockBase,
  stockRuling,
} from "@/render/items/paper";
import { ItemInk } from "@/render/ink/canvas";
import { TextEditor, type ItemEditorHooks } from "@/render/items/editor";
import { FILM_CLASSES, filmClass, filmGrainUrl } from "@/render/items/film";
import { counterRotate, shadowSprite, type Elevation } from "@/render/items/shadow";
import type { ItemLayer } from "@/render/items/view";
import type { AssetPhase } from "@/state/assets";
import type { DirtySets } from "@/state/dirty";
import type { ItemCold, Scene } from "@/state/scene";

/**
 * What this machine can show of an item's photograph.
 *
 * A URL alone was enough while there were two outcomes — a picture, or a blank
 * — and it stopped being enough the moment "missing" grew five states
 * (`state/assets.ts`, DATA-MODEL section 10). Undeveloped film, film that is
 * developing, and a photograph nobody has are three different pictures, and a
 * `""` cannot tell them apart.
 */
export interface AssetView {
  /** Where the bytes are, or `""` while there are none to point an `<img>` at. */
  readonly url: string;
  /** What this machine can currently do about them. */
  readonly phase: AssetPhase;
  /** 0…1 through the transfer, and 0 for every phase but `transferring`. */
  readonly fraction: number;
}

/** An item that names no asset at all. Blank film, and nothing is coming. */
const NO_ASSET: AssetView = { url: "", phase: "unknown", fraction: 0 };

/**
 * Where an item's photograph comes from.
 *
 * `screenPx` is the longest edge the image is about to be *drawn* at, in device
 * pixels. The layer knows that and nothing else useful; which stored variant best
 * serves it is a fact about the asset store, so the caller decides — that is what
 * keeps `render/` from needing to know that variants exist at all.
 */
export type AssetResolver = (sha256: string, screenPx: number) => AssetView;

type Archetype = "polaroid" | "paper";

/**
 * How many ink canvases may be re-rastered in one frame — see
 * [`DomItemLayer.paintInk`].
 *
 * Three, which is a guess with a reason rather than a measurement: a re-raster
 * is an allocation plus a fill per stroke, and the frame it lands on is the one
 * after a gesture ended, when the browser is already busy re-promoting the world
 * layer. The number to watch is the `ink` row in the dev HUD.
 */
const MAX_RASTERS_PER_FRAME = 3;

function archetypeOf(type: string): Archetype {
  return type === "polaroid" ? "polaroid" : "paper";
}

interface View {
  readonly el: HTMLDivElement;
  readonly archetype: Archetype;
  bind(cold: ItemCold, assetUrl: AssetResolver, screenPx: number): void;
  /** `lift` is the scene's carry transient, 0 at rest and 1 while carried. */
  transform(x: number, y: number, rot: number, w: number, h: number, lift: number): void;
  /**
   * Take the text editor's field in, beside the static text it stands in for,
   * or give it back (T-179).
   *
   * The field belongs to `ui/editor.ts` and outlives any one view. It is
   * offered again on every DOM phase rather than handed over once, because
   * these nodes are pooled and recycled between items — a field parked and
   * forgotten would be inherited by whichever note got this node next.
   */
  adopt(field: HTMLTextAreaElement | null): void;
  /**
   * The item's committed ink. Identical on both archetypes, which is right —
   * every kind of paper on this board can be drawn on (DESIGN section 2.1).
   */
  readonly ink: ItemInk;
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
    lift > 0 ? `${base} scale(${round(carryScale(lift), 1e4)})` : base;
}

function round(value: number, factor: number): number {
  return Math.round(value * factor) / factor;
}

class PolaroidView implements View {
  readonly archetype = "polaroid" as const;
  readonly el: HTMLDivElement;
  private readonly photo: HTMLImageElement;
  private readonly caption: HTMLDivElement;
  /** The editor's field while this caption is the one being written on. */
  private field: HTMLTextAreaElement | null = null;
  private boundAsset: string | null = null;
  private boundCold: ItemCold | null = null;
  /** The URL this view wants to be showing — see `swapPhoto`. */
  private pending: string | null = null;
  private framedFor = -1;
  /** The film state last painted. Null so the first bind always paints one. */
  private boundPhase: AssetPhase | null = null;
  /**
   * How far the wash has been raised, in whole percent.
   *
   * Whole percent because that is the resolution the eye gets out of a wash
   * across a two-inch photograph, and because a transfer is one callback per
   * chunk: a raw fraction would rewrite a custom property on every chunk, and
   * on every frame of a drag that happens to be in progress at the time.
   */
  private boundDevelop = -1;

  private readonly shadow = new ShadowNode();
  private readonly frame: HTMLDivElement;
  private readonly film: HTMLDivElement;
  readonly ink: ItemInk;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "item item-polaroid";
    this.ink = new ItemInk(this.el);

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
    // The `<img>` is now only ever pointed at bytes `state/assets.ts` has said
    // are on this disk, so a failure here is no longer "not arrived yet" — it
    // is a file that is present and will not decode. That is a photograph which
    // is not coming, which is what the torn treatment says (DESIGN section 7.5);
    // calling it "waiting" would promise an arrival that has already happened.
    this.photo.addEventListener("error", () => this.el.classList.add("is-waiting", "is-torn"));
    // And this is the only thing that may take the film off. Not the phase:
    // `ready` means the bytes are on the disk, and there is a decode between
    // that and pixels in this window.
    this.photo.addEventListener("load", () => this.el.classList.remove("is-waiting"));

    // The emulsion: grain, and whatever wash the phase calls for. Its own node
    // rather than more pseudo-elements on the window, because the grain needs a
    // per-item `background-position` and the window's background is the flat
    // backing every archetype shares.
    //
    // Always in the tree, shown only while `is-waiting`. A polaroid that is
    // waiting is the common case on a board that has just been joined, so
    // creating this on demand would mean a `createElement` storm at exactly the
    // moment the wire is busiest — and the pool exists to avoid that shape.
    this.film = document.createElement("div");
    this.film.className = "pol-film";
    this.film.style.backgroundImage = `url(${filmGrainUrl()})`;

    const gloss = document.createElement("div");
    gloss.className = "pol-gloss";

    this.caption = document.createElement("div");
    this.caption.className = "pol-caption";

    window_.append(this.photo, this.film, gloss);
    this.frame.append(window_, this.caption);
    this.el.append(this.shadow.el, this.frame);
  }

  bind(cold: ItemCold, assetUrl: AssetResolver, screenPx: number): void {
    // Two inputs, so two guards. The binding mints a fresh cold record every
    // time the *document* changes and `setPose` leaves it alone, so identity
    // covers everything the document can say — that is what lets a drag skip
    // sixty rebinds a second. What the asset resolves to is the other input, and
    // it changes with no document write at all: when the bytes finally arrive
    // (DESIGN section 7.5), while they are arriving, when the board runs out of
    // peers to ask, and again when the zoom crosses far enough for a different
    // variant to be the right one. Guarding on the record alone would leave that
    // photograph undeveloped for good; guarding on the URL alone would leave it
    // blank while it developed, because every state short of `ready` resolves to
    // the same empty string.
    const asset = cold.assetId ? assetUrl(cold.assetId, screenPx) : NO_ASSET;
    const develop = Math.round(asset.fraction * 100);
    const sameFilm = asset.phase === this.boundPhase && develop === this.boundDevelop;
    if (this.boundCold === cold && asset.url === this.boundAsset && sameFilm) return;
    this.boundCold = cold;
    if (!sameFilm) {
      this.boundPhase = asset.phase;
      this.boundDevelop = develop;
      this.paintFilm(asset.phase, develop);
    }
    if (asset.url !== this.boundAsset) {
      const replacing = Boolean(this.boundAsset);
      this.boundAsset = asset.url;
      this.swapPhoto(asset.url, replacing);
    }
    // The grain is one shared tile, so every waiting photograph would show the
    // identical crystals in the identical places without this — which is what
    // makes a wall of undeveloped film read as a repeated texture rather than as
    // twenty separate pieces of film. Same trick, and the same function, as the
    // fibres in a sheet of paper.
    this.film.style.backgroundPosition = grainPosition(cold.seed);
    this.caption.textContent = cold.text;
    this.caption.classList.toggle("is-empty", cold.text.length === 0);
    this.el.style.filter = sheetTint(cold.seed);
  }

  /**
   * Dress the window for what this machine can show — DESIGN section 7.5's
   * "art direction opportunity rather than an error".
   *
   * `is-waiting` goes *on* here, and only ever comes off in the `<img>`'s load
   * handler. The asymmetry is the point: `ready` is a fact about the disk, and
   * there is a decode between the disk and pixels in this window. Taking the
   * film off on the phase would blank the photograph for those frames, which is
   * the flash the wet/dry ink handoff exists to avoid elsewhere (T-58).
   */
  private paintFilm(phase: AssetPhase, develop: number): void {
    this.el.classList.remove(...FILM_CLASSES);
    const film = filmClass(phase);
    if (film) this.el.classList.add(film);
    if (phase !== "ready") this.el.classList.add("is-waiting");
    // Only while it means something. Left set, a photograph that arrived would
    // keep a stale wash height for the next item this node is recycled onto.
    if (phase === "transferring") this.el.style.setProperty("--develop", `${develop}%`);
    else this.el.style.removeProperty("--develop");
  }

  /**
   * Point the `<img>` at `url`.
   *
   * When there is nothing on screen yet, assign it and show the undeveloped-film
   * state until the load lands. Missing is a render state, not an error: the item
   * is fully usable — pinnable, stringable, annotatable — before its bytes arrive
   * (DESIGN section 7.5), and it should look like undeveloped film for the whole
   * of that wait, not for the instant before the src is assigned.
   *
   * The `is-waiting` here overlaps with `paintFilm` and is not redundant. That
   * one covers every phase short of `ready`; this covers the gap `ready` opens
   * on its own — bytes on the disk, no pixels in the window yet.
   *
   * When there *is* something on screen, this is a variant swap at a zoom
   * boundary, and assigning `src` would blank the photograph until the new bytes
   * decoded. So decode first and swap after. That is not a new idea — it is the
   * rule DESIGN already sets for ink, which re-rasters on a debounced zoom-end
   * with "the stale bitmap stretched in the interim" (T-63) — and it is also the
   * bounded decode policy D-15 asked for: only mounted items, only when the
   * variant actually changes, never a blanket warm-up of the whole board.
   */
  private swapPhoto(url: string, replacing: boolean): void {
    this.pending = url;
    if (!url) {
      // An empty src would trigger a network request for the page itself.
      this.photo.removeAttribute("src");
      this.el.classList.add("is-waiting");
      return;
    }
    if (!replacing) {
      this.photo.src = url;
      this.el.classList.add("is-waiting");
      return;
    }
    const next = new Image();
    next.decoding = "async";
    next.src = url;
    const apply = (): void => {
      // The view may have been released onto another item, or moved on to a
      // third variant, while this was in flight.
      if (this.pending !== url) return;
      this.photo.src = url;
    };
    // Either way: a decode that fails still has to hand over, or the item keeps
    // a variant it has outgrown for as long as the zoom stays there.
    void next.decode().then(apply, apply);
  }

  transform(x: number, y: number, rot: number, w: number, h: number, lift: number): void {
    if (w !== this.framedFor) {
      this.framedFor = w;
      const side = w * FRAME_SIDE;
      const bottom = w * FRAME_BOTTOM;
      this.frame.style.padding = `${side.toFixed(1)}px ${side.toFixed(1)}px ${bottom.toFixed(1)}px`;
      this.caption.style.fontSize = `${Math.max(9, w * 0.055).toFixed(1)}px`;
      // The caption's size is written per width rather than declared, so the
      // field has to be told the same number or the caption changes size the
      // moment you click into it.
      if (this.field) this.field.style.fontSize = this.caption.style.fontSize;
    }
    writeTransform(this.el, x, y, rot, w, h, lift);
    // Elevation before the offset: swapping sprites invalidates the written
    // rotation, so doing it the other way round leaves the new sprite wearing
    // the old sprite's offset for a frame and the shadow jumps sideways.
    setCarried(this.el, this.shadow, lift);
    this.shadow.update(rot);
  }

  adopt(field: HTMLTextAreaElement | null): void {
    if (field === null) {
      this.el.classList.remove("is-editing");
      this.field?.remove();
      this.field = null;
      return;
    }
    this.el.classList.add("is-editing");
    // Idempotent — re-appending a focused node blurs it, and that blur is what
    // closes the editor. See `PaperView.adopt`.
    if (this.field === field && field.parentNode === this.frame) return;
    this.field = field;
    field.className = "item-field pol-caption";
    // Not `is-empty`: an uncaptioned photograph hides its caption, and the
    // whole point of clicking into one is to give it a caption it has not got.
    field.style.fontSize = this.caption.style.fontSize;
    this.frame.append(field);
  }

  release(): void {
    this.caption.textContent = "";
    this.boundCold = null;
    this.adopt(null);
    // The photograph goes too. A pooled node keeps its subtree, so a view
    // recycled onto an item that happens to reference the same asset would
    // otherwise pass the URL guard, never request anything, and sit there
    // wearing the previous item's picture or its failure.
    this.boundAsset = null;
    // And an in-flight variant decode must not land on whoever gets this node
    // next; clearing `pending` is what `swapPhoto` checks before it assigns.
    this.pending = null;
    this.photo.removeAttribute("src");
    // And the film with it. Forgetting the phase is the load-bearing half:
    // `paintFilm` only runs when the phase differs from the one last painted,
    // and the item that gets this node next is very often in the *same* phase —
    // a viewport of one board's arriving photographs is exactly that — so a node
    // that remembered would never be dressed again. Stripping the classes as
    // well is what the line below already does for `is-waiting`: a released node
    // is left clean, so nothing downstream has to reason about what it was.
    //
    // The tear needs both, because it has a second way on that no phase knows
    // about: an `<img>` that failed to decode.
    this.el.style.removeProperty("--develop");
    this.boundPhase = null;
    this.boundDevelop = -1;
    this.el.classList.remove("is-lifted", "is-waiting", ...FILM_CLASSES);
    this.shadow.reset();
    // And the ink, for the reason the photograph goes: a pooled node keeps its
    // subtree, so a view recycled onto a different item would sit there wearing
    // the previous item's marks. The bitmap is a cache of strokes that are still
    // in the document, so this costs a re-raster if the item comes back.
    this.ink.release();
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
  /** The editor's field while this item is the one being written on (T-179). */
  private field: HTMLTextAreaElement | null = null;
  readonly ink: ItemInk;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "item item-paper";
    this.ink = new ItemInk(this.el);

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

  bind(cold: ItemCold, _assetUrl: AssetResolver, _screenPx: number): void {
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

  adopt(field: HTMLTextAreaElement | null): void {
    if (field === null) {
      this.el.classList.remove("is-editing");
      this.field?.remove();
      this.field = null;
      return;
    }
    this.el.classList.add("is-editing");
    // Idempotent: re-appending a focused node would blur it, which is the blur
    // that closes the editor. So the common case — the field is already here —
    // has to cost nothing and touch nothing.
    if (this.field === field && field.parentNode === this.surface) return;
    this.field = field;
    // Beside `.paper-text` and wearing its class, so the paper's hand, its
    // metrics and its stock rules all reach the field without being restated.
    // Beside rather than inside, because `bind` writes `textContent` on the
    // static node and that would take the field with it.
    field.className = "item-field paper-text";
    this.surface.append(field);
  }

  release(): void {
    this.body.textContent = "";
    this.boundCold = null;
    this.el.classList.remove("is-lifted");
    this.adopt(null);
    this.shadow.reset();
    this.ink.release();
  }
}

export class DomItemLayer implements ItemLayer {
  private readonly host: HTMLElement;
  private readonly assetUrl: AssetResolver;
  private readonly views = new Map<string, View>();
  private readonly pool: Record<Archetype, View[]> = { polaroid: [], paper: [] };

  /**
   * The caret, when there is one (T-179). Null when the layer was built with no
   * hooks — a headless test, or the spike harness — and `edit` is then a no-op
   * rather than a crash.
   */
  private readonly editor: TextEditor | null;
  /** The view holding the field, so the previous one can be told to let go. */
  private editorView: View | null = null;

  /**
   * Paint order over the **whole scene**, not over what is mounted, plus the z
   * keys it was computed from and the `z-index` each id was given.
   *
   * Scene-wide on purpose, and it is the fix for a measured 243 ms frame (D-13).
   * Ranking the mounted subset means every mount and unmount renumbers all its
   * neighbours, so under culling a zoom rewrote an inline style on ~180 nodes on
   * every frame of the gesture — a style invalidation on 180 elements per frame,
   * invisible in the phase timings because the cost lands in the browser after
   * the frame. Ranked against the whole scene, culling cannot perturb the
   * numbering at all: a mount is one style write, and only a real z change or a
   * created or deleted item re-sorts anything.
   *
   * The ranks are only ever used as relative integers, so the gaps that culled
   * items leave in the sequence cost nothing.
   */
  private order: string[] = [];
  private readonly orderedBy = new Map<string, string>();
  private readonly rank = new Map<string, number>();

  /**
   * `devicePixelRatio * zoom` — the scale the world layer was last rasterised
   * at, which is also the scale an item's photograph is about to be drawn at.
   *
   * 1 until told otherwise, so a layer nobody wires up asks for full-size images
   * rather than thumbnails: wrong in the cheap direction.
   */
  private rasterScale = 1;

  /** Reused by `hitTest`, which walks the paint order on every pointer move. */
  private readonly probe: Point = { x: 0, y: 0 };

  /**
   * Items whose ink canvas is out of date, waiting for the INK phase.
   *
   * This layer's, not the dirty sets'. `dirty.ink` is cleared at the end of
   * every frame (phase 9) and a re-raster deliberately may not finish in one —
   * see [`paintInk`] for the budget and why it exists.
   */
  private readonly inkPending = new Set<string>();

  constructor(host: HTMLElement, assetUrl: AssetResolver, editor?: ItemEditorHooks) {
    this.host = host;
    this.assetUrl = assetUrl;
    this.editor = editor ? new TextEditor(editor) : null;
  }

  get mounted(): number {
    return this.views.size;
  }

  get inked(): number {
    let n = 0;
    for (const view of this.views.values()) if (view.ink.live) n++;
    return n;
  }

  /**
   * Is this item's canvas still behind its strokes?
   *
   * Asked by the wet/dry handoff (T-58): the marker keeps drawing a committed
   * stroke on the overlay until the bitmap it was committed into has caught up,
   * and this is the only place that knows. Frame-counting would be the obvious
   * alternative and it is wrong in both directions — [`paintInk`]'s budget can
   * put the re-raster several frames out on a board full of ink, and an item that
   * is not mounted has no re-raster coming at all.
   *
   * False for an unmounted item for exactly that reason. Nothing is going to
   * appear where it is, so nothing is worth waiting for.
   */
  awaitingInk(id: string): boolean {
    return this.inkPending.has(id) && this.views.has(id);
  }

  get inkPixels(): number {
    let n = 0;
    for (const view of this.views.values()) n += view.ink.pixels;
    return n;
  }

  /**
   * INK phase (6). Re-raster the ink of the items that need it, a few at a time.
   *
   * Three things fill the queue: a stroke was committed or erased
   * (`dirty.ink`), an item came back into the viewport and its canvas had been
   * evicted (the mount path in `sync`), and `dirty.all` — which is what the
   * debounced gesture end raises, and is therefore the zoom-end re-raster of
   * everything on screen.
   *
   * **Budgeted, and that is not a micro-optimisation.** `world.onRasterize`
   * calls `dirty.everything()`, so without a cap one zoom-end reallocates and
   * repaints every ink canvas in the viewport inside a single frame — which is
   * the shape of the 777 ms frame the phase-0 spike measured (D-12): cost that
   * tracks the number of live nodes, landing on the frame after a gesture ends.
   * The items not reached this frame keep the bitmap they have and it stretches,
   * which is exactly what DESIGN section 9.3 asks for in the interim.
   *
   * An id that is not mounted is dropped rather than queued. The canvas is a
   * cache of strokes that are still in the document, so an item off screen has
   * nothing to be stale — and the mount path above will queue it if it returns.
   */
  paintInk(scene: Scene, dirty: DirtySets): void {
    if (dirty.all) {
      for (const [id, view] of this.views) if (view.ink.live || scene.hasInk(id)) this.inkPending.add(id);
    } else {
      for (const id of dirty.ink) if (this.views.has(id)) this.inkPending.add(id);
      // An item that was resized, with ink on it. The canvas is clipped to the
      // paper (T-136), so a note dragged wider has to give back the ink its old
      // edge was hiding and one dragged narrower has to stop showing what is now
      // off it. Asked of the canvas rather than tracked here, and only of items
      // that changed and already have one — a drag answers false, which is what
      // keeps this phase asleep while a photograph is being carried.
      for (const id of dirty.items) {
        const view = this.views.get(id);
        const slot = scene.slotOf(id);
        if (!view || slot === undefined) continue;
        if (view.ink.staleBox(scene.w[slot]!, scene.h[slot]!)) this.inkPending.add(id);
      }
    }
    if (this.inkPending.size === 0) return;

    let budget = MAX_RASTERS_PER_FRAME;
    for (const id of this.inkPending) {
      if (budget === 0) break;
      this.inkPending.delete(id);
      const view = this.views.get(id);
      const slot = scene.slotOf(id);
      if (!view || slot === undefined) continue;
      view.ink.update(scene.strokesOf(id), this.rasterScale, scene.w[slot]!, scene.h[slot]!);
      budget--;
    }
  }

  /**
   * The live smudge, rubbed into one item's bitmap — see `InkCanvas.rub`.
   *
   * Not budgeted and not queued, unlike everything else in the INK phase: this
   * is one fill on one canvas, it is the frame's answer to a pointer that is
   * down, and a rub that arrived a frame late would be a rubber that lags the
   * hand. False when the item is not mounted or has no ink to take away.
   */
  rubInk(id: string, samples: readonly InkSample[], size: number): boolean {
    return this.views.get(id)?.ink.rub(samples, size) ?? false;
  }

  get editing(): string | null {
    return this.editor?.itemId ?? null;
  }

  edit(itemId: string | null, text: string): void {
    if (!this.editor) return;
    if (itemId === null) this.editor.close();
    else this.editor.open(itemId, text);
    this.parkEditor();
  }

  /**
   * Put the field on the view the edited item currently has, take it off
   * whichever view had it before, and focus it once it is in the document.
   *
   * The layer does this rather than the editor placing itself, because only the
   * layer knows which view an item has — and views are pooled, so "currently"
   * is a question that has to be re-asked on every DOM phase.
   */
  private parkEditor(): void {
    const editor = this.editor;
    if (!editor) return;
    const id = editor.itemId;
    const view = id === null ? undefined : this.views.get(id);
    if (this.editorView && this.editorView !== view) this.editorView.adopt(null);
    this.editorView = view ?? null;
    if (view) {
      view.adopt(editor.field);
      // Only now is the field in the document, which is the earliest a focus
      // call does anything.
      editor.focusParked();
    } else {
      editor.field.remove();
    }
  }

  sync(scene: Scene, dirty: DirtySets, visible: ReadonlySet<string> | null): void {
    if (dirty.isClean) return;

    const wanted = visible ?? new Set(scene.itemIds());
    /**
     * The note being written on stays mounted whatever the culler thinks.
     *
     * Unmounting it would pull the field out of the document, and a focused
     * node removed from the document is a blur — which is the event that closes
     * the editor. Panning far enough to cull the note you are typing into would
     * end the sentence you were in the middle of.
     */
    const writing = this.editing;

    // Unmount anything that left the scene or the viewport.
    for (const [id, view] of this.views) {
      if ((wanted.has(id) || id === writing) && scene.has(id)) continue;
      view.release();
      view.el.remove();
      this.pool[view.archetype].push(view);
      this.views.delete(id);
    }

    /**
     * Does paint order need recomputing?
     *
     * Read off `dirty.items` rather than off the mounted walk below, because an
     * item that changed its z key while off screen still changes the order, and
     * the walk below never sees it.
     */
    let orderChanged = dirty.all;
    if (!orderChanged) {
      for (const id of dirty.items) {
        const cold = scene.cold(id);
        if (cold === null) {
          // Deleted. Only interesting if it was in the order to begin with.
          if (this.orderedBy.has(id)) orderChanged = true;
        } else if (this.orderedBy.get(id) !== cold.z) {
          orderChanged = true;
        }
        if (orderChanged) break;
      }
    }

    for (const id of wanted) this.place(scene, dirty, id);
    // And the note being written on, if the culler had left it out.
    if (writing !== null && !wanted.has(writing)) this.place(scene, dirty, writing);

    // Last, so it sees this frame's mounts: a note that has just come back into
    // the viewport has a different view from the one it left with.
    this.parkEditor();

    // `scene.size`, not `views.size`: the order covers the board, so what
    // invalidates it is an item arriving or leaving the board, never the
    // viewport. This is the comparison that used to make a pan re-sort.
    if (orderChanged || this.order.length !== scene.size) this.reorder(scene);
  }

  /** Mount `id` if it is not mounted, and write its transform if it moved. */
  private place(scene: Scene, dirty: DirtySets, id: string): void {
    // One map lookup per item per frame, and then the typed arrays directly.
    // This walk used to go through `poseOf`, which mints an object per item —
    // affordable when a clean frame skipped the whole loop, and hundreds of
    // allocations a frame now that culling makes a *pan* re-enter it.
    const slot = scene.slotOf(id);
    if (slot === undefined) return;
    const cold = scene.coldAt(slot);
    if (!cold) return;

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
      // Its rank is already known unless the order is about to be rebuilt
      // anyway, so mounting costs one style write and disturbs nobody else.
      const rank = this.rank.get(id);
      if (rank !== undefined) view.el.style.zIndex = String(rank);
      // Culling threw this item's canvas away when it left, which is the whole
      // point of the eviction — so coming back means rastering again. Queued
      // rather than done here: the DOM phase does not paint.
      if (scene.hasInk(id)) this.inkPending.add(id);
    }

    if (isNew || dirty.all || dirty.items.has(id)) {
      // The longest edge this item is about to occupy, in device pixels. What
      // the resolver does with it is the resolver's business.
      const screenPx = Math.max(scene.w[slot]!, scene.h[slot]!) * this.rasterScale;
      view.bind(cold, this.assetUrl, screenPx);
      view.transform(
        // The rendered centre, not the stored one: a hanging item turns about
        // its pin, and `drift` is the half of that which is a translation
        // (`state/scene.ts`).
        scene.renderX(slot),
        scene.renderY(slot),
        scene.renderRot(slot),
        scene.w[slot]!,
        scene.h[slot]!,
        scene.lift[slot]!,
      );
    }
  }

  /**
   * Paint order.
   *
   * `z` is a fractional-index *string*, so it cannot be handed to CSS. The
   * sorted position becomes the `z-index` instead. Sorting runs only when a key
   * actually changed or an item joined or left the board — dragging a photograph
   * around does not reorder anything, typing does not, and neither does panning
   * the whole board past the viewport.
   *
   * The style write is conditional on the rank having moved, which is what makes
   * a mount cheap: the common recompute is one item created, which shifts the
   * ranks above it and leaves everything below untouched and unwritten.
   */
  private reorder(scene: Scene): void {
    // In place, reusing the backing store.
    this.order.length = 0;
    for (const id of scene.itemIds()) this.order.push(id);
    this.order.sort((a, b) => {
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
      const id = this.order[i]!;
      this.orderedBy.set(id, scene.cold(id)!.z);
      const next = i + 1;
      if (this.rank.get(id) === next) continue;
      this.rank.set(id, next);
      const view = this.views.get(id);
      if (view) view.el.style.zIndex = String(next);
    }

    // Ranks for items that have left the board. Only when the count says some
    // must have, so the ordinary recompute pays nothing for this.
    if (this.rank.size > this.order.length) {
      const live = new Set(this.order);
      for (const id of this.rank.keys()) {
        if (live.has(id)) continue;
        this.rank.delete(id);
        this.orderedBy.delete(id);
      }
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
      const angle = scene.renderRot(slot);
      const local = rotateIn(
        boardX,
        boardY,
        scene.renderX(slot),
        scene.renderY(slot),
        Math.cos(angle),
        Math.sin(angle),
        this.probe,
      );
      if (Math.abs(local.x) <= scene.w[slot]! / 2 && Math.abs(local.y) <= scene.h[slot]! / 2) {
        return id;
      }
    }
    return null;
  }

  /** Every item on the board in paint order, bottom to top — not just the
   *  mounted ones, since culling must not be able to change the answer. */
  paintOrder(): readonly string[] {
    return this.order;
  }

  /**
   * The scale board content is being drawn at, `devicePixelRatio * zoom`.
   *
   * Arrives from `World.onRasterize` on the debounced gesture end — the same
   * moment everything holding its own bitmap is told to re-raster (DESIGN section
   * 6.6), which is exactly when a photograph should reconsider which stored
   * variant it wants. Per-frame would mean re-picking mid-gesture, and the whole
   * point of the debounce is that mid-gesture is when not to.
   *
   * The caller is expected to make the next frame dirty; this only records the
   * number, so that nothing is written outside the DOM phase.
   */
  setRasterScale(scale: number): void {
    if (Number.isFinite(scale) && scale > 0) this.rasterScale = scale;
  }

  private create(archetype: Archetype): View {
    return archetype === "polaroid" ? new PolaroidView() : new PaperView();
  }

  destroy(): void {
    // Before the views, since it takes the field out of one of them.
    this.editor?.destroy();
    this.editorView = null;
    // `release()` and not just `remove()`, because a released node frees its ink
    // canvas's backing store — dropping the element alone leaves the bitmap
    // alive until the collector gets to it, and a torn-down layer still holding
    // megabytes is the kind of leak that only shows up in a long session.
    for (const view of this.views.values()) {
      view.release();
      view.el.remove();
    }
    for (const pooled of [...this.pool.polaroid, ...this.pool.paper]) pooled.release();
    this.views.clear();
    this.inkPending.clear();
    this.pool.polaroid.length = 0;
    this.pool.paper.length = 0;
    this.order = [];
    this.orderedBy.clear();
    this.rank.clear();
  }
}
