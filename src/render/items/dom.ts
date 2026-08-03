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
import type { ShownPage } from "@/state/facing";
import type { InkSample } from "@/lib/ink";
import {
  CAPTION_BOTTOM,
  CAPTION_HEIGHT,
  CAPTION_MEASURE,
  CAPTION_SIZE,
  FRAME_BOTTOM,
  FRAME_SIDE,
} from "@/lib/polaroid";
import {
  addressLabel,
  caseNumber,
  fitWriting,
  HAND_LINE,
  fitHost,
  fitLabel,
  PAGE_TEXT_SIZE,
  folderBulk,
  openSheetOf,
  pagesLabel,
  runtimeLabel,
  siteLabel,
  titleWorthWriting,
  type AssetKind,
} from "@/lib/objects";
import { rotateIn, type Point } from "@/lib/rotate";
import { valueAt } from "@/lib/seed";
import { grainPosition, paperGrainUrl, stockBase, stockRuling } from "@/render/items/paper";
import {
  faceOf,
  sheetEdgeOf,
  stockOf,
  tapeOf,
  tintOf,
  tornOf,
} from "@/render/items/style";
import { cornerCurl, cornerFace, CURL_PROPS, FACE_PROPS } from "@/render/items/curl";
import { edgePoints, EDGE_PROPS, insideEdge } from "@/render/items/edge";
import { ItemInk } from "@/render/ink/canvas";
import { Deck } from "@/render/items/deck";
import { TextEditor, type ItemEditorHooks } from "@/render/items/editor";
import { clearHand, writeHand } from "@/render/items/hand";
import type { PageView } from "@/app/pages";
import type { PageFigure, TextRun } from "@/platform/types";
import {
  exportStylesheet,
  rasteriseItems,
  type RasterCamera,
  type RasterItem,
  type RasterReport,
} from "@/render/items/raster";
import {
  emergeDelay,
  EMERGE_MIN_PX,
  FILM_CLASSES,
  filmClass,
  filmGrainUrl,
  IS_EMERGING,
} from "@/render/items/film";
import {
  counterRotate,
  LIGHT_DX,
  LIGHT_DY,
  shadowSprite,
  type Elevation,
} from "@/render/items/shadow";
import {
  MAX_TAPES,
  TAPE_LENGTH,
  TAPE_WIDTH,
  tapeAngle,
  tapeClipPath,
  tapeFlip,
} from "@/render/items/tape";
import { DETAIL, type Tier } from "@/render/lod";
import type { ItemLayer } from "@/render/items/view";
import {
  creaseFace,
  creaseOf,
  dogEarOf,
  IS_AGED,
  NO_AGEING,
  stainOf,
  wearFilter,
  wearOf,
  WEAR_PROPS,
  type AgeClock,
} from "@/render/items/wear";
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

/**
 * An item drawn as a card because it has only just arrived (T-202).
 *
 * The per-item twin of the layer host's `data-lod`, and it exists because a
 * mount storm is expensive for a reason that is nothing to do with zoom: what
 * costs is *having* the nodes. D-33 section 10 measured five hundred items
 * mounted as flat cards at 7,101 nodes and 6.9 ms a frame, against the same five
 * hundred mounted at full detail at 73,071 nodes and 632 ms — and separately
 * measured that a board which never unmounts costs 104 ms a frame to pan, with
 * nothing mounting at all.
 *
 * So an item that enters the tree during a camera move enters cheaply, at any
 * zoom, and is given its grain and its torn edge on the frame the camera stops.
 * The gesture pays for a tenth of the nodes it used to, and the upgrade lands on
 * a settled camera, which is the one moment there is budget for it.
 */
const COARSE = "is-coarse";

/**
 * How many items may be given their detail on one frame.
 *
 * A budget, unlike the one `payTheDetailDebt` used not to have, and T-203 is why.
 * Detail now arrives *during* a zoom in rather than on the frame the camera stops,
 * which is where motion hides it — but a tier rise at the 38.5% boundary catches
 * about a hundred and forty items mounted, and rebinding them all on one frame
 * costs **493 ms**. Measured.
 *
 * The budget does two things, and the second is the better one. It spreads the
 * cost. And it means an item culled before its turn is never upgraded at all:
 * during a zoom in to 400% those hundred and forty become six, so a hundred and
 * thirty-four of those rebinds were work thrown away a moment later. Waiting for
 * the settle used to avoid that by accident — which is why the old numbers looked
 * so good at 400% and so bad at 35%.
 *
 * Six, because a rebind of a texted sheet is around three and a half milliseconds
 * — 493 over a hundred and forty — so six is a little over the budget on the
 * worst frame and comfortably inside it on an ordinary one. A hundred and forty
 * items therefore take about a quarter of a second to come in, during a gesture,
 * which is a sweep rather than a snap.
 */
const UPGRADE_BUDGET = 6;


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

/**
 * Is this the first time this item's photograph has reached this screen — and
 * having asked, it no longer is.
 *
 * A view cannot answer this itself, and neither can the item. Views are pooled,
 * so the node an item comes back on is not the node it left on, and culling
 * means an item panned out of the viewport and back has genuinely been mounted
 * twice: the `<img>` is re-pointed, the browser serves it from cache, and `load`
 * fires again. Without a record that outlives both the mount and the node, a
 * photograph would develop every time it crossed the edge of the screen, which
 * is a board that flickers whenever it is panned.
 *
 * Keyed by item and not by asset hash, which are the same thing until somebody
 * pastes one picture twice. Two items wearing one photograph are two prints, and
 * seeing one of them come up is not having seen the other.
 */
export type FirstSight = (itemId: string) => boolean;

/**
 * What page is open on this case file, if any — T-320.
 *
 * Takes the asset hash and not the item id, because a page is a fact about the
 * file rather than about the thing on the wall: two folders of the same document
 * are the same pages. Which page is `state/` 's business (T-321) and not this
 * layer's, so the resolver answers for whichever one the reader is on.
 */
export type PageResolver = (sha256: string) => PageView | null;

/**
 * Which face an item is showing — `render/facing.ts`, and re-exported here
 * because this layer was its first caller and is where everything still looks
 * for it. It moved when a *pin* learned the same question (T-330) and a
 * predicate over it needed somewhere neutral to live.
 */
export type { ShownPage };

/**
 * What the document says a file is — as distinct from [`AssetView`], which is
 * what this machine can currently *show* of it.
 *
 * Two resolvers rather than one, and the split is not tidiness. Asking for a
 * URL has a side effect: it is what tells the exchange an asset is wanted now
 * (`app/main.ts`), so a second call to choose an archetype would be a second
 * WANT for every object on the board. This one is a pure read of the asset
 * record, which is also what lets it be asked *before* a view exists — the face
 * is chosen from the mime (D-46 section 2), and the mime is in here.
 *
 * Every field is a fact a peer holding no bytes at all still has, with one
 * deliberate exception. `title` is derived locally (Q-211): it is `""` on a
 * machine that does not hold the file, and `""` until the answer comes back on
 * one that does, which are the same state to a label and are both ordinary.
 */
export interface AssetFacts {
  readonly kind: AssetKind;
  /** The name the file arrived under, or `""` — the record's `origName`. */
  readonly name: string;
  /** What the file says it is called, once somebody has read it off the disk. */
  readonly title: string;
  /** Seconds, for a film or a recording. */
  readonly duration: number | null;
  /** Pages, for a document. */
  readonly pages: number | null;
  /**
   * The hash of the still that stands for a film, or `""` (T-270).
   *
   * A second asset, so it is resolved through the same `AssetResolver` as the
   * item's own — which is what raises the want on it and gives the tape a
   * picture the moment the bytes land, without this layer knowing anything
   * about transfers.
   */
  readonly poster: string;
  /**
   * The hash of the sidecar transcript that came in beside a recording, or `""`
   * — the record's `transcript` (T-287), and `""` for everything that is not a
   * film or a recording.
   *
   * Here as a *hash* and not as a boolean because the thing being asked is the
   * one `readableAsset` asks in `main.ts`: a recording is readable when its
   * record names a transcript, whether or not this machine holds the bytes of
   * it. Keeping the two answers the same shape is what stops a tape saying it
   * has no words on the one peer whose transfer has not committed yet (AC-668).
   *
   * Unlike `poster` it is never resolved through the `AssetResolver`: nothing
   * here draws the transcript, and a *want* raised on it would fetch a file
   * because somebody was looking at the outside of the box.
   */
  readonly transcript: string;
}

/** An item naming no asset, and a hash no record was ever written for. */
export const NO_FACTS: AssetFacts = {
  kind: "unknown",
  name: "",
  title: "",
  duration: null,
  pages: null,
  poster: "",
  transcript: "",
};

/** What the document says about an asset. Pure — see [`AssetFacts`]. */
export type AssetLookup = (sha256: string) => AssetFacts;

/**
 * The six faces.
 *
 * Three of them arrived together (T-267) and share one class, for the reason
 * five paper stocks share `PaperView`: what differs between a folder, a tape and
 * a cassette is furniture and colour, and what is the same is everything that
 * makes them items — the shadow, the tape, the ink, the transform, the labels
 * and the pooling. They are separate *archetypes* rather than one, so the pool
 * hands a recycled node back to its own kind and a cassette never has to be
 * dressed out of a folder's subtree.
 *
 * `card` is the sixth and the odd one (T-339) — the only face not chosen from a
 * mime. See [`archetypeOf`].
 */
type Archetype = "polaroid" | "paper" | "folder" | "vhs" | "cassette" | "card";

/** The three of them, as the one type that means "an object with a file in it". */
type CaseArchetype = "folder" | "vhs" | "cassette";

function isCase(archetype: Archetype): archetype is CaseArchetype {
  return archetype === "folder" || archetype === "vhs" || archetype === "cassette";
}

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

/**
 * Which face an item wears.
 *
 * > No new item types. The face is chosen from the asset's mime.
 * > — D-46 section 2
 *
 * So this takes two arguments and not one, and the second is the whole of that
 * sentence: the *type* separates a sheet of paper from a thing with a file
 * behind it, and the file's *kind* separates the four things that can be. An
 * item of type `polaroid` whose asset is a PDF is a manilla folder, and nothing
 * in the document says "folder" anywhere.
 *
 * A photograph is the fallback rather than a case, which covers three states
 * that are one state here: an item with no asset at all, an asset whose record
 * has not arrived, and a mime this build has never heard of. All three are a
 * frame around nothing, which is what a photograph with no bytes already is.
 *
 * ## The exception D-46 did not have (T-339, D-63)
 *
 * "The face is chosen from the asset's mime" was written without exception, and
 * the link card is one. Its asset is the page's picture and a picture is a jpeg,
 * so every reading of the mime says *photograph* — and the object is not a
 * photograph. It is a business card: a thing **about** a page, whose picture is
 * washed into its stock rather than being its subject. What makes it one is a
 * field on the *item*, not a fact about any file, and the exception is written
 * here in the one function that chooses a face rather than happening quietly in
 * a branch of a renderer.
 *
 * ## And why a source is not enough on its own (T-342)
 *
 * A pasted YouTube link came out as a business card, which is the opposite of
 * what T-290 asked for. Both objects are an item with a `source` and a picture,
 * so `source` alone chooses the wrong one half the time — what separates them is
 * what the *page* was:
 *
 * - **A page about itself** — an article, a repository — offers a banner, and a
 *   banner is the card's paper. A business card.
 * - **A page about a film or a recording it would not hand over** — a watch page,
 *   a track page — offers a *still of the thing*, so the picture is the subject
 *   and the object is a photograph with the address written under it. Which is
 *   the default face, and the reason `sourceAbout` marks the card rather than
 *   the still: the still is what an item with a picture already is.
 *
 * **After the three cases and not before them**, which is the other half of the
 * rule and the half a reordering would silently break: *a page that hands over a
 * real file still becomes the file*. An archive.org item is a VHS and a podcast
 * feed is a cassette, and neither stops being one for having come from
 * somewhere.
 *
 * A source with no asset at all is a card too, and deliberately: a page that
 * declared a title and no picture is still a card, printed on blank stock.
 *
 * It takes the record rather than three strings, and that is not tidiness. Three
 * positional arguments of which two are strings is a call that can be got wrong
 * silently — a mistake this board has made before and paid two driven runs for —
 * and the record is what every caller already has in its hand.
 */
function archetypeOf(cold: ItemCold, kind: AssetKind): Archetype {
  if (cold.type !== "polaroid") return "paper";
  switch (kind) {
    case "document":
      return "folder";
    case "video":
      return "vhs";
    case "audio":
      return "cassette";
    default:
      return cold.source && cold.sourceAbout !== "media" ? "card" : "polaroid";
  }
}

/**
 * The polygon a sheet is cut to — **the one answer the paint and the pen
 * share** (T-186).
 *
 * Two callers, in this file, and that is why this exists rather than each of
 * them calling `sheetEdge` with its own arguments. `PaperView.bind` writes it
 * as a `clip-path`; `ItemLayer.walk` asks whether a board point is on the paper
 * inside it. A silhouette computed twice from the same inputs is fine right up
 * until one of the two quantises differently, and then a stroke stops a fifth
 * of a unit from the edge it was drawn against, on the one edge where anybody
 * would see it.
 *
 * The quantisation is the part worth naming. Wear goes to hundredths so that
 * the board's clock ticking rewrites the sheets whose wear actually moved
 * rather than all of them, and the fold's depth to tenths of a percent because
 * that is what `--ear` is written at. Both are the *stylesheet's* roundings and
 * the boundary adopts them — the pen agreeing with what is drawn matters more
 * than the pen being exact about a hand-torn edge.
 */
/**
 * A sheet's silhouette resolved for the size it is currently drawn at, plus
 * everything it was resolved *from* — which is what makes the cache honest
 * rather than a guess at when to drop it.
 */
export interface Silhouette {
  /** Identity, not a copy: the binding replaces the whole record on a change. */
  readonly cold: ItemCold;
  readonly worn: number;
  readonly w: number;
  readonly h: number;
  /** Whether this is the *sheet inside* an open case file rather than the
   *  object's own edge — T-278. A cache key like the four above, and a boolean
   *  rather than the turn's progress on purpose: the paper is the same size all
   *  the way through a fold, and keying on a number that moves every frame would
   *  rebuild the polygon sixty times an open. */
  readonly open: boolean;
  /** `x, y` pairs about the item's centre. */
  readonly points: Float32Array;
  readonly n: number;
}

// `sheetEdgeOf` moved to `render/items/style.ts` with the other four (T-225):
// it resolves a stock, and there is now one place that knows what resolving a
// stock means.

interface View {
  readonly el: HTMLDivElement;
  readonly archetype: Archetype;
  /** `wear` is [0, 1] from `wear.ts` — how worn this item is right now. */
  /**
   * `plain` is the LOD tier, reduced to the one thing a view can act on: below
   * 35% the writing goes down as a text node rather than a box per character
   * (`hand.ts`). Everything else the tier changes is paint, and paint is
   * `items.css` reading `[data-lod]` off the layer's host — one attribute write
   * for the whole board rather than a flag threaded through 500 views.
   *
   * A boolean rather than the `Tier` itself because both views would otherwise
   * write the same `tier !== "full"` and there would be two places to be wrong.
   */
  bind(
    cold: ItemCold,
    facts: AssetFacts,
    assetUrl: AssetResolver,
    screenPx: number,
    wear: number,
    plain: boolean,
  ): void;
  /**
   * `lift` is the scene's carry transient, 0 at rest and 1 while carried.
   *
   * `open` is the other one, and it is the first thing in this layer to read the
   * open state at all (T-319): 0 as the case file hangs, 1 when it is turned up
   * and its cover is folded back. Both are transients of exactly the same kind —
   * eased clocks the scene owns, never written to the document, and cleared when
   * the item goes — so `open` arrives the way `lift` does rather than through a
   * mechanism of its own.
   *
   * Every view is offered it and only the folder answers, which is the bargain
   * `setCurl` already takes: the layer asks the same question of every item and
   * each material answers for itself.
   */
  transform(
    x: number,
    y: number,
    rot: number,
    w: number,
    h: number,
    lift: number,
    open: number,
  ): void;
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
   * Take the deck's audio element in, or give it back — T-277.
   *
   * The same bargain `adopt` above makes, for the same reason and against a
   * worse failure: a field inherited out of the pool is somebody else's caret,
   * and an element inherited out of the pool is somebody else's *recording*,
   * still playing. Answered only by the cassette; there is nothing inside a
   * photograph to hear.
   */
  hold(audio: HTMLAudioElement | null): void;
  /**
   * How much of the tape is on the take-up reel, 0 to 1 — the position, which
   * on a cassette *is* the object (T-268).
   *
   * One custom property; `items.css` turns it into the two pack radii and the
   * span between them. Offered to every view and answered by the cassette, like
   * `setPage` one paragraph below.
   */
  setReeled(reeled: number): void;
  /**
   * How curled each of the four corners is, clockwise from the top left
   * (`curl.ts`). Offered rather than computed here, because the answer is a
   * question about pins and the view has never heard of one.
   */
  setCurl(corners: Float32Array, faces: Float32Array): void;
  /**
   * The page open on this item, or null for an item that is not a case file or
   * is not open (T-320).
   *
   * Offered to every view and answered only by the folder, which is the bargain
   * `setCurl` above already takes — the layer asks the same question of every
   * item and each material answers for itself. A polaroid has no inside.
   */
  setPage(view: PageView | null): void;
  /**
   * Which corners are taped, as `tape.ts`'s mask.
   *
   * Offered on the same pass as the curl and not written at bind, because the
   * answer is not the seed's alone: nothing pinned is taped, and whether an item
   * is pinned changes with no write to that item at all.
   */
  setTape(seed: number, corners: number): void;
  /**
   * Which corner this item is dog-eared at, or `-1` for the three sheets in four
   * that are not (`wear.ts`) — and always `-1` for a photograph, which has no
   * silhouette to fold.
   *
   * Read *back out* of the view rather than asked again beside `setCurl`, on the
   * same argument the tape mask makes one line above about being asked once: a
   * folded corner does not curl, so two answers to "is this corner folded" would
   * be two chances to shade a corner the sheet no longer has. `bind` has already
   * decided this when the curl is offered, and this is that decision.
   */
  readonly folded: number;
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

/**
 * The one or two strips of tape holding an item down — DESIGN section 4.3, and
 * `tape.ts` for which corners get one and why both archetypes can.
 *
 * Both nodes exist for the life of the view and are hidden rather than created,
 * which is the same rule `.pol-film` is built under: a `createElement` on a
 * mount is exactly what the pool exists to avoid, and two thirds of a board have
 * no tape on them at all.
 *
 * Positioned on the corner of the **paper** — `--edge-*`, which the paper view
 * writes and a polaroid leaves at its `0px` fallback, because a print's frame
 * really is a rectangle.
 */
class TapeSet {
  readonly nodes: HTMLDivElement[] = [];
  private readonly strips: HTMLDivElement[] = [];
  /** Each live strip's own angle, needed to take the light back out of it. */
  private readonly angles = new Float32Array(MAX_TAPES);
  private live = 0;
  private litFor = Number.NaN;
  /** What the strips currently on show were dressed for. `-1` is never a seed
   *  and never a mask, so the first offer always lands. */
  private boundSeed = -1;
  private boundMask = -1;

  constructor() {
    for (let i = 0; i < MAX_TAPES; i++) {
      const el = document.createElement("div");
      el.className = "item-tape";
      // Written here rather than in the stylesheet so that the length a hand
      // tears off a roll is stated once, in the module that knows about tape.
      el.style.width = `${TAPE_LENGTH}px`;
      el.style.height = `${TAPE_WIDTH}px`;
      const strip = document.createElement("div");
      strip.className = "tape-strip";
      el.append(strip);
      this.nodes.push(el);
      this.strips.push(strip);
    }
  }

  /**
   * Dress the strips this item has, if they are not the ones it already had.
   *
   * Guarded on both, because this runs on the same pass as the curl — every
   * frame anything on the board moves — and re-tearing the ends off two strips
   * sixty times a second is work for a picture that has not changed.
   */
  bind(seed: number, mask: number): void {
    if (seed === this.boundSeed && mask === this.boundMask) return;
    this.boundSeed = seed;
    this.boundMask = mask;
    let n = 0;
    for (let c = 0; c < CORNER_ANCHOR.length; c++) {
      if ((mask & (1 << c)) === 0) continue;
      const el = this.nodes[n]!;
      const anchor = CORNER_ANCHOR[c]!;
      el.style.left = anchor[0];
      el.style.top = anchor[1];
      const angle = tapeAngle(seed, 1 << c, n);
      this.angles[n] = angle;
      // Centred on the corner, so half the strip is on the item and half is on
      // the cork — which is the only way round that holds anything.
      el.style.transform = `translate(-50%, -50%) rotate(${angle.toFixed(4)}rad)`;
      this.strips[n]!.style.clipPath = tapeClipPath(seed, n);
      el.style.display = "block";
      n++;
    }
    for (let i = n; i < MAX_TAPES; i++) this.nodes[i]!.style.display = "none";
    this.live = n;
    // The strips have moved, so whichever way up they were lying is no longer
    // an answer about these ones.
    this.litFor = Number.NaN;
  }

  /**
   * Turn each strip so that its lit edge faces the light.
   *
   * Out of *two* rotations, not one: a strip is rotated inside an item that is
   * itself rotated, so the light has to come back through both or a taped
   * photograph would be lit from one direction and its tape from another.
   *
   * A mirror rather than an offset copy, because tape is stuck flat and has no
   * cast shadow to give — see [`tapeFlip`], and Phil, who said so.
   */
  update(rot: number): void {
    if (rot === this.litFor) return;
    this.litFor = rot;
    for (let i = 0; i < this.live; i++) {
      const flip = tapeFlip(rot + this.angles[i]!, LIGHT_DX, LIGHT_DY);
      this.strips[i]!.style.transform = flip < 0 ? "scaleY(-1)" : "";
    }
  }

  release(): void {
    for (const el of this.nodes) el.style.display = "none";
    this.live = 0;
    this.litFor = Number.NaN;
    this.boundSeed = -1;
    this.boundMask = -1;
  }
}

/**
 * Where each corner is, as a pair of CSS lengths — the paper's corner where the
 * silhouette moved it and the box's where nothing did.
 */
const CORNER_ANCHOR: readonly (readonly [string, string])[] = [
  ["var(--edge-tl-x, 0px)", "var(--edge-tl-y, 0px)"],
  ["calc(100% - var(--edge-tr-x, 0px))", "var(--edge-tr-y, 0px)"],
  ["calc(100% - var(--edge-br-x, 0px))", "calc(100% - var(--edge-br-y, 0px))"],
  ["var(--edge-bl-x, 0px)", "calc(100% - var(--edge-bl-y, 0px))"],
];

/**
 * Take this frame's curl — shared by every view whose material bends.
 *
 * Quantised to twentieths, and that is the same decision `--develop` took for
 * the same reason: this is offered on every frame anything on the board moves,
 * and a raw float would rewrite four custom properties per sheet per frame of
 * every drag and every swing. A twentieth of the way through a shading this
 * subtle is well under what the eye resolves.
 *
 * `written` is the caller's own record of what it last wrote, eight slots long —
 * four curls and four faces. It is passed in rather than kept here because the
 * whole point is that it is *per view*, and it is the reason this is a function
 * and not eight property writes a frame.
 */
function writeCurl(
  el: HTMLDivElement,
  corners: Float32Array,
  faces: Float32Array,
  written: Float32Array,
): void {
  const n = CURL_PROPS.length;
  for (let c = 0; c < n; c++) {
    const curl = Math.round((corners[c] ?? 0) * 20) / 20;
    if (curl !== written[c]) {
      written[c] = curl;
      el.style.setProperty(CURL_PROPS[c]!, curl.toFixed(2));
    }
    const face = Math.round((faces[c] ?? 0) * 20) / 20;
    if (face === written[n + c]) continue;
    written[n + c] = face;
    el.style.setProperty(FACE_PROPS[c]!, face.toFixed(2));
  }
}

/**
 * The one light, in an item's **own** frame, as two numbers (T-313).
 *
 * ## Why the case objects need this and paper does not
 *
 * A folder's kraft is drawn with CSS gradients — two handling creases, a cut
 * edge along the front panel, a wash down the board — and every one of them is
 * declared in the element's frame, so all of them turn with the object. Phil
 * turned a folder upside down and its creases were lit from below: DESIGN 4.1's
 * "one element lit from the wrong side", which it says breaks the sense of a
 * real surface faster than anything else on the board.
 *
 * Paper already solves this twice. `wear.ts`'s `creaseFace` hands the stylesheet
 * a signed number per fold and `curl.ts`'s `cornerFace` one per corner, and in
 * both the light is counter-rotated *into the sheet's frame* rather than the
 * feature being rotated out of it — one rotation instead of four.
 *
 * ## Why two numbers rather than one per feature
 *
 * The case objects have eighteen directional gradients between the three of
 * them, at eight different angles. A signed number per feature would mean this
 * function knowing every angle in the stylesheet, which is the wrong place for
 * it to be written down twice.
 *
 * So it publishes the light itself and the stylesheet takes its own dot product.
 * A crease at `a` degrees has normal `(sin a, -cos a)` — CSS measures a gradient
 * clockwise from *to top*, which is not a maths angle, and `creaseFace` records
 * what reading it as one costs — so how lit its far flank is comes out as
 * `calc(-1 * (SIN * var(--lx) + -COS * var(--ly)))` with the two constants
 * written literally beside the gradient they belong to. An axis-locked profile
 * is the same expression with the trivial normal: `to bottom` is `var(--ly)`.
 *
 * Negative alphas clamp to zero rather than invalidating the declaration —
 * checked in this webview before `curl.ts` relied on it — so one layer painted
 * at `+k` and one at `-k` is a shine on whichever side faces the light and a
 * shade on the other, off the one number.
 *
 * ## And `--turn`, which is the other half
 *
 * A broad wash across a face is not a feature of the object at all, it is the
 * light falling on it, and the right answer for one of those is to counter-rotate
 * the gradient's own angle so it stays in board space: `calc(166deg +
 * var(--turn))`. A crease may not be treated that way — rotating its angle
 * slides the fold across the object — which is why both exist.
 *
 * Quantised, on `writeCurl`'s argument: this is offered on every frame anything
 * moves, and a hundredth of a unit vector is far under what a gradient shows.
 */
function writeLight(el: HTMLDivElement, rot: number, written: Float32Array): void {
  const light = counterRotate(LIGHT_DX, LIGHT_DY, rot);
  const lx = round(light.x, 100);
  const ly = round(light.y, 100);
  // One tenth of a degree, which at the far corner of the largest case object is
  // about a third of a board unit of gradient travel.
  const turn = round((-rot * 180) / Math.PI, 10);
  if (lx !== written[0]) {
    written[0] = lx;
    el.style.setProperty("--lx", lx.toFixed(2));
  }
  if (ly !== written[1]) {
    written[1] = ly;
    el.style.setProperty("--ly", ly.toFixed(2));
  }
  if (turn === written[2]) return;
  written[2] = turn;
  el.style.setProperty("--turn", `${turn.toFixed(1)}deg`);
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
  /** Asked once per photograph that lands — see [`FirstSight`] and `arrive`. */
  private readonly firstSight: FirstSight;
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
  /** Whether the caption was last written plainly — see `bind`. */
  private boundPlain = false;
  /**
   * The longest edge this item is being drawn at, in device pixels — the last
   * thing `bind` was told. Held because the decision it feeds ([`arrive`]) is
   * taken in a `load` handler, some way after the bind that knew the number.
   */
  private screenPx = 0;
  /**
   * How far the wash has been raised, in whole percent.
   *
   * Whole percent because that is the resolution the eye gets out of a wash
   * across a two-inch photograph, and because a transfer is one callback per
   * chunk: a raw fraction would rewrite a custom property on every chunk, and
   * on every frame of a drag that happens to be in progress at the time.
   */
  private boundDevelop = -1;

  /**
   * The wear last written, in hundredths. Negative so the first bind always
   * writes one — and quantised for the same reason `--develop` is, since this
   * feeds a filter on a node with a photograph in it.
   */
  private boundWear = -1;

  private readonly shadow = new ShadowNode();
  private readonly tape = new TapeSet();
  private readonly frame: HTMLDivElement;
  private readonly film: HTMLDivElement;
  private readonly age: HTMLDivElement;
  /**
   * Never. A print is card and emulsion and it creases rather than folds, and
   * DESIGN 4.7 gives a photograph the other mechanism entirely — it ages by
   * losing its dyes (`wearFilter`), not by having things done to its shape.
   */
  readonly folded = -1;
  readonly ink: ItemInk;

  constructor(firstSight: FirstSight) {
    this.firstSight = firstSight;
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
    this.photo.addEventListener("error", () => {
      this.wait();
      this.el.classList.add("is-torn");
    });
    // And this is the only thing that may take the film off. Not the phase:
    // `ready` means the bytes are on the disk, and there is a decode between
    // that and pixels in this window.
    this.photo.addEventListener("load", () => this.arrive());
    // The print has finished coming up, so the emulsion under it can go. It is
    // hidden behind an opaque photograph by now either way, so this is hygiene
    // rather than the last frame of the effect — which is what lets the class
    // survive an `animationend` that never comes.
    this.photo.addEventListener("animationend", () => this.el.classList.remove(IS_EMERGING));

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

    // What the light has taken out of the print, over the gloss because it is
    // in the emulsion rather than on the surface above it (`wear.ts`). The
    // *global* half of a photograph's ageing is the frame's filter and not this
    // — a fade painted on would lift the blacks to brown.
    this.age = document.createElement("div");
    this.age.className = "pol-age";

    this.caption = document.createElement("div");
    this.caption.className = "pol-caption";

    window_.append(this.photo, this.film, gloss, this.age);
    this.frame.append(window_, this.caption);
    // Tape last, because it is stuck over the front of the print.
    this.el.append(this.shadow.el, this.frame, ...this.tape.nodes);
  }

  bind(
    cold: ItemCold,
    _facts: AssetFacts,
    assetUrl: AssetResolver,
    screenPx: number,
    wear: number,
    plain: boolean,
  ): void {
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
    // Ahead of the guard below, not after it. A zoom changes this without
    // changing anything the guard compares, so a bind that correctly decides it
    // has no work to do is exactly the bind that leaves this stale.
    this.screenPx = screenPx;
    const asset = cold.assetId ? assetUrl(cold.assetId, screenPx) : NO_ASSET;
    const develop = Math.round(asset.fraction * 100);
    const sameFilm = asset.phase === this.boundPhase && develop === this.boundDevelop;
    // The fourth input, and the slowest by a wide margin: a photograph fades
    // over months. It is in the guard anyway because it is not *constant* — the
    // board clock ticks over while a window is open, and a bind that ignored it
    // would leave every mounted item at the age it was mounted at.
    const worn = Math.round(wear * 100);
    const sameWear = worn === this.boundWear;
    // The fifth input (T-198). Like the asset it changes with no document write
    // at all — a zoom crossing 35% — so it has to be *in* the guard: `writeHand`
    // guards internally on what it wrote, but a bind that returns here never
    // reaches it, and the caption would keep its lean below the boundary.
    const samePlain = plain === this.boundPlain;
    if (this.boundCold === cold && asset.url === this.boundAsset && sameFilm && sameWear && samePlain) {
      return;
    }
    this.boundPlain = plain;
    if (!sameWear) {
      this.boundWear = worn;
      this.paintAge(worn / 100);
    }
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
    // Guarded inside, which matters more here than anywhere: the two lines
    // above are why this bind runs on every frame of a develop, and the caption
    // has not changed on any of them.
    writeHand(this.caption, cold.text, cold.seed, plain);
    this.caption.classList.toggle("is-empty", cold.text.length === 0);
    // What is written decides how big it is written (T-338), so this cannot wait
    // for a resize — a caption typed into, or an item whose text arrived from a
    // peer, changes the answer with the width standing still.
    if (this.framedFor > 0) this.sizeCaption(this.framedFor);
    // Inline, so `items.css` cannot reach it — see the same four lines in
    // `PaperView.bind`.
    this.el.style.filter = plain ? "none" : tintOf(cold);
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
  /**
   * Put the film back on.
   *
   * The one way to do that, because waiting and emerging are mutually exclusive
   * and only one of them is written by a bind. A photograph that goes back to
   * blank film — a rebind onto an item whose bytes are not here, a decode that
   * failed — must abandon whatever develop was in flight, and letting the two
   * classes overlap would leave the emulsion showing through a photograph the
   * animation had already faded up.
   */
  private wait(): void {
    this.el.classList.remove(IS_EMERGING);
    this.el.classList.add("is-waiting");
  }

  /**
   * The decode has landed: take the film off, and bring the print up through it
   * if this is the first time this item's photograph has been on the screen.
   *
   * The develop is not conditional on having *just* been waiting, which would be
   * the obvious test and is the wrong one twice over. It says yes to a remount —
   * a culled item comes back, is dressed as waiting, and its cached `<img>`
   * fires `load` a task later — and it would say no to nothing, since a variant
   * swap keeps the old picture up and never sets the class at all. What actually
   * distinguishes a develop is whether there has ever been a photograph here,
   * and that is a question only [`FirstSight`] can answer.
   *
   * The size floor is [`EMERGE_MIN_PX`], and the first sight is spent whether or
   * not it is cleared. Spending it is the point: a photograph that arrived while
   * the board was zoomed out to a wall of stamps has been seen, and having it
   * come up later — on the pan that brings it back at a readable size — would be
   * a board that develops things at random long after they got there.
   */
  private arrive(): void {
    this.el.classList.remove("is-waiting");
    const cold = this.boundCold;
    if (cold === null) return;
    const first = this.firstSight(cold.id);
    if (!first || this.screenPx < EMERGE_MIN_PX) return;
    // Written here rather than in `bind`, so a photograph being dragged around
    // does not rewrite a property that matters for one second of its life.
    this.el.style.setProperty("--emerge-delay", `${emergeDelay(cold.seed)}ms`);
    this.el.classList.add(IS_EMERGING);
  }

  private paintFilm(phase: AssetPhase, develop: number): void {
    this.el.classList.remove(...FILM_CLASSES);
    const film = filmClass(phase);
    if (film) this.el.classList.add(film);
    if (phase !== "ready") this.wait();
    // Only while it means something. Left set, a photograph that arrived would
    // keep a stale wash height for the next item this node is recycled onto.
    if (phase === "transferring") this.el.style.setProperty("--develop", `${develop}%`);
    else this.el.style.removeProperty("--develop");
  }

  /**
   * What the years have taken off this print — DESIGN section 4.7's "faint
   * fading on photographs".
   *
   * The filter goes on the **frame** and not on the item root, so that the one
   * declaration covers the picture, the white card around it and the caption
   * written on that card — which is the whole object that fades — and reaches
   * neither the item's cast shadow nor its tape. Fading a shadow would be ageing
   * the light rather than the photograph, and the tape has a look of its own that
   * this task did not measure.
   */
  private paintAge(wear: number): void {
    this.el.classList.toggle(IS_AGED, wear > 0);
    if (wear > 0) this.el.style.setProperty("--age", wear.toFixed(2));
    else this.el.style.removeProperty("--age");
    this.frame.style.filter = wearFilter(wear);
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
   *
   * That path never develops, which falls out of it rather than being arranged:
   * the photograph is already up, so nothing here says it is waiting, and
   * `firstSight` was spent on the first variant. A zoom that crossed a variant
   * boundary is not an arrival, and a photograph that faded up again every time
   * you zoomed past 200% would say it was.
   */
  private swapPhoto(url: string, replacing: boolean): void {
    this.pending = url;
    if (!url) {
      // An empty src would trigger a network request for the page itself.
      this.photo.removeAttribute("src");
      this.wait();
      return;
    }
    if (!replacing) {
      this.photo.src = url;
      this.wait();
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

  transform(x: number, y: number, rot: number, w: number, h: number, lift: number, _open: number): void {
    if (w !== this.framedFor) {
      this.framedFor = w;
      const side = w * FRAME_SIDE;
      const bottom = w * FRAME_BOTTOM;
      this.frame.style.padding = `${side.toFixed(1)}px ${side.toFixed(1)}px ${bottom.toFixed(1)}px`;
      // The caption's *box*, for the reason set out above `CAPTION_BOTTOM`: it
      // sits in the bottom band, the band is a fraction of the width, and the
      // stylesheet could only have said so as a percentage of the height
      // (T-216). Written here rather than declared there, beside the padding it
      // has to stay inside.
      this.caption.style.bottom = `${(w * CAPTION_BOTTOM).toFixed(1)}px`;
      this.caption.style.height = `${(w * CAPTION_HEIGHT).toFixed(1)}px`;
      this.sizeCaption(w);
    }
    writeTransform(this.el, x, y, rot, w, h, lift);
    // Elevation before the offset: swapping sprites invalidates the written
    // rotation, so doing it the other way round leaves the new sprite wearing
    // the old sprite's offset for a frame and the shadow jumps sideways.
    setCarried(this.el, this.shadow, lift);
    this.shadow.update(rot);
    this.tape.update(rot);
  }

  /**
   * A polaroid does not curl.
   *
   * DESIGN 4.4 puts the curl under notes, cards and scraps, and that is a fact
   * about the object rather than an omission: a print is card stock inside a
   * frame, and the reason a photograph on a real board bends at the corner is
   * that somebody bent it. The pins hold this one exactly as much either way.
   */
  /** Nothing to open. See the interface — every view is offered this and each
   *  one answers for its own material. */
  setPage(): void {}

  setCurl(): void {}

  setTape(seed: number, corners: number): void {
    this.tape.bind(seed, corners);
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
    this.sizeField(field);
    this.frame.append(field);
  }

  /** There is nothing inside a photograph to hear — T-277. */
  hold(_audio: HTMLAudioElement | null): void {}

  setReeled(_reeled: number): void {}

  /**
   * How big the caption is written — **which depends on what it says** (T-338).
   *
   * The other captions on this board may be shortened; this one may not. A
   * printed still exists *because* the film could not be brought onto the board,
   * so the address written under it is the whole of what it owes anybody, and
   * `https://www.youtube.com/watch?v=dQw4w9WgXcQ` ellipsised after the host has
   * lost the only part that identifies anything. Phil's rule, and the right way
   * round: do not grow the object to fit the writing, shrink the writing to fit
   * the object.
   *
   * So the size is a function of the text and not of the width alone, which is
   * why this is called from `bind` as well — a caption somebody types into is a
   * caption whose size may have to change, and `transform` never sees that.
   * `fitWriting` does the arithmetic and says why it is a search rather than a
   * formula.
   *
   * **The nine-pixel floor that used to sit under this is gone**, and removing
   * it is part of the fix rather than tidying beside it. It was an absolute
   * length in a file where "a length is a board unit" — the rule the selection
   * outline was moved out of `items.css` for — so it meant one thing at 20% zoom
   * and another at 400%. Worse, it could *override the fit*: on a narrow print
   * the arithmetic would answer 8.3 and this would write 9, which is the caption
   * not fitting again by way of the code that exists to make it fit.
   * `fitWriting` has a floor of its own and it is the right kind, a proportion
   * of the size the band was cut for.
   */
  private sizeCaption(w: number): void {
    const nominal = w * CAPTION_SIZE;
    const size = fitWriting(
      this.boundCold?.text ?? "",
      // The box `items.css` gives it — 8% in from each side of the frame —
      // and the band `CAPTION_HEIGHT` cuts out of the bottom border.
      w * CAPTION_MEASURE,
      w * CAPTION_HEIGHT,
      HAND_LINE,
      nominal,
    );
    this.caption.style.fontSize = `${size.toFixed(2)}px`;
    // The caption's size and box are written per width rather than declared, so
    // the field has to be told the same numbers or the caption moves and changes
    // size the moment you click into it.
    if (this.field) this.sizeField(this.field);
  }

  /**
   * Give the editor the box the static caption has.
   *
   * Everything about that box is written per item rather than declared — the
   * font size off the width, and since T-216 the height and the offset too —
   * so a field that only copied the stylesheet would sit somewhere else and be
   * a different size, and the caption would jump the moment a caret entered it.
   * One place, called from both the create and the resize.
   */
  private sizeField(field: HTMLElement): void {
    field.style.fontSize = this.caption.style.fontSize;
    field.style.bottom = this.caption.style.bottom;
    field.style.height = this.caption.style.height;
  }

  release(): void {
    clearHand(this.caption);
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
    //
    // A develop in flight goes too, though nothing depends on it doing so here:
    // `boundAsset` was cleared two lines up, so whatever this node is recycled
    // onto is guaranteed a `swapPhoto`, and that path puts the film back on and
    // takes the develop off before anything is drawn. It is swept anyway for the
    // reason the paragraph above gives — a released node is left clean, so
    // nothing downstream has to reason about what it was.
    this.el.style.removeProperty("--develop");
    this.el.style.removeProperty("--emerge-delay");
    // Ageing, on the same argument: `paintAge` only runs when the wear differs
    // from the one last painted, and a node recycled onto a *new* item on an old
    // board would keep the previous item's fade.
    this.boundWear = -1;
    this.el.classList.remove(IS_AGED);
    this.el.style.removeProperty("--age");
    this.frame.style.removeProperty("filter");
    this.tape.release();
    this.boundPhase = null;
    this.boundDevelop = -1;
    this.el.classList.remove("is-lifted", "is-waiting", IS_EMERGING, ...FILM_CLASSES);
    this.shadow.reset();
    // And the ink, for the reason the photograph goes: a pooled node keeps its
    // subtree, so a view recycled onto a different item would sit there wearing
    // the previous item's marks. The bitmap is a cache of strokes that are still
    // in the document, so this costs a re-raster if the item comes back.
    this.ink.release();
  }
}

/**
 * The type on a business card, as a fraction of its width — one number for the
 * block, and `items.css` sets the three lines in `em` off it.
 *
 * Sized from the real object rather than picked. A name on an 85 mm card is set
 * at about 9 or 10 point, which is a shade under a ninth of the card's width;
 * the block's own size is that over the title's 1.9 em, and the company and
 * address lines come out at the 6 and 5 point those lines really are. The whole
 * card is therefore small type on a small object, which is what a business card
 * *is* — you pick one up to read it, and on this board that is the zoom.
 */
export const CARD_TEXT = 0.055;

/**
 * The printed block's side inset, as a fraction of the card — `items.css`'s
 * `.card-type { inset: 14% 9% 12% }`, held here because the fit below is
 * arithmetic and CSS cannot hand a number to arithmetic.
 *
 * `tests/card-title-css.test.ts` asserts the two agree, the arrangement
 * `HAND_LINE` and `A4_UNITS` already have with the stylesheet.
 */
export const CARD_TYPE_INSET = 0.09;

/** The title's size, in `em` of the block — `items.css`'s `.card-title`. */
export const CARD_TITLE_EM = 1.9;

/**
 * How wide the printed block is in `em` of its own type, which is the measure a
 * host has to fit inside.
 *
 * A ratio of two ratios, and therefore a constant: the block's font size is a
 * fraction of the card's width and its box is another fraction of the same
 * width, so the card's own size cancels. That is why the title can be fitted
 * once when it is bound rather than again every time the item is resized.
 */
const CARD_TYPE_MEASURE = (1 - 2 * CARD_TYPE_INSET) / CARD_TEXT;

/**
 * A link card: the page's picture washed into the stock, with the title, the
 * site and the address embossed over it (T-339).
 *
 * ## Why it is not a polaroid with different CSS
 *
 * It is a different object, and the difference is what the picture is *for*. A
 * polaroid's photograph is its subject: it sits in a window, square, with a
 * caption written under it in somebody's hand. A card's picture is its **paper**
 * — washed back until it is a colour and a suggestion rather than a thing you
 * look at — and what is written on it is *printed*, in three lines that a
 * business card has always had. Sharing a class would mean a window that
 * sometimes is not one and a caption that is sometimes three typeset lines,
 * which is two objects wearing one name.
 *
 * The wash is why this reads at all, and it is **opacity over the stock rather
 * than a filter**, which is a decision with two reasons behind it. The first is
 * that it makes legibility arithmetic instead of taste: at `--card-wash` over
 * cream card, every possible banner — a black photograph, a saturated brand
 * red, a white page — lands inside a known lightness band, so embossed ink
 * reads over all of them and it can be *checked* rather than eyeballed on
 * whichever page happened to be pasted. Opacity scales chroma by the same
 * factor, so the desaturation comes free from the same declaration. The second
 * is that a `filter` anywhere inside an item rasterises the whole item in a
 * print — `.item` is a stacking context — and a board of link cards printing as
 * bitmaps is a price nobody agreed to for a saturation curve.
 *
 * ## No film, and that is the same argument the tape makes
 *
 * A photograph with no bytes is an item with nothing in it, so it draws five
 * states and owes the person an account of each. A card with no picture is a
 * card: the title, the site and the address are all written on it, all legible,
 * and all facts this machine holds without a byte of the banner. So a missing
 * banner is blank stock and nothing else — which is also, for free, exactly what
 * a page that declared a title and no picture should look like.
 */
class CardView implements View {
  readonly archetype = "card" as const;
  readonly el: HTMLDivElement;
  readonly ink: ItemInk;
  /** A card is stiff and this one has no torn silhouette to fold — see
   *  [`setCurl`] for the part of that which is a real question. */
  readonly folded = -1;

  private readonly shadow = new ShadowNode();
  private readonly tape = new TapeSet();
  private readonly body: HTMLDivElement;
  private readonly shot: HTMLImageElement;
  private readonly grain: HTMLDivElement;
  private readonly type: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly site: HTMLDivElement;
  private readonly address: HTMLDivElement;
  /** The three printed lines, which are what ages by losing — `CaseView.ages`
   *  says why the stock is not in here. */
  private readonly ages: readonly HTMLElement[];

  private boundCold: ItemCold | null = null;
  /** The banner's URL, or `""`. The url and not the hash, for the reason
   *  `CaseView`'s digest gives: the hash is known long before the bytes are. */
  private boundShot: string | null = null;
  /** What `swapShot` is trying to show — see `PolaroidView.swapPhoto`. */
  private pending: string | null = null;
  private boundWear = -1;
  /** The width the type and the relief were written for. */
  private sizedFor = -1;
  private field: HTMLTextAreaElement | null = null;
  private readonly writtenLight = new Float32Array(3).fill(-9);

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "item item-card";
    this.ink = new ItemInk(this.el);

    // The card itself. Its own box inside the item, like `.pol-frame`, so the
    // shadow can hang outside the stock without the stock's `overflow: hidden`
    // — which the wash needs — cutting it off at the corner.
    this.body = div("card-body");

    this.shot = document.createElement("img");
    this.shot.className = "card-shot";
    this.shot.decoding = "async";
    this.shot.draggable = false;
    // Empty, and for a stronger reason than the tape's still. This picture has
    // been washed back to about a third of its contrast: it is stock, not
    // content, and the three lines over it already say everything the card says.
    this.shot.alt = "";
    // A banner that will not decode is a card with no banner, which is a state
    // this object already draws and does not need telling about. Nothing torn:
    // see the class comment.
    this.shot.addEventListener("error", () => this.clearShot());

    // The fibre in the stock, over the wash because it is the surface of the
    // card and the picture is *in* it. Same shared tile and same per-item offset
    // as a folder's kraft, so a wall of cards is not one texture repeated.
    this.grain = div("card-grain");
    this.grain.style.backgroundImage = `url(${paperGrainUrl("cream")})`;

    this.type = div("card-type");
    this.title = div("card-title");
    this.site = div("card-site");
    this.address = div("card-address");
    this.ages = [this.title, this.site, this.address];
    this.type.append(this.title, this.site, this.address);

    this.body.append(this.shot, this.grain, div("card-age"), this.type);
    // Tape last, over the card, where a strip put on afterwards would be.
    this.el.append(this.shadow.el, this.body, ...this.tape.nodes);
  }

  bind(
    cold: ItemCold,
    _facts: AssetFacts,
    assetUrl: AssetResolver,
    screenPx: number,
    wear: number,
    _plain: boolean,
  ): void {
    // `plain` is ignored, and that is the whole of this face's relationship with
    // the LOD tier. It means "put the writing down as a text node rather than a
    // box per character" (`hand.ts`), and these three lines were never in a hand
    // to begin with — a card is printed. Everything else the tier changes is
    // paint, off `[data-lod]` on the host.
    const asset = cold.assetId ? assetUrl(cold.assetId, screenPx) : NO_ASSET;
    const worn = Math.round(wear * 100);
    const sameWear = worn === this.boundWear;
    if (this.boundCold === cold && asset.url === this.boundShot && sameWear) return;

    if (!sameWear) {
      this.boundWear = worn;
      this.paintAge(worn / 100);
    }
    this.boundCold = cold;
    if (asset.url !== this.boundShot) {
      const replacing = Boolean(this.boundShot);
      this.boundShot = asset.url;
      this.swapShot(asset.url, replacing);
    }

    // Typed, all three, and never in the hand. A business card is a thing that
    // was *printed*: the one hand-written thing on this board that came from a
    // person is a caption somebody wrote, and none of these is that — the title
    // is the page's own, and the two lines under it are the address it lives at.
    //
    // The fallback is the one piece of arrangement here. A page with no title
    // gives its host the top line rather than leaving a card whose largest type
    // is blank; the company line then has nothing left to say and goes. The item
    // text stays empty either way, which is what makes clicking into an untitled
    // card an invitation to name the thing yourself.
    const source = cold.source ?? "";
    const written = cold.text.trim();
    const site = siteLabel(source);
    this.title.textContent = written || site;
    this.site.textContent = written ? site : "";
    this.address.textContent = addressLabel(source);
    // A host standing in for a title is a *label* and is set as one — one line,
    // written smaller if it has to be, never broken mid-word (T-341). The class
    // is what tells the stylesheet which of the two kinds of string is up there;
    // the size is what keeps the card from growing to fit an address.
    const host = written === "" && site !== "";
    this.title.classList.toggle("is-host", host);
    if (host) {
      this.title.style.fontSize = `${fitHost(site, CARD_TYPE_MEASURE, CARD_TITLE_EM).toFixed(3)}em`;
    } else {
      this.title.style.removeProperty("font-size");
    }
    // So the stylesheet can close the gap a missing line would otherwise leave.
    this.site.classList.toggle("is-empty", this.site.textContent === "");
    this.title.classList.toggle("is-empty", this.title.textContent === "");
    this.grain.style.backgroundPosition = grainPosition(cold.seed);
  }

  /**
   * What the years take off a card — the printing, and nothing else.
   *
   * The same split `CaseView.paintAge` measured and recorded: what ages by
   * *gaining* is the stock, which takes its years as a background layer in
   * `items.css`, and what ages by *losing* is the ink. Putting the filter on the
   * body instead would reach the banner, and fading a page's brand colour is
   * ageing the website rather than the card somebody was handed.
   */
  private paintAge(wear: number): void {
    this.el.classList.toggle(IS_AGED, wear > 0);
    if (wear > 0) this.el.style.setProperty("--age", wear.toFixed(2));
    else this.el.style.removeProperty("--age");
    const filter = wearFilter(wear);
    for (const el of this.ages) el.style.filter = filter;
    // The field stands in for the title, which is in `ages`, so it takes the
    // same age — or the writing lifts out of its own years while you type.
    if (this.field) this.field.style.filter = filter;
  }

  /**
   * Point the banner at `url`, or take it away.
   *
   * The decode-then-swap of `PolaroidView.swapPhoto`, for the same reason and
   * against a smaller stake: assigning `src` blanks the picture until the new
   * bytes decode, and on a card that is the stock flashing back to cream. The
   * `pending` guard is what stops an in-flight decode landing on whatever item
   * this pooled node has been recycled onto since.
   */
  private swapShot(url: string, replacing: boolean): void {
    this.pending = url;
    if (!url) {
      this.clearShot();
      return;
    }
    if (!replacing) {
      this.shot.src = url;
      this.body.classList.remove("is-blank");
      return;
    }
    const next = new Image();
    next.decoding = "async";
    next.src = url;
    const apply = (): void => {
      if (this.pending !== url) return;
      this.shot.src = url;
      this.body.classList.remove("is-blank");
    };
    void next.decode().then(apply, apply);
  }

  /** Blank stock. An empty `src` would fetch the page itself. */
  private clearShot(): void {
    if (this.shot.getAttribute("src") !== null) this.shot.removeAttribute("src");
    this.body.classList.add("is-blank");
  }

  transform(x: number, y: number, rot: number, w: number, h: number, lift: number, _open: number): void {
    if (w !== this.sizedFor) {
      this.sizedFor = w;
      // One size on the block and three `em` multiples in the stylesheet, so a
      // card somebody has resized keeps its typography rather than three numbers
      // drifting apart. The floor is a card drawn at a wall-of-cards zoom, where
      // the lines are a texture and a sub-pixel size costs a layout for nothing.
      // One number, and it sizes the whole card: the three lines are `em` of it
      // and so is the relief they are embossed at (`--relief` in `items.css`).
      // That is not how the relief started — it was written from here as a
      // length in board units, which gave the smallest line five times the
      // relief for its size that the title had, and a close-up showed it as a
      // halo rather than as raised type. A raised letter's relief belongs to the
      // letter.
      this.type.style.fontSize = `${Math.max(3, w * CARD_TEXT).toFixed(2)}px`;
      // The editor's field needs nothing here, unlike a polaroid's — it wears
      // `.card-title`, whose size is `1.9em` of the block this line just wrote,
      // so it follows a resize for free. Writing an inline size onto it would
      // *beat* that rule and set the caret's line at the block's size, which is
      // the title at about half the type it is printed at.
    }
    writeTransform(this.el, x, y, rot, w, h, lift);
    setCarried(this.el, this.shadow, lift);
    this.shadow.update(rot);
    this.tape.update(rot);
    // The emboss is the only lit thing on this object, and it is lit by the same
    // one light as everything else — so the light has to be counter-rotated into
    // this card's own frame, exactly as the case objects' creases are (T-313).
    // Without it a card scattered at 40 degrees has its writing raised toward
    // its own private sun, which DESIGN 4.1 calls the fastest way to break a
    // surface.
    writeLight(this.el, rot, this.writtenLight);
  }

  /**
   * Not built, and it is a question rather than an omission.
   *
   * DESIGN 4.4 puts the curl under "notes, cards and scraps", and a business
   * card is thin board that really does lift at a corner. What stops it here is
   * that `curl.ts`'s shading is drawn against a *sheet's silhouette* — the torn
   * outline `PaperView` cuts and this object does not have — so giving a card a
   * curl means deciding what its edge is first, which is a bigger question than
   * this face. Refusing it costs the same as the polaroid's refusal: the pins
   * hold it exactly as much either way.
   */
  setCurl(): void {}

  /** Nothing inside. See the interface — every view is offered these and each
   *  answers for its own material. */
  setPage(): void {}

  hold(_audio: HTMLAudioElement | null): void {}

  setReeled(_reeled: number): void {}

  setTape(seed: number, corners: number): void {
    this.tape.bind(seed, corners);
  }

  /**
   * The caret goes on the **title**, which is the one line of the three that is
   * anybody's to change.
   *
   * The site and the address are read off `source`, and `source` is not text —
   * it is the field Q-305 created precisely so that rewriting the words on an
   * object could not destroy the way back to the page. So there is nothing to
   * put a caret in there, and the line a person can edit is the name they would
   * write on a card they were given.
   */
  adopt(field: HTMLTextAreaElement | null): void {
    if (field === null) {
      this.el.classList.remove("is-editing");
      this.field?.remove();
      this.field = null;
      return;
    }
    this.el.classList.add("is-editing");
    // Idempotent — re-appending a focused node blurs it, and that blur is what
    // closes the editor.
    if (this.field === field && field.parentNode === this.type) return;
    this.field = field;
    field.className = "item-field card-title";
    field.style.filter = wearFilter(this.boundWear > 0 ? this.boundWear / 100 : 0);
    // First, where the static title is, so the two other lines stay under it.
    this.type.prepend(field);
  }

  release(): void {
    this.boundCold = null;
    this.adopt(null);
    // The banner goes, and the in-flight decode with it: a pooled node keeps its
    // subtree, so a card recycled onto another item would wear the last one's
    // page until its own bytes resolved.
    this.boundShot = null;
    this.pending = null;
    this.clearShot();
    this.title.textContent = "";
    this.site.textContent = "";
    this.address.textContent = "";
    // Ageing, on the same argument `PolaroidView.release` gives: `paintAge` only
    // runs when the wear moved, so a node recycled onto a new item on an old
    // board would otherwise keep the previous card's fade.
    this.boundWear = -1;
    this.el.classList.remove(IS_AGED, "is-lifted");
    this.el.style.removeProperty("--age");
    for (const el of this.ages) el.style.removeProperty("filter");
    this.tape.release();
    this.shadow.reset();
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

/**
 * How `data-ear` spells each corner, in `edge.ts` and `curl.ts`'s clockwise
 * order. An attribute rather than four more custom properties, because which
 * corner is folded selects a whole block of `items.css` — where the flap sits and
 * which way its triangle points — and none of that is arithmetic.
 */
const EAR_CORNERS = ["tl", "tr", "br", "bl"] as const;

class PaperView implements View {
  readonly archetype = "paper" as const;
  readonly el: HTMLDivElement;
  private readonly shadow = new ShadowNode();
  private readonly tape = new TapeSet();
  private readonly surface: HTMLDivElement;
  private readonly grain: HTMLDivElement;
  private readonly tear: HTMLDivElement;
  private readonly bend: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly age: HTMLDivElement;
  private readonly worn: HTMLDivElement;
  private readonly ear: HTMLDivElement;
  private boundCold: ItemCold | null = null;
  /** The wear last written, in hundredths. Negative so the first bind writes. */
  private boundWear = -1;
  /** Which corner is folded, or -1 — the `View` contract, written by `paintAge`. */
  folded = -1;
  /**
   * How far the fold reaches, as a percentage of the sheet, and how far it
   * reached when the silhouette was last written.
   *
   * The fold is the one thing in the path that is **not** a function of the cold
   * item, so the guard in `bind` cannot be the cold identity alone. Quantised to
   * tenths, which is what the path is written to anyway — so a sheet turning its
   * corner over rewrites the polygon a couple of dozen times across the fortnight
   * of board time it takes, and not once more.
   */
  private earDepth = 0;
  private boundEar = -1;
  /** Whether the writing was last laid down plainly — see `bind`. */
  private boundPlain = false;
  /**
   * The angle of this sheet's crease, in degrees and in its own frame, or NaN
   * when it has none.
   *
   * Held because the *lighting* of a crease is a question about the board and
   * the answer changes when the sheet turns, which is a `transform` and not a
   * bind — the same shape as `facedRot` below, and for the same reason.
   */
  private creaseRot = Number.NaN;
  /** The rotation `--crease-face` was last written for. */
  private facedRot = Number.NaN;
  /** The editor's field while this item is the one being written on (T-179). */
  private field: HTMLTextAreaElement | null = null;
  /**
   * The curl last written, per corner, quantised — see [`setCurl`]. Negative so
   * the first offer always writes, whatever it is.
   */
  private readonly written = new Float32Array(CURL_PROPS.length + FACE_PROPS.length).fill(-9);
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

    // The pulp along a torn head. Always in the tree and shown only when the
    // stock says this sheet came off a pad, for the reason `.pol-film` is: a
    // node created on demand is a `createElement` on a mount, and the pool
    // exists so a mount is a few attribute writes.
    this.tear = document.createElement("div");
    this.tear.className = "paper-tear";

    this.body = document.createElement("div");
    this.body.className = "paper-text";

    // The bend in a curling corner, and the shadow it throws: on the sheet, so
    // the ragged silhouette clips both, and over the writing, because a sheet
    // that bends bends what is written on it too. There was a second, unclipped
    // layer for the shadow and `items.css` says at length why there is not one
    // now — the short of it is that its own boundary became the visible edge.
    this.bend = document.createElement("div");
    this.bend.className = "paper-bend";

    // The sheet going brown, and the marks on it. Both always in the tree and
    // both painting nothing until `is-aged` — the same bargain `.paper-tear` and
    // `.pol-film` take, because a node created on demand is a `createElement` on
    // a mount and the pool exists so that a mount is a few attribute writes.
    this.age = document.createElement("div");
    this.age.className = "paper-age";
    this.worn = document.createElement("div");
    this.worn.className = "paper-worn";

    // The flap of a dog-eared corner: the back of the sheet, lying on the front
    // of it. Always in the tree and zero-sized until this sheet has a fold, which
    // is the same bargain `.paper-tear` and the two wear layers take — a node
    // created on demand is a `createElement` on a mount.
    this.ear = document.createElement("div");
    this.ear.className = "paper-ear";

    // Above the ruling, which a tear destroys, and below the writing, which sits
    // on the paper whatever the paper has been through.
    //
    // The two wear layers straddle the writing, and which side each is on is the
    // physics (`wear.ts`). Yellowing is the sheet going brown, so it is under the
    // ink and over the torn lip — fresh pulp is the most exposed thing on an old
    // sheet, not the least. A crease and a coffee ring are things that happened
    // *to* the sheet after somebody wrote on it, so they go over the top, beside
    // the bend, which is over the writing for the same reason.
    // The fold goes last of the surface's children, over the yellowing, the
    // writing, the bend and the marks alike: a corner turned over covers whatever
    // the sheet had on it, which is most of what makes it read as a fold rather
    // than as a shape drawn on the paper. Only the tape is above it, and the tape
    // is not on the surface at all.
    this.surface.append(
      this.grain,
      this.tear,
      this.age,
      this.body,
      this.bend,
      this.worn,
      this.ear,
    );
    // Tape last, because it is stuck over the front of the sheet — and over the
    // curl, since a taped corner is a corner that is not lifting.
    this.el.append(this.shadow.el, this.surface, ...this.tape.nodes);
  }

  bind(
    cold: ItemCold,
    _facts: AssetFacts,
    _assetUrl: AssetResolver,
    _screenPx: number,
    wear: number,
    plain: boolean,
  ): void {
    // Quantised to hundredths, so the clock ticking is a rewrite of six custom
    // properties on the sheets whose wear actually moved rather than on every
    // sheet on the board.
    const worn = Math.round(wear * 100);
    if (worn !== this.boundWear) {
      this.boundWear = worn;
      this.paintAge(cold.seed, worn / 100);
    }
    // `plain` is in the guard for the reason it is in the polaroid's: a zoom
    // across 35% changes it without changing anything the document says, and a
    // bind that returns here never reaches `writeHand`.
    //
    // And the fold is in it because the silhouette is no longer the seed's alone
    // (T-190): a corner turning over changes the polygon while the item's cold
    // record does not change at all, so the cold identity on its own would leave
    // the sheet wearing the shape it had before it was ever folded.
    const ear = Math.round(this.earDepth * 10);
    if (this.boundCold === cold && plain === this.boundPlain && ear === this.boundEar) return;
    this.boundCold = cold;
    this.boundPlain = plain;
    this.boundEar = ear;
    const stock = stockOf(cold);
    this.el.dataset["stock"] = stock;
    // The silhouette, where its corners are, and where the pulp shows. All of
    // them are the stock's and the seed's, so all of them are written here
    // rather than in `transform` — the percentages in the path carry a resize on
    // its own, and an offset in board units does not change with the sheet.
    //
    // The corners go out as well as the path because the curl is drawn *at* a
    // corner, and the corner of the item's rectangle is not where the paper ends
    // (`edge.ts`). A fold anchored on the box has its highlight clipped away by
    // the very silhouette it is meant to belong to.
    // Asked of the shared function rather than assembled here from `this.folded`
    // and `this.earDepth`, so that what is *cut* and what the pen *stops at* can
    // never be two answers (T-186). It re-derives the fold from the same seed
    // and the same quantised wear `paintAge` just used, so this is the same
    // polygon by construction rather than by two files agreeing to be careful.
    const edge = sheetEdgeOf(cold, worn / 100);
    // Written here rather than left to `items.css` because these four are
    // *inline* styles, and an inline style beats a stylesheet rule (T-198). The
    // LOD block in `items.css` can hide a node it does not otherwise touch, and
    // it cannot un-write a property this line wrote — which is why the flat card
    // is half a stylesheet and half four conditionals, rather than all one or
    // the other. The alternative was `!important` against our own code, which
    // wins the argument by making every future override lose it.
    //
    // The silhouette is the expensive one: a twenty-point polygon per sheet,
    // clipping a subtree, describing a deviation that is under a pixel at 35%.
    this.surface.style.clipPath = plain ? "" : edge.path;
    for (let i = 0; i < EDGE_PROPS.length; i++) {
      this.el.style.setProperty(EDGE_PROPS[i]!, `${(edge.corners[i] ?? 0).toFixed(2)}px`);
    }
    const tear = tornOf(cold);
    if (tear) this.el.dataset["tear"] = tear;
    else delete this.el.dataset["tear"];
    // The stock's own colour stays at every tier: it is the flat paper, and it
    // is what still tells a legal pad from an index card when nothing else can.
    const base = stockBase(stock);
    this.surface.style.background = base;
    // And the same colour again as a property, for the one layer that has to be
    // *opaque* paper rather than a wash over it: the flap of a dog-eared corner
    // shows the back of this sheet, and the back of a legal pad has no rules
    // printed on it. A translucent flap would let the ruling through and the fold
    // would read as a shadow rather than as paper.
    this.el.style.setProperty("--stock-base", base);
    // The ruling does not. Its lines are a third of a device pixel apart at 35%,
    // which is a flat grey wash drawn the most expensive way available.
    this.surface.style.backgroundImage = plain ? "none" : stockRuling(stock);
    // `.paper-grain` is `display: none` at these tiers, so this is only saving
    // the write — but a tile URL on a hidden node is still a property the
    // browser parses on every one of five hundred sheets.
    if (!plain) this.grain.style.backgroundImage = `url(${paperGrainUrl(stock)})`;
    this.grain.style.backgroundPosition = grainPosition(cold.seed);
    // A per-sheet hue-rotate is its own compositing pass, for a tint that is not
    // distinguishable from the cork at this size.
    this.surface.style.filter = plain ? "none" : tintOf(cold);
    /**
     * The face — DESIGN 3.6, resolved by `render/items/style.ts`.
     *
     * A data attribute rather than an inline `font-family`, so `items.css` can
     * hold the family and its size correction together. They are one decision:
     * Source Sans 3 sets 16% wider than the hand, and a family swapped without
     * the size re-wraps the note and takes the writing off the ruling.
     *
     * The clean face is written **plain** whatever the tier. `plain` is the LOD
     * flag everywhere else in this file, and here it carries a second meaning
     * that wants exactly the same code: a print face does not lean, so it needs
     * no box per glyph — and not having one is what lets it kern, which is most
     * of why anybody would choose it. The hand cannot kern at any zoom
     * (`hand.ts`), and that trade is the whole of what this face offers.
     */
    const face = faceOf(cold);
    if (face === "hand") delete this.el.dataset["face"];
    else this.el.dataset["face"] = face;
    writeHand(this.body, cold.text, cold.seed, plain || face === "clean");
  }

  transform(x: number, y: number, rot: number, w: number, h: number, lift: number, _open: number): void {
    writeTransform(this.el, x, y, rot, w, h, lift);
    // Elevation before the offset: swapping sprites invalidates the written
    // rotation, so doing it the other way round leaves the new sprite wearing
    // the old sprite's offset for a frame and the shadow jumps sideways.
    setCarried(this.el, this.shadow, lift);
    this.shadow.update(rot);
    this.tape.update(rot);
    // Which flank of the fold catches the light. Guarded on the rotation on its
    // own — the crease itself is the seed's and never moves in the sheet — and
    // skipped entirely on the sheets that have no crease, which on a young board
    // is all of them.
    if (rot !== this.facedRot && !Number.isNaN(this.creaseRot)) {
      this.facedRot = rot;
      const face = creaseFace(rot, this.creaseRot);
      this.el.style.setProperty("--crease-face", face.toFixed(3));
    }
  }

  /** Nothing to open. See the interface — every view is offered this and each
   *  one answers for its own material. */
  setPage(): void {}

  setCurl(corners: Float32Array, faces: Float32Array): void {
    writeCurl(this.el, corners, faces, this.written);
  }

  /**
   * How old this sheet looks — DESIGN section 4.7's yellowing, creases and
   * occasional coffee rings, all of them `wear.ts`'s numbers.
   *
   * Everything here is written at bind and left alone, because wear moves on the
   * scale of days: a board can be dragged around for an hour without any of
   * these changing at all. The one exception is `--crease-face`, which is a fact
   * about where the light is and therefore belongs to `transform`.
   */
  private paintAge(seed: number, wear: number): void {
    this.el.classList.toggle(IS_AGED, wear > 0);
    if (wear <= 0) {
      for (const prop of WEAR_PROPS) this.el.style.removeProperty(prop);
      delete this.el.dataset["ear"];
      this.folded = -1;
      this.earDepth = 0;
      this.creaseRot = Number.NaN;
      this.facedRot = Number.NaN;
      return;
    }
    this.el.style.setProperty("--age", wear.toFixed(2));

    // The fold, and it is the one mark here that `bind` has to act on rather than
    // hand to the stylesheet: it cuts the silhouette. So this writes the depth
    // and the corner and leaves the polygon to the block below, which is guarded
    // on the depth this line just set.
    const dogEar = dogEarOf(seed, wear);
    this.folded = dogEar.amount > 0 ? dogEar.corner : -1;
    this.earDepth = dogEar.depth;
    if (this.folded < 0) {
      delete this.el.dataset["ear"];
      this.el.style.removeProperty("--ear");
    } else {
      this.el.dataset["ear"] = EAR_CORNERS[this.folded]!;
      this.el.style.setProperty("--ear", `${dogEar.depth.toFixed(1)}%`);
    }

    const crease = creaseOf(seed, wear);
    this.el.style.setProperty("--crease", crease.amount.toFixed(2));
    if (crease.amount > 0) {
      this.el.style.setProperty("--crease-rot", `${crease.rot.toFixed(1)}deg`);
      this.el.style.setProperty("--crease-at", `${crease.at.toFixed(1)}%`);
      this.creaseRot = crease.rot;
    } else {
      this.creaseRot = Number.NaN;
    }
    // Whatever the light was last computed for, it was computed for a sheet with
    // a different crease in it. Cleared rather than recomputed here, because the
    // rotation this sheet is drawn at is `transform`'s to know, and it runs on
    // the same pass a moment later.
    this.facedRot = Number.NaN;

    const stain = stainOf(seed, wear);
    this.el.style.setProperty("--stain", stain.amount.toFixed(2));
    if (stain.amount > 0) {
      this.el.style.setProperty("--stain-x", `${stain.x.toFixed(1)}%`);
      this.el.style.setProperty("--stain-y", `${stain.y.toFixed(1)}%`);
      this.el.style.setProperty("--stain-r", `${stain.r.toFixed(1)}px`);
    }
  }

  setTape(seed: number, corners: number): void {
    this.tape.bind(seed, corners);
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
    // Before the bend, which is where the static text is too: a sheet that is
    // curling at a corner curls what is written there, and appending would have
    // put the caret's own text on top of the shading instead of under it.
    this.surface.insertBefore(field, this.bend);
  }

  /** A sheet of paper says nothing out loud — T-277. */
  hold(_audio: HTMLAudioElement | null): void {}

  setReeled(_reeled: number): void {}

  release(): void {
    clearHand(this.body);
    this.boundCold = null;
    this.el.classList.remove("is-lifted");
    // A released node is left clean, so nothing downstream has to reason about
    // what it was. Nothing depends on it here — `boundCold` is null above, so
    // whatever this node is recycled onto is guaranteed a bind, and a bind
    // writes both of these — but a pooled node wearing the last sheet's tear is
    // exactly the class of bug the polaroid's release is a paragraph long about.
    delete this.el.dataset["tear"];
    delete this.el.dataset["ear"];
    this.surface.style.removeProperty("clip-path");
    this.el.style.removeProperty("--stock-base");
    for (const prop of [...EDGE_PROPS, ...CURL_PROPS, ...FACE_PROPS, ...WEAR_PROPS]) {
      this.el.style.removeProperty(prop);
    }
    this.el.classList.remove(IS_AGED);
    this.written.fill(-9);
    this.boundWear = -1;
    this.folded = -1;
    this.earDepth = 0;
    this.boundEar = -1;
    this.creaseRot = Number.NaN;
    this.facedRot = Number.NaN;
    this.tape.release();
    this.adopt(null);
    this.shadow.reset();
    this.ink.release();
  }
}

/**
 * A manilla folder, a VHS cassette and a compact cassette — the three objects a
 * file that is not a photograph becomes (D-46 section 1, T-267).
 *
 * ## One class, because they are not three problems
 *
 * > Each of them is an **item**, not a widget. [...] If any of the three needs a
 * > special case in the renderer, the model is wrong. — D-46 section 1
 *
 * What actually differs between them is furniture: a tab, a pair of spool
 * windows, a J-card. What does not differ is everything that makes an object an
 * item — the shadow, the strips of tape, the ink canvas, the transform, the
 * pooling, the caret, the labels and the ageing — and all of that is written
 * once below. The furniture is built in the constructor, per kind, and never
 * branched on again, so a bind and a transform run the same code for all three.
 *
 * The archetype is decided from the mime by [`archetypeOf`] and each kind has
 * its own pool, so a recycled node is always a node of the right kind. That is
 * what lets the constructor branch: after it, `data-kind` on the root is the
 * only thing that varies, and `items.css` does the rest — the identical bargain
 * `PaperView` takes with five paper stocks.
 *
 * ## What each material does, which is not the same thing
 *
 * A folder is board: it yellows all over and it does **not** curl (T-314). A
 * cassette is polystyrene: it does neither, and its *label* is the part that
 * ages (T-272 goes further with that). Refusing curl on all three is a statement
 * about the objects rather than a gap, and it is the same statement
 * `PolaroidView.setCurl` already makes about a print in a frame — the mechanism
 * is offered to every view identically and each one answers for its material.
 *
 * The folder took the curl until T-314, on the argument that a folder is paper.
 * `setCurl` records what that missed.
 *
 * ## What is written on them, and where it comes from
 *
 * Four lines, of which the document owns one:
 *
 *   - the **case number**, typed, from the file's own name (or its hash, for a
 *     file that never had one) — `caseNumber`
 *   - the **runtime** or the **page count**, typed, off the asset record, and so
 *     legible on a machine that will never hold a byte of the file (AC-668)
 *   - the **title**, in the board's hand, when the file says what it is called
 *     and that is worth writing — `titleWorthWriting`, and D-47 for why that is
 *     a real question
 *   - the **caption**, in the same hand, which is the item's own text and the
 *     only one of the four anybody can edit. People write on tapes.
 */
/**
 * The reading surface — one sheet of paper, built the same way for all three
 * case objects (T-287, Q-299).
 *
 * A function rather than three copies because it *was* three copies waiting to
 * happen: the folder had this inline, and the answer to "where does a recording
 * show its transcript" was "on a case file's reading surface", which is only
 * true if there is one surface. Everything that differs between the objects is
 * in `items.css` and is geometry — where the sheet sits and how big A4 is
 * against that particular box — rather than structure.
 *
 * The three content nodes are three because the three answers are different
 * *materials*: text set on the sheet, a scan laid on it, and a sentence about
 * why there is neither. Built once and switched by class, so a page turn writes
 * content rather than restructuring the sheet.
 */
function buildLeaf(): {
  page: HTMLDivElement;
  leaf: HTMLDivElement;
  number: HTMLDivElement;
  meta: HTMLDivElement;
  body: HTMLDivElement;
  scan: HTMLImageElement;
  note: HTMLDivElement;
} {
  const leaf = div("folder-leaf");
  const number = div("leaf-number");
  const meta = div("leaf-meta");
  const header = div("leaf-header");
  header.append(number, meta);
  const body = div("leaf-body");
  const scan = document.createElement("img");
  scan.className = "leaf-scan";
  scan.alt = "";
  const note = div("leaf-note");
  leaf.append(header, body, scan, note);
  const page = div("folder-page");
  page.append(leaf);
  return { page, leaf, number, meta, body, scan, note };
}

/**
 * The gummed label somebody stuck on a tape they never had a log sheet for —
 * `CaseView.sticker` for why it exists at all (T-334).
 *
 * Built rather than written into the constructor twice, because a VHS and a
 * compact cassette wear the same sticker and only the corner it is on differs.
 * The words are here and not in `items.css` for the reason every other line on
 * these objects is in the DOM: it is writing on the thing, so it is text a
 * search of the page can find and a screen reader will read out — which is the
 * one sentence on this object that a person who cannot see it most needs.
 */
function buildSticker(): HTMLDivElement {
  const sticker = div("case-sticker");
  sticker.textContent = NO_TRANSCRIPT;
  return sticker;
}

class CaseView implements View {
  readonly archetype: CaseArchetype;
  readonly el: HTMLDivElement;
  readonly ink: ItemInk;
  /**
   * Never, for all three. A folder could be dog-eared and is not: the fold is a
   * sheet's, and `sheetEdgeOf` cuts it out of a *silhouette* these objects do
   * not have. Nothing here has a torn edge to fold back.
   */
  readonly folded = -1;

  private readonly shadow = new ShadowNode();
  private readonly tape = new TapeSet();
  /** The object itself. The shadow is outside it; everything else is inside. */
  private readonly body: HTMLDivElement;
  /**
   * What was written or typed on this object — and so, of the two things that
   * age here, the half that ages by *losing* something.
   *
   * `wear.ts` has both mechanisms and says which is which: paper ages by having
   * things added to it, and ink ages by going. So the card these four sit on
   * takes `--paper-yellowing` as a layer of its own background in `items.css`,
   * and only the writing takes [`wearFilter`] (T-316). The same four nodes on
   * every kind, which is why there is no branch here — a folder's front panel
   * and a cassette's label are the same object with a different word for it.
   *
   * Splitting the two is also what keeps the ageing off the recording. A filter
   * reaches everything below the node it is on, and a compact cassette's window
   * is a row of the label's own grid; a background does not, because it paints
   * under an element's children. So a fifteen-year-old cassette has a brown
   * label and the spools it always had (T-272).
   */
  private readonly ages: readonly HTMLElement[];
  private readonly number: HTMLDivElement;
  private readonly meta: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly caption: HTMLDivElement;
  /** The bend at a lifted corner — a folder's only, and null on the plastic. */
  private readonly bend: HTMLDivElement | null;
  /** The fibre in the card, likewise: a cassette label is coated and smooth. */
  private readonly grain: HTMLDivElement | null;
  /** The four digit counter, which only a VHS wears — see the constructor. */
  private readonly counter: HTMLDivElement | null;
  /**
   * The still, clipped to the tape — a VHS's only (T-270).
   *
   * Not the cassette's and not the folder's, and neither is an omission. There
   * is no frame to take off a sound recording, and a document's first page is a
   * *page* — it belongs to the spread T-279 mounts and to the spilling of T-288,
   * and lifting one here would be answering that question early with a
   * thumbnail.
   */
  private readonly print: HTMLDivElement | null;
  private readonly still: HTMLImageElement | null;
  /**
   * A gummed sticker on the corner of the shell, reading `NO TRANSCRIPT` — the
   * two plastic objects' only, and the whole of T-334.
   *
   * ## Why the sentence is on the object and not in the search field
   *
   * Q-273 settled that `Ctrl+F` reports what it could not read **among the
   * matches**, because a board full of scans that have nothing to do with the
   * query is not something the field should be talking about. A recording with
   * no transcript falls straight through that rule: it has no words in it, so it
   * is never a match, so it is never in the loop that does the counting — and
   * the board answers "nothing found", which is true of what it can read and
   * false about what is on the wall. `unsearchedAmongMatches` in `main.ts` says
   * the same thing from the other end.
   *
   * A sticker does not walk that back, and that is what makes it the answer
   * rather than a workaround. It says nothing about matches and nothing about
   * the board; it is a fact about *this tape*, stated on the tape, the way an
   * archive marks a reel it never had a log sheet for. Somebody searching for a
   * line they remember from an interview can see, without asking, which of the
   * recordings on the wall were never going to answer.
   *
   * A folder has none, and that is not an omission: a document nobody could read
   * has a page that says why (`setPage`), and one nobody has the bytes of is
   * drawn empty (`paintContents`). This is the object that had no way to say it.
   */
  private readonly sticker: HTMLDivElement | null;
  /**
   * The case number and the page count again, typed at the head of the open
   * page as a document header — Q-267, and a folder's only.
   *
   * The string exists twice on screen and must never exist twice in the code:
   * one `textContent` write below feeds both the tab and the header, so a
   * closed folder and its own open page cannot disagree about what the file is
   * called. A case number at the head of a page is a filing convention rather
   * than a piece of chrome, which is what made this the answer instead of a tab
   * counter-turned to stay upright.
   */
  private readonly pageNumber: HTMLDivElement | null = null;
  private readonly pageMeta: HTMLDivElement | null = null;
  /** The sheet's own frame, upright, and the one thing on this object whose
   *  type is sized to a page rather than to the label on a box. */
  private readonly leaf: HTMLDivElement | null = null;
  /**
   * The page's text, its lifted scan, and the sentence for a page that has
   * neither.
   *
   * On all three objects since T-287, where it was a folder's only. A recording
   * that arrived with a transcript beside it is read on the same sheet, by
   * Q-299 — the sheet is what a reading surface *is*, and building a second one
   * for the two plastic objects would have been two answers to one question.
   */
  private readonly leafBody: HTMLDivElement | null = null;
  private readonly leafScan: HTMLImageElement | null = null;
  private readonly leafNote: HTMLDivElement | null = null;
  /** What `setPage` last drew, so a page that has not changed is not rewritten
   *  on every frame the folder is open. A page turn changes it; a pan does not. */
  private drawnPage = "";
  /** The page count as the tab says it — "142 pp." — kept because the header
   *  borrows that slot to say which page is open and has to give it back. */
  private shutMeta = "";
  /** How many pages the asset record says there are. `0` for a document nobody
   *  has counted, which the header then reads off the page being drawn. */
  private pages = 0;

  private boundCold: ItemCold | null = null;
  /**
   * Everything off the asset record that reaches a label, as one string.
   *
   * A digest rather than seven compared fields, because the guard runs on every
   * bind and the record changes about as often as never. `""` is the sentinel
   * and cannot collide: a digest is seven values joined by spaces, so the
   * shortest one this can ever hold is six spaces.
   */
  private boundFacts = "";
  private boundWear = -1;
  private boundPlain = false;
  /** What `paintContents` last drew. `null` is "nothing yet", not a phase. */
  private boundPhase: AssetPhase | null = null;
  /** Its `--arrived`, in whole percent, so a fraction that has not moved a
   *  hundredth of the way is not a repaint. */
  private boundArrived = -1;
  /** The width the per-item type sizes were written for. */
  private sizedFor = -1;
  private field: HTMLTextAreaElement | null = null;
  /** The deck's element while this view is the one playing (T-277). */
  private audio: HTMLAudioElement | null = null;
  /** What `--reeled` last said, so four writes a second become none while a
   *  spool has not visibly moved. */
  private reeled = 0;
  private readonly written = new Float32Array(CURL_PROPS.length + FACE_PROPS.length).fill(-9);
  /**
   * What `writeLight` last wrote — the light in this object's frame and the
   * counter-turn (T-313). Its own slots rather than more of `written`, because
   * this is written on the *transform* pass and that one on the curl pass, and a
   * shared cache would be two writers on one array.
   */
  private readonly writtenLight = new Float32Array(3).fill(-9);
  /** What `--open` was last set to. `-9` so the first write always happens,
   *  including the first write of a zero onto a recycled node. */
  private writtenOpen = -9;

  constructor(archetype: CaseArchetype) {
    this.archetype = archetype;
    this.el = document.createElement("div");
    this.el.className = "item item-case";
    this.el.dataset["kind"] = archetype;
    this.ink = new ItemInk(this.el);

    this.body = div("case-body");
    this.number = div("case-number");
    this.meta = div("case-meta");
    this.title = div("case-title");
    this.caption = div("case-caption");
    this.ages = [this.number, this.meta, this.title, this.caption];

    // The four text nodes are the same four on every kind; where they sit is
    // not. A folder's case number is typed on the tab and a cassette's is on
    // the label, which is a difference in what the object *is* rather than in
    // what is being said, so it is a difference in parents and nothing else.
    if (archetype === "folder") {
      // Drawn from Phil's reference: a used kraft folder, landscape, with the
      // back panel standing proud along the top and a handful of paper spilling
      // out of it. The back is the whole box; the front panel starts a little
      // below it, and the gap between the two is where the contents show.
      const back = div("folder-back");
      // What is inside, and the most alive thing in the photograph — sheets at
      // their own angles, above the front panel and mostly to the right. Two
      // rather than one: a folder holding a single sheet is a folder nobody has
      // put anything in.
      const sheets = div("folder-sheets");
      const front = div("folder-front");
      // No curl. See `setCurl` — this is where refusing it costs nothing.
      this.bend = null;
      this.counter = null;
      this.grain = div("case-grain");
      // One shared tile for every folder on the board, generated once and
      // memoised by stock. `cream` is the fibre nearest to kraft card, and the
      // per-item offset in `bind` is what stops a filing cabinet's worth of
      // them being one texture repeated.
      this.grain.style.backgroundImage = `url(${paperGrainUrl("cream")})`;
      // The reference has no label at all, so where one goes was mine to
      // choose: a gummed filing label stuck on the face, which is what these
      // folders actually wear and which leaves the spilling paper alone.
      const label = div("folder-label");
      label.append(this.number);
      front.append(this.grain, label, this.meta, this.title, this.caption);
      this.print = null;
      this.still = null;
      // A folder already has three ways of saying it could not be read, and all
      // three are on the page. See `sticker`.
      this.sticker = null;
      // The sheet inside, which is only ever seen with the cover folded back
      // (T-319). Between the pile and the cover in the DOM, so the cover
      // reveals it by leaving rather than by anything being switched on.
      //
      // **It is turned a quarter the other way**, and that is the whole of the
      // geometry. The folder holds A4 lying horizontal — objects.ts says so and
      // the 310 by 222 mm it is cut to is that A4 plus a margin — so the sheet's
      // long edge runs along the folder's width. Turn the folder up to read it
      // (`Scene.setOpen`) and that long edge stands: the page is portrait on
      // screen, `text.rs`'s 66 by 46 grid is the right way round, and no number
      // anywhere had to move. `.folder-leaf` is the sheet in its own upright
      // frame and `items.css` puts it back into the folder's.
      const sheet = buildLeaf();
      this.leaf = sheet.leaf;
      this.pageNumber = sheet.number;
      this.pageMeta = sheet.meta;
      this.leafBody = sheet.body;
      this.leafScan = sheet.scan;
      this.leafNote = sheet.note;
      this.body.append(back, sheets, sheet.page, front);
    } else if (archetype === "vhs") {
      // A VHS is read from Phil's reference: a ribbed shell, a white label in
      // the MIDDLE of the face, and a window either side of it showing one reel
      // each. Not a label above a window — the two windows flank the label, and
      // that is the arrangement the object is recognised by.
      const shell = div("case-shell");
      // Supply on the left and take-up on the right, which is a fact about the
      // object rather than about the order these were appended in — see
      // `.is-supply` in `items.css`.
      const left = div("case-window is-left");
      left.append(div("case-reel is-supply"));
      const right = div("case-window is-right");
      right.append(div("case-reel is-takeup"));
      const label = div("case-label");
      this.bend = null;
      this.grain = null;
      label.append(this.number, this.meta, this.title, this.caption);
      // The counter, on the shell under the label and nowhere near it: it is a
      // reading off the transport and not a thing anybody wrote. Four digits,
      // each on its own drum, and all four are zeros because nothing has played
      // — which is what the counter on a tape nobody has watched says. A cassette
      // has none, because a cassette's transport readout is the spools
      // themselves and that is the whole distinction T-268 is drawn on.
      const counter = div("case-counter");
      for (const digit of COUNTER_AT_REST) {
        const wheel = div("case-digit");
        wheel.textContent = digit;
        counter.append(wheel);
      }
      this.counter = counter;
      // The still, and it is an object stuck to the tape rather than a picture
      // printed on it — a print with a white border and a clip over its head,
      // sitting proud of the shell with its own small shadow. Which is the
      // whole argument for it being here at all: a rental sleeve would put the
      // picture *under* the writing and make the tape a poster, and this board
      // is somebody's shelf rather than a shop's (I-14).
      //
      // Last in the body, so it is over the shell and the window it laps onto
      // and under the tape at the corners, which is where a strip of tape put
      // on afterwards would be.
      const print = div("case-print");
      const still = document.createElement("img");
      still.className = "case-still";
      // Empty rather than descriptive. It is decoration on an object whose name
      // is already written on it twice, and a screen reader announcing the
      // filename a third time is noise.
      still.alt = "";
      still.decoding = "async";
      still.draggable = false;
      print.append(still, div("case-clip"));
      this.print = print;
      this.still = still;
      this.sticker = buildSticker();
      const sheet = buildLeaf();
      this.leaf = sheet.leaf;
      this.pageNumber = sheet.number;
      this.pageMeta = sheet.meta;
      this.leafBody = sheet.body;
      this.leafScan = sheet.scan;
      this.leafNote = sheet.note;
      // **Last, where the folder's is in the middle**, and the difference is the
      // objects rather than an inconsistency. A folder's sheet is inside it and
      // is revealed by the cover folding back, so it sits between the pile and
      // the front panel; a tape has no cover to fold, and its transcript is a
      // sheaf that came *with* it rather than anything held inside the shell. So
      // the sheet stands in front of the object, which is where a stack of paper
      // propped against a cassette actually is (T-287).
      // The sticker goes on before the sheet and after everything else: it is
      // stuck to the outside of the shell, so it is over the moulding, and the
      // transcript's own pages stand in front of it when there are any — which
      // there never are while it is showing.
      this.body.append(shell, left, right, label, counter, print, this.sticker, sheet.page);
    } else {
      // A compact cassette, likewise from the reference, and its window is the
      // structural surprise: it is a hole *through the label*, with writing
      // above it and the brand below. So the window is a row of the label's own
      // grid rather than a thing lying on top of one — which is also what keeps
      // the two lines of writing off it without a single magic offset.
      //
      // The reels do not turn. That is T-268, which is about the transport being
      // the position readout rather than about the object being drawn.
      const shell = div("case-shell");
      const label = div("case-label");
      this.bend = null;
      this.grain = null;
      this.counter = null;
      const window_ = div("case-window");
      window_.append(div("case-reel is-supply"), div("case-tape"), div("case-reel is-takeup"));
      label.append(this.number, this.meta, window_, this.title, this.caption);
      this.print = null;
      this.still = null;
      this.sticker = buildSticker();
      const sheet = buildLeaf();
      this.leaf = sheet.leaf;
      this.pageNumber = sheet.number;
      this.pageMeta = sheet.meta;
      this.leafBody = sheet.body;
      this.leafScan = sheet.scan;
      this.leafNote = sheet.note;
      this.body.append(shell, label, div("case-holes"), this.sticker, sheet.page);
    }

    // Tape last, over the front of the object, exactly as on the other two.
    this.el.append(this.shadow.el, this.body, ...this.tape.nodes);
  }

  bind(
    cold: ItemCold,
    facts: AssetFacts,
    assetUrl: AssetResolver,
    screenPx: number,
    wear: number,
    plain: boolean,
  ): void {
    const worn = Math.round(wear * 100);
    if (worn !== this.boundWear) {
      this.boundWear = worn;
      this.paintAge(worn / 100);
    }
    // Ahead of the guard, and it is the one call in this method that has to
    // happen whether or not there is anything to draw (T-271). Resolving an
    // asset is what tells the exchange somebody is *looking* at it — `assetUrl`
    // raises the want to `VISIBLE` and marks the hash requesting — and until
    // this task no case object ever asked. `reconcileAssets` swept them up at
    // idle priority on boot and on every reconnect, so the bytes did arrive; the
    // tape you were sitting in front of simply queued behind every photograph on
    // the board rather than ahead of them.
    //
    // The URL itself is thrown away, and that is not waste: what this reads is
    // the *phase*, and a folder's face is CSS all the way down. There is no
    // `<img>` here to point at anything, which is also why there is no decode
    // gap and no `arrive()` — see `paintContents`.
    const asset = cold.assetId ? assetUrl(cold.assetId, screenPx) : NO_ASSET;
    const arrived = Math.round(asset.fraction * 100);
    const sameContents = asset.phase === this.boundPhase && arrived === this.boundArrived;
    // The still is a second asset and gets the same call for the same reason —
    // it is a want raised by somebody looking at the tape, and it is the *only*
    // want that will ever be raised on a poster, because no item wears one.
    //
    // Asked for at the print's own size and not the item's: `variantFor` picks
    // a stored variant off how many pixels the thing will actually occupy, and
    // the print is a fraction of the tape's width. Passing `screenPx` would
    // fetch the display variant of a picture being drawn a third that wide.
    const still = this.still && facts.poster ? assetUrl(facts.poster, screenPx * PRINT_W) : NO_ASSET;
    // The asset record is the fourth input and it is the one that is *not* the
    // cold item: a page count arrives when a peer writes the record, and the
    // title arrives later still and from this machine's own disk (Q-211), and
    // neither of those is a write to the item. Guarding on the cold identity
    // alone would leave a folder saying nothing for the rest of the session.
    // The still's *url* rather than its hash, and that is the load-bearing
    // half: the hash is on the record from the moment it is grabbed, and what
    // changes afterwards is whether this machine can show it. A digest naming
    // the hash would compare equal across the transfer committing and the print
    // would stay blank until something else dirtied the item, and the tape you
    // were looking at when the bytes landed would be the one that never got a
    // picture. A url covers both halves: it is `""` until the phase is ready.
    // The transcript is in here as the *hash* and not as a url, which is the
    // opposite choice to the still's above and is the same argument answered
    // the other way. What the print draws is bytes, so it changes when the
    // transfer commits; what the sticker draws is whether the record names a
    // sidecar at all, and that is settled the moment a peer writes it. A tape
    // whose transcript is on somebody else's machine still has one.
    const digest = `${facts.kind} ${facts.name} ${facts.title} ${facts.duration} ${facts.pages} ${still.url} ${facts.transcript}`;
    if (
      this.boundCold === cold &&
      digest === this.boundFacts &&
      plain === this.boundPlain &&
      sameContents
    ) {
      return;
    }
    if (!sameContents) {
      this.boundPhase = asset.phase;
      this.boundArrived = arrived;
      this.paintContents(asset.phase, arrived);
    }
    this.boundCold = cold;
    this.boundFacts = digest;
    this.boundPlain = plain;

    this.paintPrint(still.url, cold.seed);
    this.paintSticker(facts.transcript, cold.seed);

    // Typed, and never in the hand: this is the name on the file, which is a
    // thing that was printed rather than written. `caseNumber` says why the
    // extension comes off and what a file with no name gets instead.
    this.number.textContent = caseNumber(facts.name || null, cold.assetId ?? "");
    this.meta.textContent =
      this.archetype === "folder" ? pagesLabel(facts.pages) : runtimeLabel(facts.duration);
    // The open page's header, off the same two writes rather than off a second
    // reading of the facts (Q-267). `textContent` and not a copy taken later:
    // these are the same strings, so there is one place to be wrong about them.
    if (this.pageNumber) this.pageNumber.textContent = this.number.textContent;
    // The shut label — "142 pp." — kept so that closing a folder puts it back.
    // While it is open the same slot says which page you are on instead, which
    // is a different fact and the one a citation names (T-321).
    this.shutMeta = this.meta.textContent ?? "";
    if (this.pageMeta) this.pageMeta.textContent = this.shutMeta;
    // And which face the page is set in — AC-678's "clean face available per
    // document, for something that has to be read rather than admired".
    //
    // `style.fontFamily`, which is the field DESIGN section 3.6 already has and
    // T-225 already gave a home, rather than a second per-document preference
    // that would then have to be kept in step with it. The *label* is unaffected
    // and deliberately so: a case number is typed because it is a thing that was
    // printed, so this view has never asked `faceOf` about it and still does not.
    if (this.leaf) this.leaf.dataset["face"] = faceOf(cold);
    // In the hand, because the two hand-written lines are the two that came from
    // a person: one of them from whoever made the document, one from whoever is
    // looking at it. `titleWorthWriting` is what keeps the first from being the
    // name of the design file this was printed out of (D-47).
    writeHand(this.title, titleWorthWriting(facts.title, facts.name), cold.seed, plain);
    writeHand(this.caption, cold.text, cold.seed, plain);
    this.caption.classList.toggle("is-empty", cold.text.length === 0);

    // How the paper inside this one is sitting. A signed nudge rather than three
    // cuts, because what varies between two folders on a real desk is not a
    // manufacturing option — it is that nobody squares up what they put in.
    // There was a second one of these for the top sheet's own lean; it went with
    // the top sheet on T-311.
    if (this.archetype === "folder") {
      this.el.style.setProperty("--spill", (valueAt(cold.seed, "tab", 0) * 2 - 1).toFixed(2));
      // And how much is in it. Set here rather than at ingest because it is a
      // *drawing* and not a fact about the item: the page count arrives with
      // the asset record, which may be a peer's write and a network away, and
      // an item whose box moved when that landed would be a document write
      // nobody made — and would move the pins, the ink and the strings with it.
      this.el.style.setProperty("--bulk", folderBulk(facts.pages).toFixed(3));
      // And how many there are, for the open page's header. `Math.max` against
      // the page being read guards the one case the record cannot cover: a
      // document counted by a machine that could not count it reads `null`, and
      // "3 of 1" would be a worse answer than "3 of 3".
      this.pages = facts.pages ?? 0;
    }
    // The name has just changed, and the size it is written at is a function of
    // it — see `sizeLabels`. `sizedFor` is the width and has not moved.
    if (this.sizedFor > 0) this.sizeLabels(this.sizedFor);
    // The grain's offset, so a wall of folders is not one texture repeated —
    // the same trick, and the same function, as a sheet of paper's fibres.
    if (this.grain) this.grain.style.backgroundPosition = grainPosition(cold.seed);
  }

  /**
   * The case number, written small enough to fit where it is written.
   *
   * A folder's tab is a third of the object and a filename is as long as
   * somebody made it, so the two do not agree by default: `configure-vhosts` on
   * a 380-unit folder wants half again the tab it has, and a label that merely
   * clipped showed the *middle* of the name — `FIGURE-VHO` — which is worse than
   * either end of it. A person with a long name and a small tab writes smaller,
   * and `fitLabel` is that, with a floor and an ellipsis under it.
   *
   * Called from both the transform and the bind, because it depends on the width
   * *and* on the string: an object keeps its size for its whole life and its
   * name changes when a record lands.
   */
  private sizeLabels(w: number): void {
    // Only a folder's gummed label, and that is the point of the method rather
    // than a limitation of it. A stuck-on label is one line on a strip of a
    // fixed size, so a long name has to be written smaller; a cassette label
    // has ruled lines and the name carries onto the next one, which `items.css`
    // lets it do.
    const base = w * NUMBER_SIZE;
    const size =
      this.archetype === "folder"
        ? fitLabel(this.number.textContent ?? "", w * LABEL_WIDTH, base)
        : base;
    this.number.style.fontSize = `${Math.max(5, size).toFixed(1)}px`;
    // And the open page's own type, which is a different question with a
    // different answer. The label on a folder is sized to be read across a room
    // — 0.055 of the object, about 26 units — and a document is not set in
    // twenty-six units. This is the size a page is actually typed at, so it is
    // deliberately too small to read at board scale, and the floor that fixes
    // that is a camera problem rather than a type one (T-321). Set on the leaf
    // and inherited, so everything on the page is one number.
    if (this.leaf) this.leaf.style.fontSize = `${Math.max(3, w * PAGE_TEXT_SIZE).toFixed(2)}px`;
  }

  /**
   * What is *in* the object, which is the only part of one of these three that
   * a missing file can take away (T-271, DESIGN section 7.5).
   *
   * A photograph with no bytes has nothing to show at all, so the whole window
   * becomes film. None of these three is like that: the shell, the label, the
   * case number, the runtime and the page count are all drawn from the document
   * and are legible on a machine that will never hold a byte of the file, which
   * is AC-668 and is not up for renegotiation here. So what says the file is not
   * here is the one thing that genuinely is not: **the recording**. A tape with
   * no ribbon on its spools, and a folder with nothing in it.
   *
   * That gives the transfer a readout for free, and the right one. `--arrived`
   * winds the tape back on and raises the paper in the folder as the chunks
   * land, so a four hundred megabyte interview arriving is an object filling up
   * rather than a bar drawn over it — which is the same argument T-268 makes
   * about the counter, arrived at from the other end.
   *
   * Three departures from `PolaroidView.paintFilm`, each one a real difference
   * rather than a divergence:
   *
   *  - **No decode gap.** A polaroid keeps its film on past `ready` until an
   *    `<img>` fires `load`, because there is a decode between bytes on the disk
   *    and pixels in the window. These objects are CSS, so `ready` is the whole
   *    of it and `is-waiting` comes off here.
   *  - **`--arrived` is unitless where `--develop` is a percentage.** A folder's
   *    head is a `calc()` that multiplies a length by it (`items.css`), and CSS
   *    cannot multiply by a percentage. The stylesheet spells `100%` where it
   *    wants one.
   *  - **It is written only while a transfer is running**, so an object at rest
   *    has no `--arrived` at all and every rule falls back to `1`. That is what
   *    makes "a file that is here is drawn exactly as it was before this task"
   *    a thing a test can assert rather than a thing to hope for.
   */
  /**
   * The still, or the absence of one.
   *
   * There is no third state here and that is the decision worth recording. A
   * photograph has five (`state/assets.ts`) and draws every one of them, because
   * a photograph with no bytes is an *item with nothing in it* and the person is
   * owed an account of why. A tape with no still is a tape — the shell, the
   * label, the case number and the runtime are all there and all legible, which
   * is the whole of T-271's argument — so a print showing "this still is
   * transferring" would be furniture explaining the absence of furniture.
   *
   * So: the clip and the print exist only while there is something on them, and
   * a tape whose poster has not been grabbed, or whose still is somewhere else
   * on the LAN, is drawn exactly as it was before this task. That is a thing a
   * test can assert, and `.case-print` being absent from the box model is what
   * makes it cheap — no image decode and no compositing layer on a board of
   * tapes nobody has bytes for.
   *
   * `src` is cleared rather than left stale, because views are pooled: the node
   * this tape gives back is the node the next one mounts on, and an `<img>`
   * still pointing at the last film's frame would show it for the frame between
   * mounting and binding.
   */
  private paintPrint(url: string, seed: number): void {
    if (this.print === null || this.still === null) return;
    const has = url.length > 0;
    this.print.classList.toggle("is-empty", !has);
    if (!has) {
      if (this.still.getAttribute("src") !== null) this.still.removeAttribute("src");
      return;
    }
    if (this.still.getAttribute("src") !== url) this.still.src = url;
    // Which way it was clipped on, and how far down. Nobody lines a print up
    // with the edge of a tape, and two tapes side by side with theirs at
    // identical angles is the tell that this is drawn rather than done.
    this.print.style.setProperty("--print-tilt", `${(valueAt(seed, "print", 0) * 2 - 1).toFixed(2)}`);
  }

  /**
   * The sticker, or no sticker — and the second is the ordinary case, because a
   * recording that came in with its `.srt` beside it is a recording nobody has
   * to be told anything about.
   *
   * `is-empty` and `display: none` rather than an opacity, on the same argument
   * `paintPrint` makes: a board of interviews that all have transcripts should
   * cost nothing at all for this feature, and a node that is not in the box
   * model is the cheapest way to say that. It is also what makes "a tape with a
   * transcript is drawn exactly as it was before this task" assertable.
   *
   * The tilt is seeded like the print's, for the same reason and one more: two
   * tapes on a shelf with their stickers at identical angles would read as
   * printed-on packaging, which is the one thing this must not look like. A
   * sticker is something a person put there afterwards, and that is the whole
   * claim it is making.
   */
  private paintSticker(transcript: string, seed: number): void {
    if (this.sticker === null) return;
    this.sticker.classList.toggle("is-empty", transcript.length > 0);
    if (transcript.length > 0) return;
    this.sticker.style.setProperty(
      "--sticker-tilt",
      `${(valueAt(seed, "sticker", 0) * 2 - 1).toFixed(2)}`,
    );
  }

  private paintContents(phase: AssetPhase, arrived: number): void {
    this.el.classList.remove(...FILM_CLASSES);
    const film = filmClass(phase);
    if (film) this.el.classList.add(film);
    this.el.classList.toggle("is-waiting", phase !== "ready");
    if (phase === "transferring") {
      this.el.style.setProperty("--arrived", (arrived / 100).toFixed(2));
    } else {
      this.el.style.removeProperty("--arrived");
    }
  }

  /**
   * What the years have taken off it — and off *what* is the whole content of
   * this method.
   *
   * Two mechanisms, because there are two materials, and `wear.ts` already draws
   * the line: what ages by *gaining* is the card, and it gains its years as a
   * layer of its own background in `items.css`. What ages by *losing* is the
   * writing, and that is this — [`wearFilter`] on the four text nodes, wherever
   * this kind put them.
   *
   * The card used to take the filter too, and T-316 is what came of measuring
   * it: on a colour print, lifting the blacks is the effect, and on cream card
   * the same brightness term is most of what you see. A fifteen-year-old label
   * came out 239,233,216 against a new one's 246,237,217 — three percent
   * *brighter* and one percent warmer, which is a label that has been bleached
   * rather than one that has yellowed, and far too small to notice either way.
   * Kraft was worse: 196,162,125 to 194,170,141, straight toward grey.
   *
   * What is *not* aged is the polystyrene, which does not go brown, and the
   * recording, which is not ours to damage (T-272).
   */
  private paintAge(wear: number): void {
    this.el.classList.toggle(IS_AGED, wear > 0);
    if (wear > 0) this.el.style.setProperty("--age", wear.toFixed(2));
    else this.el.style.removeProperty("--age");
    const filter = wearFilter(wear);
    for (const el of this.ages) el.style.filter = filter;
    // The caption is in `ages` and the editor's field replaces it, so the field
    // has to take the same filter or the writing lifts out of its own age for
    // as long as somebody is typing into it. `adopt` does the other direction.
    if (this.field) this.field.style.filter = filter;
  }

  transform(x: number, y: number, rot: number, w: number, h: number, lift: number, open: number): void {
    if (w !== this.sizedFor) {
      this.sizedFor = w;
      // Every line of type on these objects is sized off the item's width, for
      // the reason a polaroid's caption is: the object has one real-world size
      // and the label on it is a fixed fraction of that, so a folder scaled up
      // is a bigger folder rather than a folder with bigger writing on it.
      this.sizeLabels(w);
      const body = `${Math.max(6, w * CASE_TEXT_SIZE).toFixed(1)}px`;
      this.meta.style.fontSize = body;
      this.title.style.fontSize = `${Math.max(6, w * TITLE_SIZE).toFixed(1)}px`;
      this.caption.style.fontSize = body;
      if (this.counter) this.counter.style.fontSize = `${Math.max(4, w * DIGIT_SIZE).toFixed(1)}px`;
      // Smaller than anything else written on the object, and the smallest
      // floor on it. It is a stock label off a roll rather than something
      // anybody chose the size of, and it must not compete with the two lines
      // that say what the recording *is* — `sizeLabels` sizes the writing to be
      // read across a room, and this is read by somebody already looking.
      if (this.sticker) {
        this.sticker.style.fontSize = `${Math.max(3, w * STICKER_SIZE).toFixed(1)}px`;
      }
      if (this.field) this.field.style.fontSize = body;
    }
    writeTransform(this.el, x, y, rot, w, h, lift);
    // Here and not on the curl pass: these three are a function of the drawn
    // rotation and nothing else, and this is where the drawn rotation arrives.
    // A folder's kraft is all CSS gradients, and without this every one of them
    // turns with the object and the folder is lit from its own side (T-313).
    writeLight(this.el, rot, this.writtenLight);
    // How far the cover has folded back, 0 as it hangs and 1 when it is open
    // (T-319). One custom property and `items.css` does the rest — the folding,
    // the sheet appearing under it and the header at its head are all one
    // number, which is what keeps the whole open state out of this file.
    //
    // Guarded on having changed, and the guard is not a micro-optimisation: a
    // custom property write invalidates style for the subtree, and this runs on
    // every item on every transform pass. Only one folder on a board is ever
    // open, so the honest steady state here is that nothing is written at all.
    if (open !== this.writtenOpen) {
      this.writtenOpen = open;
      // A folder that has never been opened gets no property, so the CSS
      // fallback is what draws it — one fewer thing on the style resolution of
      // every case object on the board.
      if (open === 0) this.el.style.removeProperty("--open");
      else this.el.style.setProperty("--open", open.toFixed(4));
    }
    setCarried(this.el, this.shadow, lift);
    this.shadow.update(rot);
    this.tape.update(rot);
  }

  /**
   * Draw the page that is open on this case file — T-320.
   *
   * Called only for the item that is actually open, so the cost of a page is
   * paid once per document rather than once per folder on the board. Guarded on
   * what was last drawn, because the layer offers this on every frame the folder
   * is open and rewriting a page a person is reading is both wasted work and a
   * visible reflow under their eyes.
   *
   * ## Five answers, and the distinctions are the whole of AC-681 and AC-682
   *
   * A typed page is its runs, re-set on our paper — Q-198 chose that over a
   * facsimile, so the boxes Rust measured are used to work out where the *lines*
   * were and then thrown away. A page of a text file is its text, which has no
   * boxes at all. A scan is its lifted image laid on the sheet (Q-199), which is
   * the one place this feature shows the original and does not reintroduce a
   * facsimile, because nothing is being rendered — an image is being put on a
   * piece of paper, which is what this board already does with a photograph.
   *
   * And the two that must never pass as a blank sheet: a page with nothing on it
   * says so, and one this build cannot read says what stopped it. A filing is
   * routinely typed pages with scanned exhibits behind them, so all five sit
   * side by side inside one document.
   */
  setPage(view: PageView | null): void {
    const body = this.leafBody;
    const scan = this.leafScan;
    const note = this.leafNote;
    if (body === null || scan === null || note === null || this.leaf === null) return;

    const page = view?.page ?? null;
    const content = page?.content ?? null;
    // Everything that decides what is drawn, as one string. A digest rather than
    // five compared fields for the reason the facts digest above is one: this
    // runs on every frame a folder is open and none of it changes between turns.
    const digest = [
      view?.phase ?? "none",
      page?.index ?? 0,
      content?.kind ?? "-",
      view?.imageUrl ?? "",
      view?.reason ?? "",
      content?.kind === "text" ? content.runs.length : content?.kind === "plain" ? content.text.length : 0,
      // The figures, and their bytes: a page whose chart is still being lifted
      // and the same page with it in hand are two different sheets (T-329).
      view?.figureUrls.join("|") ?? "",
      content?.kind === "text" ? content.figures.length : 0,
    ].join(" ");
    if (digest === this.drawnPage) return;
    this.drawnPage = digest;

    const seed = this.boundCold?.seed ?? 0;
    const setNote = (say: string): void => {
      note.textContent = say;
    };

    /**
     * Which page this is, in the slot the shut folder uses for its page count.
     *
     * **"3 of 51" and not "3"**, because a page reference means nothing without
     * the document's length beside it — and because the two numbers together are
     * exactly what a citation carries (D-60: the reference is `(sha256, page)`,
     * and the count is what makes a page number a *place*).
     *
     * Falls back to the shut label whenever there is no page: a folder that has
     * been closed, or one whose document will not open, says how thick it is
     * rather than saying nothing.
     */
    if (this.pageMeta) {
      this.pageMeta.textContent =
        page === null ? this.shutMeta : `${page.index} of ${Math.max(page.index, this.pages)}`;
    }

    if (view === null || view.phase === "reading") {
      // The paper is there and nothing is on it yet. Deliberately not a message:
      // a page arrives in a handful of milliseconds off a cached document, and a
      // word that appears and vanishes at that rate is a flicker rather than
      // information.
      clearHand(body);
      scan.removeAttribute("src");
      setNote("");
    } else if (view.phase === "unreadable" || content === null) {
      clearHand(body);
      scan.removeAttribute("src");
      setNote(view.reason ?? "this page could not be read");
    } else if (content.kind === "plain") {
      // `plain` — the flag, not the content kind. Q-269: the hand's face without
      // the per-glyph jitter, which measured 0.2 ms a page against 16.3.
      writeHand(body, content.text, seed, true);
      scan.removeAttribute("src");
      setNote("");
    } else if (content.kind === "text") {
      // `page` is non-null wherever `content` is — they come off the same view
      // — but the narrowing does not survive the walk down to `content.kind`.
      writePage(body, content.runs, content.figures, view.figureUrls, seed, page?.width ?? 0);
      scan.removeAttribute("src");
      setNote("");
    } else if (content.kind === "image") {
      clearHand(body);
      if (view.imageUrl) scan.src = view.imageUrl;
      else scan.removeAttribute("src");
      setNote("");
    } else if (content.kind === "empty") {
      clearHand(body);
      scan.removeAttribute("src");
      setNote("this page is blank");
    } else {
      clearHand(body);
      scan.removeAttribute("src");
      setNote(content.reason);
    }

    this.leaf.dataset["page"] =
      view === null ? "reading" : view.phase === "ready" ? (content?.kind ?? "reading") : view.phase;
  }

  /**
   * **No case object curls**, which now includes the folder (T-314, Q-243).
   *
   * Not a special case — it is the same shape as `PolaroidView.setCurl`, which
   * refuses for a print in a frame. A mechanism the layer offers every view
   * identically, answered by each view for its own material.
   *
   * The folder used to take it, on the argument that a folder is paper and card
   * does bend. What that argument missed is *scale*. A corner flap is drawn to
   * reach a fixed way in from the corner, which on a sheet is a corner and on
   * something 481 by 344 is most of an edge: isolated by hiding `.paper-bend`
   * and shooting the same framing twice, what a folder actually wore was a dark
   * band down its whole left side and across its top with a broad brightening
   * opposite. A vignette, not four flaps — and the kraft read as clean board the
   * moment it was switched off.
   *
   * The material argument holds up too, which is why this is the answer rather
   * than a smaller number. A manilla folder is 300gsm board folded double along
   * its foot, and the fold is the whole reason it holds a shape: what handling
   * does to one is take the corners soft and *round*, which is `edge.ts`'s job,
   * not lift them off the surface. Stiffness is the statement, and refusing curl
   * is how this class already spells it.
   */
  setCurl(corners: Float32Array, faces: Float32Array): void {
    if (this.bend === null) return;
    writeCurl(this.el, corners, faces, this.written);
  }

  setTape(seed: number, corners: number): void {
    this.tape.bind(seed, corners);
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
    // closes the editor. Same three lines, same reason, as both other views.
    if (this.field === field && field.parentNode === this.caption.parentNode) return;
    this.field = field;
    field.className = "item-field case-caption";
    field.style.fontSize = this.caption.style.fontSize;
    // Both off the node it stands in for, and for the same reason: the field is
    // the caption while it is open, so it is written at the caption's size and
    // has had the caption's years — see `paintAge`.
    field.style.filter = this.caption.style.filter;
    this.caption.parentNode?.appendChild(field);
  }

  /**
   * Take the deck's element in, or give it back — T-277.
   *
   * Inside the shell rather than beside the item, so that an item deleted, a
   * board closed or a node pooled takes the element out of the document with
   * it and the sound stops with the object. Nothing is drawn by it: what says
   * a cassette is playing is the tape moving between its reels.
   *
   * Idempotent, like `adopt` above and for a related reason rather than the
   * same one — re-appending a media element is a `remove` and an `insert`, and
   * a media element that leaves the document is paused by the user agent
   * (D-48). Doing it on every DOM phase would be a stutter a frame long, four
   * times a second, for the rest of the recording.
   */
  hold(audio: HTMLAudioElement | null): void {
    if (audio === null) {
      if (this.audio?.parentNode === this.body) this.audio.remove();
      this.audio = null;
      return;
    }
    if (this.audio === audio && audio.parentNode === this.body) return;
    this.audio = audio;
    this.body.append(audio);
  }

  setReeled(reeled: number): void {
    // Rounded before the compare, because this arrives off `timeupdate` and a
    // spool is drawn from a square root of it — a thousandth of a two-hour
    // recording is seven seconds and not a pixel of pack radius.
    const wound = Math.round(reeled * 1000) / 1000;
    if (wound === this.reeled) return;
    this.reeled = wound;
    if (wound === 0) this.el.style.removeProperty("--reeled");
    else this.el.style.setProperty("--reeled", wound.toFixed(3));
  }

  release(): void {
    clearHand(this.title);
    clearHand(this.caption);
    this.adopt(null);
    // And the recording, on exactly the argument the two lines above make about
    // the caret: a pooled node keeps its subtree, and the one thing worse than
    // inheriting somebody else's caption is inheriting their tape, still
    // playing. The layer stops the deck before it releases a playing view, so
    // this is the second of the two doors rather than the only one.
    this.hold(null);
    this.setReeled(0);
    this.boundCold = null;
    // Belt and braces with the line above, and said plainly because a mutant
    // that removed it survived: `boundCold = null` is already enough to force
    // the next bind to paint, since the binding mints a fresh cold record for
    // every item. This is here so that the *guard* and the *reset* name the same
    // set of inputs — a later input added to one and forgotten in the other is
    // how a pooled node comes back wearing the last object's case number.
    this.boundFacts = "";
    this.boundWear = -1;
    // The two that are not belt and braces. `paintContents` is guarded on the
    // phase, and the item this node is handed to next is very often in the
    // *same* one — a board joining cold is a wall of objects all equally not
    // here — so a node released while waiting and rebound while waiting would
    // never be repainted, and would keep a stale `--arrived` from an object it
    // is no longer. Exactly `PolaroidView.release`'s reason for forgetting the
    // phase, and the same trap.
    this.boundPhase = null;
    this.boundArrived = -1;
    this.written.fill(-9);
    this.number.textContent = "";
    this.meta.textContent = "";
    this.el.classList.remove("is-lifted", IS_AGED, "is-waiting", ...FILM_CLASSES);
    this.el.style.removeProperty("--age");
    // `--spill` and `--bulk` are the folder's, `--arrived` is every kind's, and
    // all three are written by `bind`. What was here instead was `--tab`, which
    // nothing has written since the tab became a gummed label — so the reset had
    // stopped naming the same set of properties the bind does, which is the drift
    // the comment above is about, caught in the act.
    // `--reeled` is in the list because `setReeled(0)` above only removes it
    // when it was written; naming it here is what keeps the reset and the bind
    // describing the same set, which is what the comment above is about.
    for (const prop of ["--spill", "--bulk", "--arrived", "--reeled"]) {
      this.el.style.removeProperty(prop);
    }
    for (const el of this.ages) el.style.removeProperty("filter");
    for (const prop of [...CURL_PROPS, ...FACE_PROPS]) this.el.style.removeProperty(prop);
    this.tape.release();
    this.shadow.reset();
    this.ink.release();
  }
}

/** A `div` with a class on it, which is most of what a constructor here does. */
function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

/**
 * What a VHS's counter reads until something plays it (T-268, Q-250).
 *
 * Four zeros, and four rather than a `"0000"` because each digit is a drum of
 * its own — a mechanical counter is four wheels behind one window, and drawing
 * it as one string would be drawing a display. When T-257 lands, this is the
 * shape the position is formatted into and nothing about the drawing moves.
 */
const COUNTER_AT_REST = ["0", "0", "0", "0"] as const;

/** The counter's digits, as a fraction of the object's width. Smaller than
 *  anything a person wrote on it: it is stamped on a wheel the size of a
 *  fingernail. */
const DIGIT_SIZE = 0.032;

/** The case number's size, as a fraction of the object's width. */
const NUMBER_SIZE = 0.055;
/** The extracted title's. Biggest of the three, because on a case file it is
 *  the one line that says what the evidence actually is. */
const TITLE_SIZE = 0.058;
/** And the rest, which is the runtime, the page count and the caption. */
const CASE_TEXT_SIZE = 0.048;
/**
 * The sticker's, and the smallest type on any of these objects — a little under
 * half the runtime beside it (T-334).
 *
 * A fraction of the object's width like every other line on these three, for
 * `transform`'s reason: an object scaled up is a bigger object rather than one
 * with bigger writing on it.
 *
 * **The number is a cassette's, and the VHS wears whatever comes of it.** A
 * compact cassette's J-card runs to 82% of the face and its capstan cutouts
 * start at 91%, so there is one nine-per-cent strip to put a label in and no
 * second option; a VHS has the whole top right of its lip to spend. So this is
 * settled by the object with no room and the one with room takes the same
 * number, which is how every other size on these three was arrived at too.
 *
 * The strip is nine per cent and the sticker is six and a third of it, *turned*
 * — the tilt widens the box it needs, which is the term the first version of
 * `tests/case-sticker-css.test.ts` left out and a driven run found: at 0.026 the
 * label came out touching the cutouts at 90.9% while the arithmetic said 90.
 */
export const STICKER_SIZE = 0.023;
/**
 * What it says, in the two words the human asked for (T-334). Upper case in the
 * markup rather than by `text-transform`, because it is a stock label that was
 * printed this way rather than a sentence this board is shouting.
 */
const NO_TRANSCRIPT = "NO TRANSCRIPT";

/**
 * Text runs, back into lines.
 *
 * Rust hands back a run and the box it was set in, and Q-198 chose to *re-set*
 * the text rather than reproduce the page — so the boxes are used for the one
 * thing they are still needed for, which is working out where the line breaks
 * were, and then thrown away. Reproducing the boxes would be a facsimile with
 * extra steps, and the whole argument for this feature is that a document should
 * look like it belongs on this wall rather than like a viewer embedded in it.
 *
 * A new line when the baseline moves by more than half a line: half, because
 * superscripts, footnote marks and a mid-line font change all shift `y` a little
 * and none of them is a line break.
 *
 * Runs arrive in content-stream order, which is *usually* reading order and is
 * not guaranteed to be — a two-column page can interleave. That is a known limit
 * of the extractor rather than of this function, and it is one T-297 already
 * lists.
 */
export function linesOfRuns(runs: readonly TextRun[]): string {
  return linesWithY(runs)
    .map((line) => line.text)
    .join("\n");
}

/** One re-set line, and the baseline it came off — points from the page's top. */
interface Line {
  readonly text: string;
  readonly y: number;
}

/**
 * The same lines, each still knowing where on the page it was.
 *
 * The `y` is kept for one caller and one purpose: putting a figure back among
 * the text at the point it was read at (T-329). Everything else about the boxes
 * is still thrown away, and this is deliberately not exported — a second
 * consumer of line positions would be the facsimile Q-198 refused, arriving one
 * function at a time.
 */
function linesWithY(runs: readonly TextRun[]): Line[] {
  if (runs.length === 0) return [];
  const lines: Line[] = [];
  let text = "";
  // The **line's** baseline and the tallest thing set on it — not the run
  // before, which is a bug a test caught rather than a refinement. A footnote
  // mark is a 7-unit run on a 12-unit line, so measuring the next run against
  // the mark's own height puts the threshold at 3.5 and breaks the line coming
  // back off it. A small run must not be able to narrow the gate behind itself.
  let lineY = runs[0]!.y;
  let lineHeight = runs[0]!.height;
  for (const [at, run] of runs.entries()) {
    if (at > 0) {
      const broke = Math.abs(run.y - lineY) > Math.max(1, lineHeight * 0.5);
      if (broke) {
        lines.push({ text, y: lineY });
        text = "";
        lineY = run.y;
        lineHeight = run.height;
      } else {
        // A run that continues a line still needs a gap unless one end already
        // has one: a PDF splits a line at every font and kerning change, and
        // joining them bare runs the words together.
        text += /\s$/.test(text) || /^\s/.test(run.text) ? "" : " ";
        lineHeight = Math.max(lineHeight, run.height);
      }
    }
    text += run.text;
  }
  lines.push({ text, y: lineY });
  return lines;
}

/**
 * One thing on a re-typeset page, in the order somebody reads it — T-329, Q-289.
 *
 * ## Why a figure is in the flow and not at its box
 *
 * Q-198 chose to re-set a page rather than reproduce it, so by the time this
 * runs *nothing* on the sheet stands where the PDF put it: the lines have been
 * poured onto our paper at our measure in our hand. A figure pinned to its own
 * page box would be the one element on that sheet still claiming the original
 * geometry — a half-facsimile — and it would come down on top of lines that are
 * not the lines it covered, because those lines have moved.
 *
 * So the figure is re-flowed with everything else, at the point in the reading
 * where it was: after the last line above it, before the first line below it. A
 * caption stays with its figure, which is the thing that actually has to
 * survive, and nothing is ever hidden by anything.
 *
 * **Ordered by the figure's top edge**, so "everything that started above this
 * picture comes before it" is the whole rule. A figure with text set beside it
 * has that text after it rather than alongside — one column is what a re-set
 * page is, and side-by-side would be the original geometry again.
 *
 * The price is that a full page of text carrying a figure can now run past the
 * foot of the sheet, where before only the text could. That is the rule
 * `.leaf-body` already states — a page holds a page, and what does not fit is
 * the pagination being wrong — and a figure has to clear `FIGURE_COVERAGE` to
 * be here at all, so a page carrying one has that much less text on it.
 */
export type PageBlock =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "figure";
      /** Its index in `figures`, which is what names its bytes: `figureUrls` is
       *  index for index with that list and so is `documentPageImage`. */
      readonly at: number;
      readonly figure: PageFigure;
    };

export function pageBlocks(
  runs: readonly TextRun[],
  figures: readonly PageFigure[],
): PageBlock[] {
  const lines = linesWithY(runs);
  // Content-stream order is not top-to-bottom order — a figure drawn last can
  // sit at the head of the page — and reading order is what this is building.
  const order = figures
    .map((figure, at) => ({ figure, at }))
    .sort((one, two) => one.figure.y - two.figure.y);

  const blocks: PageBlock[] = [];
  let from = 0;
  const upTo = (y: number): void => {
    let to = from;
    while (to < lines.length && lines[to]!.y < y) to++;
    if (to > from) {
      blocks.push({ kind: "text", text: lines.slice(from, to).map((line) => line.text).join("\n") });
      from = to;
    }
  };

  for (const { figure, at } of order) {
    upTo(figure.y);
    blocks.push({ kind: "figure", at, figure });
  }
  upTo(Infinity);
  return blocks;
}

/**
 * A typed page onto the sheet — its lines, and any figure among them (T-329).
 *
 * **A page with no figures is written exactly as it was before they existed**,
 * straight onto the body with `writeHand`'s own guard in front of it. That is
 * not a shortcut kept for its own sake: it is the overwhelmingly common page,
 * and the alternative was giving every page in every filing a wrapper element
 * it has no use for so that this function could have one shape.
 *
 * The body is emptied before a page carrying figures is built, and before a
 * plain one that is replacing such a page — `writeHand` recognises text it has
 * already written by a key on the host, and the host of a page with figures on
 * it holds children that key knows nothing about.
 */
function writePage(
  body: HTMLElement,
  runs: readonly TextRun[],
  figures: readonly PageFigure[],
  urls: readonly (string | null)[],
  seed: number,
  pageWidth: number,
): void {
  if (figures.length === 0) {
    if (body.firstElementChild !== null) clearHand(body);
    writeHand(body, linesOfRuns(runs), seed, true);
    return;
  }

  clearHand(body);
  const measure = measureOf(runs, pageWidth);
  for (const block of pageBlocks(runs, figures)) {
    if (block.kind === "text") {
      const lines = document.createElement("div");
      lines.className = "leaf-lines";
      writeHand(lines, block.text, seed, true);
      body.append(lines);
      continue;
    }
    body.append(...figureNodes(block.figure, urls[block.at] ?? null, measure));
  }
}

/**
 * One figure, at the width it had on the page it came off.
 *
 * The width is a fraction of the **measure** — the text's own left and right
 * edges on the original page — and not of the page's width, which was the first
 * attempt and is wrong by the margins. A chart set to the full width of the type
 * area is a chart that reaches both margins, and mapping it through the page's
 * width instead draws it at around three quarters of our measure, visibly short
 * of the text it sits between. The measure is derived from the runs rather than
 * guessed at, and clamped at 1 for a figure wider than the text it was set with.
 *
 * The height is an `aspect-ratio` rather than a second mapping. Points to sheet
 * vertically would be a second arithmetic with a second way to be wrong, and
 * the only thing a picture actually owes is its own proportions.
 *
 * A figure with no bytes still gets its box and says why — `document.rs`
 * reports a figure it could not lift rather than dropping it, and dropping it
 * *here* instead would be the same silence one module further along. A blank
 * space where an exhibit was is the failure this whole union exists to stop.
 *
 * **The sentence is a sibling of the box and not inside it**, which is why this
 * hands back a list. Inside was the first version and it does not keep the
 * promise: a figure only has to cover 2% of the page to be lifted, so a tall
 * narrow one — a portrait photograph, a column chart — is a box some 45 px wide
 * on the sheet, and a sentence of sixty characters in it is either cut off or
 * forty lines long. As a sibling it is set at the measure, under the box, which
 * is where a caption goes anyway.
 */
function figureNodes(figure: PageFigure, url: string | null, measure: number): HTMLElement[] {
  const el = document.createElement("div");
  el.className = "leaf-figure";
  el.style.width = `${(measure > 0 ? Math.min(1, figure.width / measure) * 100 : 100).toFixed(2)}%`;
  if (figure.width > 0 && figure.height > 0) {
    el.style.aspectRatio = `${figure.width} / ${figure.height}`;
  }

  if (figure.content.kind === "image" && url !== null) {
    el.dataset["figure"] = "image";
    const image = document.createElement("img");
    image.className = "leaf-figure-image";
    image.alt = "";
    image.src = url;
    el.append(image);
    return [el];
  }

  el.dataset["figure"] = figure.content.kind === "unsupported" ? "unsupported" : "unreadable";
  const note = document.createElement("div");
  note.className = "leaf-figure-note";
  // The shell's own sentence where there is one — "the figure is written inline
  // in the page's content stream, which this build does not lift" — because it
  // names what stopped it and a generic one does not. The other arm is a figure
  // this build *can* read whose bytes did not come back.
  note.textContent =
    figure.content.kind === "unsupported"
      ? figure.content.reason
      : "this figure could not be read";
  return [el, note];
}

/**
 * The width of the type area on the page these runs came off, in points.
 *
 * **Not simply the widest line that happens to be on it**, which was the first
 * version and is wrong on any page whose text is short. Driven against a page
 * carrying one line of caption in Courier, the widest run reached 350 pt of a
 * 451 pt type area — so every figure on it came out 29% wider than it was, and
 * a tall one at that width ran off the foot of the sheet.
 *
 * So the margin is what is measured, and the type area is derived from it: a
 * page's margins are symmetric by the convention every producer follows, so
 * `page - 2 x left` is the width the text *could* have used. The observed right
 * edge still wins where it is wider, which covers the page that breaks the
 * convention by running long into a narrow right margin.
 *
 * Zero for runs that carry no boxes at all, which is a caller's cue to fall
 * back rather than divide by it. Runs of zero width are skipped: a run with no
 * box contributes no edge, and one at x=0 would otherwise drag the left margin
 * to the corner of the page.
 */
function measureOf(runs: readonly TextRun[], pageWidth: number): number {
  let left = Infinity;
  let right = -Infinity;
  for (const run of runs) {
    if (run.width <= 0) continue;
    left = Math.min(left, run.x);
    right = Math.max(right, run.x + run.width);
  }
  if (!(right > left)) return 0;
  return Math.max(right - left, pageWidth - 2 * left);
}


/** How much of a folder's width the gummed label may take, inside its own
 *  padding — the number `items.css` writes, here as well because `fitLabel`
 *  needs the box the name has to fit in. */
const LABEL_WIDTH = 0.4;
/**
 * How much of a VHS's width the clipped print takes, border and all — the
 * number `items.css` writes, here as well because the still is asked for at the
 * size it will be *drawn*, and `variantFor` reads a pixel count.
 *
 * Two authors for one number is what the folder's `--kraft-top` was written to
 * stop, and this is the case that cannot use that fix: the stylesheet needs it
 * as a percentage of an element and the resolver needs it as a fraction of a
 * screen width, which is one value asked for in two languages. The stylesheet
 * test asserts they agree.
 */
export const PRINT_W = 0.19;

export class DomItemLayer implements ItemLayer {
  private readonly host: HTMLElement;
  private readonly assetUrl: AssetResolver;
  /** What the document says an asset is — see [`AssetFacts`] for why this is a
   *  second resolver rather than more fields on the first. */
  private readonly assetFacts: AssetLookup;
  private readonly views = new Map<string, View>();
  private readonly pool: Record<Archetype, View[]> = {
    polaroid: [],
    paper: [],
    folder: [],
    vhs: [],
    cassette: [],
    card: [],
  };

  /**
   * The caret, when there is one (T-179). Null when the layer was built with no
   * hooks — a headless test, or the spike harness — and `edit` is then a no-op
   * rather than a crash.
   */
  private readonly editor: TextEditor | null;
  /** The view holding the field, so the previous one can be told to let go. */
  private editorView: View | null = null;

  /**
   * The one player, and the view holding it — T-277, and the caret's shape one
   * object along (`deck.ts` says why it is one element rather than one per
   * cassette).
   *
   * Built unconditionally, unlike the editor: a deck with nothing playing owns
   * a detached `<audio>` and costs nothing, and there is no hooks argument to be
   * absent — where the caret has to tell somebody what was typed, this only ever
   * writes back onto a view this layer already owns.
   */
  private readonly deck = new Deck({
    onMoved: (itemId, reeled) => this.views.get(itemId)?.setReeled(reeled),
    onLetGo: (itemId) => this.views.get(itemId)?.setReeled(0),
  });
  private deckView: View | null = null;

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

  /**
   * How much of an item to draw (`render/lod.ts`, DESIGN section 6.6).
   *
   * `full` until told otherwise, which is wrong in the cheap direction for the
   * reason `rasterScale` is: a layer nobody wires up draws everything, and a
   * headless test gets the whole item without having to ask.
   */
  private tier: Tier = "full";

  /**
   * Items mounted coarsely and owed their detail (T-202).
   *
   * An item that arrives *because the camera moved* is drawn as a card whatever
   * the zoom, and upgraded when the camera stops. See [`COARSE`] for why, and
   * [`settled`] for when the debt is paid.
   */
  private readonly coarse = new Set<string>();

  /** Whether a settle has happened and the debt above is due. */
  private upgradeWanted = false;


  /**
   * How old the board says each item is (`wear.ts`).
   *
   * [`NO_AGEING`] until told otherwise, which is the right default twice over: a
   * layer nobody wires up draws a new board, and a headless test gets no ageing
   * without having to say so.
   */
  private ageDays: AgeClock = NO_AGEING;

  /**
   * The scale ink rasters at — DESIGN section 6.6's "ink renders at quarter
   * resolution" below 35%.
   *
   * A quarter of the *linear* scale, so a sixteenth of the pixels, which is what
   * makes it worth saying: an annotated photograph's canvas is sized from this
   * and the backing store rounds up to a power of two, so the tier is the
   * difference between a 2048-square bitmap and a 128-square one. Ink is a
   * bitmap and not a layout, so unlike everything else the tier changes this one
   * really is about device pixels — hence a factor on `rasterScale` rather than
   * a second rule of its own.
   *
   * There is no second reduction below this one, and no second tier to hang one
   * on (Q-121): at the camera's floor a quarter-scale canvas for a 300-unit
   * photograph is already eleven pixels across, so there is nothing left to win.
   */
  private get inkScale(): number {
    return this.tier === "full" ? this.rasterScale : this.rasterScale / 4;
  }

  /** Reused by `hitTest`, which walks the paint order on every pointer move. */
  private readonly probe: Point = { x: 0, y: 0 };

  /**
   * Each sheet's silhouette, resolved into its own coordinates — see
   * [`silhouette`].
   *
   * Bounded by the document rather than growing: one entry per item that a pen
   * or a pointer has been over, and cleared with `order` when the document
   * underneath is replaced.
   */
  private readonly edges = new Map<string, Silhouette>();

  /** Reused by the curl pass, for the same reason: one per frame, not one per
   *  sheet in the viewport. */
  private readonly corners = new Float32Array(CURL_PROPS.length);
  private readonly faces = new Float32Array(FACE_PROPS.length);

  /**
   * Items whose ink canvas is out of date, waiting for the INK phase.
   *
   * This layer's, not the dirty sets'. `dirty.ink` is cleared at the end of
   * every frame (phase 9) and a re-raster deliberately may not finish in one —
   * see [`paintInk`] for the budget and why it exists.
   */
  private readonly inkPending = new Set<string>();

  /**
   * Items whose photograph has been on this screen, so it does not develop
   * again — see [`FirstSight`].
   *
   * The layer holds it because the layer is the thing that outlives both a view
   * and a mount: pooling recycles the node and culling remounts the item, and
   * this has to survive both. It is not local *asset* state either, which is
   * `state/assets.ts` and is keyed by hash — this is a fact about a window, and
   * the second window on the same board is quite correctly still to see any of
   * these come up.
   *
   * It grows by one string per photograph the person has looked at and is
   * dropped whole when the layer is, which is when the document under it is
   * replaced — at which point the ids stop meaning anything anyway.
   */
  private readonly developed = new Set<string>();

  /** [`FirstSight`], bound once so every view can be built with it. */
  private readonly firstSight: FirstSight = (itemId) => {
    if (this.developed.has(itemId)) return false;
    this.developed.add(itemId);
    return true;
  };

  /**
   * `assetFacts` defaults to answering [`NO_FACTS`], which draws every item with
   * an asset as a photograph. That is the right answer for a caller with no
   * document behind it — the spike rig, and most of the tests in this
   * directory — and it fails loudly rather than quietly for one that needs it:
   * an object that should be a folder comes up as a frame around nothing.
   */
  constructor(
    host: HTMLElement,
    assetUrl: AssetResolver,
    assetFacts: AssetLookup = () => NO_FACTS,
    editor?: ItemEditorHooks,
    pageOf: PageResolver = () => null,
    shownPage: ShownPage = () => null,
  ) {
    this.host = host;
    this.assetUrl = assetUrl;
    this.assetFacts = assetFacts;
    this.editor = editor ? new TextEditor(editor) : null;
    this.pageOf = pageOf;
    this.shownPage = shownPage;
  }

  /**
   * Which page of a case file is the face on show — T-278, and the same
   * function the pen is handed (`state/tools/tool.ts`'s `ToolContext`).
   *
   * The same one deliberately. What a mark is filed against and what is drawn
   * have to be one answer, or ink lands on a page and reappears on another.
   *
   * Defaults to "nothing is open", which is right for every caller with no shell
   * behind it — the spike rig, and the tests in this directory, where a folder
   * has no reader and its ink is all on the object.
   */
  private readonly shownPage: ShownPage;

  /**
   * The page open on a case file — T-320. Defaults to "nothing is open", which
   * is the right answer for every caller that has no shell behind it: the spike
   * rig and most of the tests here, where a folder draws its paper and nothing
   * is set on it.
   */
  private readonly pageOf: PageResolver;

  get mounted(): number {
    return this.views.size;
  }

  /**
   * Draw the mounted items into a canvas at an export camera — see `view.ts`
   * for what this is and D-37 for why it is here rather than in `app/`.
   *
   * Everything below is a lookup: the ranking this layer already computed for
   * `z-index`, the node each view already owns, and the drawn pose off the
   * scene's own readers. `renderX`/`renderY`/`renderRot` and not the fields
   * behind them — the swing is part of where an item *is* (T-177), and an
   * export that read `rot` would put every hanging item back at the angle it
   * was drawn at before it settled.
   *
   * Items with no slot are skipped rather than drawn at the origin. That is a
   * view mounted for an item the scene has since dropped — a delete arriving on
   * a merge between the pose and the draw — and a pile of sheets at 0,0 is a
   * worse answer to it than a board without them.
   */
  async rasterise(
    scene: Scene,
    ctx: CanvasRenderingContext2D,
    camera: RasterCamera,
  ): Promise<RasterReport> {
    const css = await exportStylesheet();
    const items: RasterItem[] = [];
    for (const [id, view] of this.views) {
      const slot = scene.slotOf(id);
      const pose = scene.poseOf(id);
      if (slot === undefined || pose === null) continue;
      items.push({
        id,
        el: view.el,
        rank: this.rank.get(id) ?? 0,
        x: scene.renderX(slot),
        y: scene.renderY(slot),
        rot: scene.renderRot(slot),
        w: pose.w,
        h: pose.h,
      });
    }
    return rasteriseItems(items, ctx, camera, css);
  }

  /**
   * One item, square on in its own frame — the clipping painter (T-282).
   *
   * `rot: 0` and a centre at the origin are what make the frame item-local:
   * `rasteriseItems` translates to the centre, turns by `rot` and then scales,
   * so zeroing both leaves the item's own axes lying along the canvas's. A
   * local point `(lx, ly)` then lands at `((lx - camera.x) * zoom, (ly -
   * camera.y) * zoom)`, which is what lets the caller size a canvas to a
   * rectangle it measured on the page and have that rectangle fill it exactly.
   *
   * The item's **own** `w`/`h` and not its bounds, because the clone is drawn
   * from its centre. And the stylesheet is fetched per call rather than cached:
   * a clipping is one gesture by one hand, where an export is three hundred
   * items in a row, so the 52 kB is paid once either way and a cache here would
   * be a font that could go stale behind a live reload.
   */
  async rasteriseInFrame(
    scene: Scene,
    itemId: string,
    ctx: CanvasRenderingContext2D,
    camera: RasterCamera,
  ): Promise<RasterReport> {
    const view = this.views.get(itemId);
    const pose = scene.poseOf(itemId);
    // Nothing mounted: culled, deleted, or never bound. There is no
    // presentation to photograph, and an empty report says exactly that.
    if (view === undefined || pose === null) {
      return { items: 0, drawn: 0, inlined: 0, unreadable: 0, bytes: 0, inked: 0 };
    }
    const css = await exportStylesheet();
    const item: RasterItem = {
      id: itemId,
      el: view.el,
      rank: 0,
      x: 0,
      y: 0,
      rot: 0,
      w: pose.w,
      h: pose.h,
    };
    return rasteriseItems([item], ctx, camera, css);
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
        // And an open case file that has been turned to another page — T-278.
        // The ink on it changed without a stroke being written, which is a thing
        // no other surface on this board can do. It reaches here because the
        // reader dirties every item wearing the document when the page lands
        // (`app/main.ts`), so this costs one comparison on an item that was
        // going to be looked at anyway.
        else if (scene.hasInk(id) && view.ink.stalePage(this.shownPage(id))) this.inkPending.add(id);
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
      // The sheet's outline goes with it: committed ink stops at the paper, not
      // at the rectangle (T-186), and it is the *same* polygon the pen tested
      // and the wet stroke was clipped to.
      // The face that is showing, and nothing on the other faces — T-278. The
      // silhouette below moves with it: an open folder's writable paper is the
      // sheet standing in it rather than the kraft round the sheet, so the same
      // call that picks the strokes picks what they are clipped to.
      const page = this.shownPage(id);
      view.ink.update(
        scene.strokesOn(id, page),
        this.inkScale,
        scene.w[slot]!,
        scene.h[slot]!,
        this.silhouette(scene, id, slot),
        page,
      );
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
   * Which item is making a sound — T-277, and the question D-50's exemption
   * asks. Null when nothing is playing, including a cassette paused half way
   * through.
   */
  get playing(): string | null {
    return this.deck.playing;
  }

  /**
   * Press play on this cassette, or press it again to stop. Answers whether it
   * is now playing.
   *
   * The URL comes from the caller for the reason the CRT's does (`app/main.ts`,
   * `filmFor`): asking to *hear* something is a stronger claim on an asset than
   * this layer's own resolver makes when it draws an object, and the want that
   * goes with it belongs beside the record rather than in the renderer.
   */
  hear(itemId: string, url: string): boolean {
    const playing = this.deck.press(itemId, url);
    this.parkDeck();
    return playing;
  }

  /** Stop, and let the recording go — the tape comes out of the machine. */
  hush(): void {
    this.deck.stop();
    this.parkDeck();
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

  /**
   * Put the deck's element on the view the playing item currently has — T-277.
   *
   * `parkEditor`'s twin, for the same reason word for word: views are pooled,
   * so "the view for this item" is a question that has to be re-asked on every
   * DOM phase, and an element left where it was is inherited by whatever mounts
   * next out of the pool.
   *
   * The difference is what happens when the item has **no** view. The field is
   * simply removed from the document — a caret with nothing to sit in is a
   * caret that has gone away — and taking the audio element out likewise stops
   * the sound, because a media element removed from a document is paused
   * (D-48). That is why the culler exempts a playing item (D-50): so this arm
   * is reached only when the sound has already stopped, or when the item itself
   * has gone.
   */
  private parkDeck(): void {
    const id = this.deck.loaded;
    const view = id === null ? undefined : this.views.get(id);
    if (this.deckView && this.deckView !== view) this.deckView.hold(null);
    this.deckView = view ?? null;
    if (view) {
      view.hold(this.deck.element);
      // Where the tape is, said again — a view fresh out of the pool was
      // released and reads rewound, and `timeupdate` will not fire for a
      // cassette that is sitting paused to correct it.
      view.setReeled(this.deck.reeled);
    } else {
      this.deck.element.remove();
    }
  }

  sync(scene: Scene, dirty: DirtySets, visible: ReadonlySet<string> | null): void {
    // Ahead of the clean-frame guard, and that is not an oversight. A camera that
    // has come to rest produces clean frames — that is what resting is — so an
    // upgrade that waited for a dirty one would wait for somebody to touch the
    // board, and the items that mounted during the gesture would sit there as
    // cards until they did.
    if (this.upgradeWanted) this.payTheDetailDebt(scene);
    if (dirty.isClean) return;
    /**
     * Is this frame's mounting a storm?
     *
     * `dirty.zoomed`, and specifically **not** `dirty.camera`. A zoom changes how
     * many items are on screen by orders of magnitude — the flight from 100% to
     * 5% mounts five hundred in about seventy frames — while a hand-speed pan
     * mounts well under one a frame however far it goes, and `pan at 100%` was
     * already inside budget with nothing done to it at all.
     *
     * So a pan's handful arrive in full, and nothing about a note changes because
     * somebody moved sideways. A count was tried instead and cannot separate the
     * two: three a frame over seventy frames is two hundred and fifty full
     * mounts, which put the worst frame back from 41.7 ms to 125.
     *
     * It is also the line DESIGN 6.6 is already drawn on. How much of an item is
     * drawn is a question about zoom; a pan has never been allowed to change it.
     *
     * A mount on a still camera — a paste, a peer's create, an undo — is one item
     * and arrives in full, which is what stops a pasted note sitting there
     * without its grain until somebody happens to zoom.
     */
    const storm = dirty.zoomed;

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
    /**
     * And the cassette that is playing — D-50, the second exemption, and the
     * one the ADR says turns this from a special case into a list.
     *
     * The same sentence as the one above with two words changed: unmounting it
     * would pull a media element out of the document, and a media element
     * removed from the document is **paused** by the user agent (HTML
     * 4.8.11.15, measured in D-48). Panning away from the recording you were
     * listening to would stop it, and panning back would not start it again —
     * the element comes back paused and nothing in the application knows to
     * press play.
     *
     * *Playing*, not loaded: a cassette paused half way through is an ordinary
     * item, may be culled like any other, and loses nothing by it — the
     * position is on the deck's element, which never goes into the pool.
     */
    const sounding = this.deck.playing;

    // Unmount anything that left the scene or the viewport.
    for (const [id, view] of this.views) {
      if ((wanted.has(id) || id === writing || id === sounding) && scene.has(id)) continue;
      // A recording whose *item* has gone — deleted here, or deleted by a peer
      // mid-sentence — stops, because there is no longer an object making the
      // sound. A cassette merely culled keeps its recording loaded and its
      // position, both of which live on the deck's element rather than on the
      // node being pooled; `release` takes the element back out, and pressing
      // play again picks up where it was.
      if (id === this.deck.loaded && !scene.has(id)) this.hush();
      view.release();
      view.el.remove();
      this.pool[view.archetype].push(view);
      this.views.delete(id);
      // An item culled before its upgrade arrived owes nothing: it will mount
      // coarsely again next time, and a stale id here would upgrade whoever
      // inherits the name.
      this.coarse.delete(id);
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

    /**
     * Does anything's curl need re-asking?
     *
     * Not on a pure camera move, which is the frame this skips: panning changes
     * nothing about which pins hold which sheets. Everything else does, and it
     * cannot be narrowed to the dirty items themselves. A pin dragged onto a
     * still note touches only `dirty.pins`; a *parented* pin carried over a
     * second note by the item it belongs to touches neither that note nor any
     * pin, because nothing about either of them was written. The only honest
     * answer is that a board where an item or a pin moved has to re-ask for
     * everything on the screen — which is a set lookup and, for the sheets that
     * have a pin at all, a handful of arithmetic (`curl.ts`).
     */
    const recurl = dirty.all || dirty.items.size > 0 || dirty.pins.size > 0;

    for (const id of wanted) this.place(scene, dirty, id, recurl, storm);
    // And the note being written on, if the culler had left it out. Never
    // coarsely: it has a caret in it, so somebody is looking at it closely.
    if (writing !== null && !wanted.has(writing)) this.place(scene, dirty, writing, recurl, false);
    // And the cassette that is playing, on the same argument and one weaker
    // detail: nobody is necessarily *looking* at it, so it may mount coarsely
    // like any other off-screen item. What it may not do is not mount at all.
    if (sounding !== null && !wanted.has(sounding) && sounding !== writing) {
      this.place(scene, dirty, sounding, recurl, storm);
    }

    // Last, so it sees this frame's mounts: a note that has just come back into
    // the viewport has a different view from the one it left with.
    this.parkEditor();
    // And the recording, which has the same problem for the same reason — plus
    // one of its own: a view that has just come back out of the pool was
    // released, and a released view reads rewound until it is told otherwise.
    this.parkDeck();

    // `scene.size`, not `views.size`: the order covers the board, so what
    // invalidates it is an item arriving or leaving the board, never the
    // viewport. This is the comparison that used to make a pan re-sort.
    if (orderChanged || this.order.length !== scene.size) this.reorder(scene);
  }

  /** Mount `id` if it is not mounted, and write its transform if it moved. */
  private place(
    scene: Scene,
    dirty: DirtySets,
    id: string,
    recurl: boolean,
    storm: boolean,
  ): void {
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
    // Asked once, here, and carried into the bind — because the two questions
    // it answers are on either side of the mount. Which face this item wears is
    // a fact about the *mime*, so the archetype cannot be chosen without it; and
    // what is written on that face is a fact about the rest of the record, which
    // is the same lookup and would otherwise be a second one.
    const facts = cold.assetId ? this.assetFacts(cold.assetId) : NO_FACTS;
    const archetype = archetypeOf(cold, facts.kind);

    if (view && view.archetype !== archetype) {
      // A type is immutable after creation, so this used to mean a peer had
      // written something strange. It has an ordinary cause now as well: the
      // face comes off the asset record, and on a peer merging a board the
      // record can land a beat after the item that names it — so an object
      // arrives as a photograph of nothing and becomes a folder when its record
      // does. Swapping is exactly the right response to both.
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
      /**
       * A mount during a camera move is drawn as a card whatever the zoom, and
       * owes its detail to the next settle (T-202, [`COARSE`]).
       *
       * `isNew && storm` and not `storm` alone: an item already on screen that
       * merely moved must not lose its grain because the camera happened to move
       * on the same frame — a drag does that on every frame of itself.
       */
      const coarsely = isNew && storm && this.tier === "full";
      if (coarsely) {
        this.coarse.add(id);
        view.el.classList.add(COARSE);
      } else if (this.coarse.delete(id)) {
        // Rebound at full detail by something else — a `dirty.all` from a tier
        // change, most often — so the debt is settled and the marker goes.
        view.el.classList.remove(COARSE);
      }
      // The longest edge this item is about to occupy, in device pixels. What
      // the resolver does with it is the resolver's business.
      const screenPx = Math.max(scene.w[slot]!, scene.h[slot]!) * this.rasterScale;
      view.bind(
        cold,
        facts,
        this.assetUrl,
        screenPx,
        wearOf(cold.seed, this.ageDays(cold)),
        coarsely || this.tier !== "full",
      );
      // The same text the static node just took, offered to the caret as well
      // — this is how a peer's typing reaches an open field (T-180). It is a
      // string comparison for the local echo, which is every other case.
      if (this.editor?.itemId === id) this.editor.receive(cold.text);
      const open = scene.openOf(slot);
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
        // Off the scene's own reader, like the three above it and for the same
        // reason: this is a drawn transient and nothing about it is in the
        // document, so an item's own record cannot answer it (T-319).
        open,
      );
      // The page, and **only for the item that is actually open** — so a
      // document costs what a document costs once, rather than once per folder
      // on a board of them. `null` puts a view back to bare paper, which is what
      // a folder being shut has to do or the next one opened inherits the last
      // one's page.
      view.setPage(open > 0 && cold.assetId ? this.pageOf(cold.assetId) : null);
    }

    // After the transform, not before: `cornerCurl` reads the pose the sheet is
    // drawn at, and a mount that has not been positioned yet is at the origin.
    // `isNew` is in here because a sheet that has just come back into the
    // viewport has never been told, whatever the dirty sets say.
    if (recurl || isNew) {
      // One question, two answers off it. Nothing pinned is taped (`tape.ts`),
      // and a taped corner does not curl (`curl.ts`) — so asking twice would be
      // two chances to disagree about the same sheet.
      const taped = tapeOf(cold, scene.pinCount(id));
      view.setTape(cold.seed, taped);
      // `view.folded` and not a second `dogEarOf`, for the reason directly above:
      // the bind a few lines up has already decided whether this sheet has a fold
      // and where, and asking again would be a second chance to disagree about
      // the one corner the two marks share (`curl.ts`).
      cornerCurl(scene, id, slot, taped, view.folded, this.corners);
      cornerFace(scene.renderRot(slot), this.corners, this.faces);
      view.setCurl(this.corners, this.faces);
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
    return this.walk(scene, boardX, boardY, false);
  }

  /**
   * The same walk, stopping at the **paper** rather than at the rectangle — what
   * a pen is over (T-186, Q-149).
   *
   * ## Why this is a second walk and not a filter on the first
   *
   * The obvious build is to call `hitTest` and then reject its answer when the
   * point turns out to be in the strip a torn edge gave up. That is wrong, and
   * quietly: Q-149's rule is "inside the rectangle but outside the silhouette
   * reads as **the surface below**", and the surface below is very often another
   * item rather than the cork. A photograph tucked under the torn head of a
   * legal pad is exactly the arrangement this board is for. So the walk has to
   * *carry on* past a rejected candidate, which is something only the walk can
   * do.
   *
   * ## And why the grab test does not do this
   *
   * Q-149 chose the pen alone. A grab target wants to be forgiving and a mark
   * wants to land where you can see paper — so a 1-3 px band round every note,
   * and up to 9 along one side of a legal pad, stays clickable and draggable
   * while no longer taking ink. The two therefore **disagree**, deliberately,
   * and `state/tools/marker.ts` says where.
   *
   * ## The tier may not reach this
   *
   * `PaperView.bind` drops the `clip-path` entirely below 35% zoom, because a
   * wander of under a pixel is not worth a twenty-point polygon per sheet. This
   * boundary does not follow it. If it did, the same gesture over the same spot
   * would file ink on the item at 100% and on the cork at 30% — a document that
   * depends on how far out the camera happened to be.
   */
  inkHitTest(scene: Scene, boardX: number, boardY: number): string | null {
    return this.walk(scene, boardX, boardY, true);
  }

  private walk(
    scene: Scene,
    boardX: number,
    boardY: number,
    toTheSilhouette: boolean,
  ): string | null {
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
      if (Math.abs(local.x) > scene.w[slot]! / 2 || Math.abs(local.y) > scene.h[slot]! / 2) {
        continue;
      }
      // Only ever asked of a candidate the rectangle has already accepted, which
      // is what keeps a polygon test off the hot path: a pointer move tests one
      // or two, not the whole board.
      if (toTheSilhouette) {
        const paper = this.silhouette(scene, id, slot);
        if (paper !== null && !insideEdge(paper.points, paper.n, local.x, local.y)) continue;
      }
      return id;
    }
    return null;
  }

  /**
   * An item's silhouette in its own coordinates, or null when it has none.
   *
   * Null is a **photograph**, and it means the rectangle stands: a polaroid is a
   * machine-cut border and `PolaroidView` has never asked `edge.ts` for
   * anything. It is not "no answer" — it is the answer.
   *
   * Cached per item, keyed on everything the polygon is a function of. The
   * marker asks this per *sample* of a stroke (T-137's crossing rule re-asks
   * "what am I over" every time), so recomputing a twenty-vertex seeded walk
   * each time would put trigonometry under the pen. Rebuilt when the cold
   * record, the wear or the sheet's size changes, and that is the whole of the
   * invalidation because those are the only things it depends on.
   */
  silhouetteOf(scene: Scene, id: string): Silhouette | null {
    const slot = scene.slotOf(id);
    return slot === undefined ? null : this.silhouette(scene, id, slot);
  }

  private silhouette(scene: Scene, id: string, slot: number): Silhouette | null {
    const cold = scene.coldAt(slot);
    // An open case file is showing paper rather than kraft, and the paper is
    // what a mark is allowed to sit on — T-278. It comes before the archetype
    // test below because a folder fails that test: nothing with a file behind it
    // is cut to a ragged edge, and this is not a ragged edge. It is a rectangle,
    // it is a different rectangle from the item's, and it is the only thing on
    // this board whose writable surface is smaller than what you can pick up in
    // both axes at once.
    if (cold !== null && scene.openOf(slot) > 0) return this.sheet(id, cold, slot, scene);
    // A sheet of paper is the only thing on this board with a silhouette. The
    // question is the *type* on its own and never the asset, which is why this
    // is the one caller that does not need a lookup: nothing with a file behind
    // it is cut to a ragged edge, and `archetypeOf` maps every non-`polaroid`
    // type to paper whatever kind is passed and whatever the record says about
    // where it came from.
    if (cold === null || archetypeOf(cold, "unknown") !== "paper") return null;
    const worn = Math.round(wearOf(cold.seed, this.ageDays(cold)) * 100) / 100;
    const w = scene.w[slot]!;
    const h = scene.h[slot]!;
    const held = this.edges.get(id);
    if (held && !held.open && held.cold === cold && held.worn === worn && held.w === w && held.h === h) {
      return held;
    }
    const edge = sheetEdgeOf(cold, worn);
    const n = edge.outline.length / 4;
    const fresh: Silhouette = {
      cold,
      worn,
      w,
      h,
      open: false,
      n,
      points: edgePoints(edge.outline, w, h, new Float32Array(n * 2)),
    };
    this.edges.set(id, fresh);
    return fresh;
  }

  /**
   * The sheet standing inside an open case file, as a silhouette — T-278.
   *
   * Four points and a rectangle, which is what makes it worth going through the
   * same cache and the same type as a torn sheet's twenty-vertex walk: all three
   * things that ask about writable paper — the pen's hit test, the wet stroke's
   * clip and the committed raster's — ask through one accessor, and a page that
   * answered any of them differently would be a mark that moved at pen-up.
   *
   * Anticlockwise from the top-left in the item's own unrotated frame, because
   * that is the frame ink is stored in and the frame `edgePoints` produces. The
   * size comes from `lib/objects.ts`, not from this file's own arithmetic — see
   * `openSheetOf` for why the two axes swap.
   */
  private sheet(id: string, cold: ItemCold, slot: number, scene: Scene): Silhouette {
    const w = scene.w[slot]!;
    const h = scene.h[slot]!;
    const held = this.edges.get(id);
    if (held && held.open && held.cold === cold && held.w === w && held.h === h) return held;
    const sheet = openSheetOf(w, h);
    const hx = sheet.w / 2;
    const hy = sheet.h / 2;
    const fresh: Silhouette = {
      cold,
      // No wear on it: a sheet's ragged edge is a property of the *stock*, and
      // this is a page of somebody's filing rather than a piece of the board's
      // own paper. Recorded as zero rather than left out so the cache key above
      // stays the shape every other entry has.
      worn: 0,
      w,
      h,
      open: true,
      n: 4,
      points: new Float32Array([-hx, -hy, hx, -hy, hx, hy, -hx, hy]),
    };
    this.edges.set(id, fresh);
    return fresh;
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

  /**
   * DESIGN section 6.6's tiers, and almost all of it is this one attribute.
   *
   * Written on the layer's **host** rather than on each item, so crossing a
   * boundary with five hundred items mounted is one attribute write and not five
   * hundred. `items.css` reads it — `[data-lod="card"] .paper-grain` and its
   * neighbours — which is what makes the flat card a stylesheet rather than a
   * second rendering path through this file.
   *
   * That the paper half needs no code here at all is a measurement rather than a
   * preference (D-33). Removing the decorative layers takes `hold 35%` from a
   * 222.2 ms worst frame to 7.1 ms with 500 items on screen, and it does so
   * without changing the tree: `display: none` leaves the node where it is, so
   * the pooling, the binding, the hit test and the ink canvas are all untouched.
   * What was costing was painting grain, tear, ageing, bend, wear, tape, the
   * silhouette `clip-path` and the sheet `filter` — five hundred times.
   *
   * Records the tier and writes the attribute; the caller raises the dirty pass,
   * exactly as it does for `setRasterScale`.
   */
  setTier(tier: Tier): void {
    if (tier === this.tier) return;
    const rising = DETAIL[tier] > DETAIL[this.tier];
    this.tier = tier;
    if (rising) {
      /**
       * Every mounted item now owes its detail, and must go on looking like a
       * card until its turn comes (T-203).
       *
       * The class is what holds it there. Taking `data-lod` off the host below
       * would otherwise give every sheet its grain and its tape back on this very
       * frame — CSS needs no rebind — and the whole point of the budget is that
       * they arrive a few at a time.
       */
      for (const [id, view] of this.views) {
        this.coarse.add(id);
        view.el.classList.add(COARSE);
      }
      this.upgradeWanted = this.coarse.size > 0;
    } else {
      // Falling. Every item is a card now by the tier alone, so nothing is owed
      // and the per-item marker would be a second thing saying the same thing.
      for (const id of this.coarse) this.views.get(id)?.el.classList.remove(COARSE);
      this.coarse.clear();
      this.upgradeWanted = false;
    }
    // Absent rather than `"full"` at the top tier, so a stylesheet that has
    // never heard of LOD — and every selector written before this existed —
    // goes on meaning what it meant.
    if (tier === "full") delete this.host.dataset["lod"];
    else this.host.dataset["lod"] = tier;
  }

  setAgeClock(clock: AgeClock): void {
    this.ageDays = clock;
  }

  /**
   * The camera has stopped, so the items that mounted cheaply during the move
   * can have their detail (T-202).
   *
   * Called on **every** settle and not only on a tier change, because most mount
   * storms cross no boundary at all: a pan at 100% mounts thirty items and stays
   * in the same tier throughout.
   *
   * Records only. The drain happens in the DOM phase, where writing is allowed.
   */
  settled(): void {
    if (this.coarse.size > 0) this.upgradeWanted = true;
  }

  /** How many items are drawn as cards while they wait for their detail. */
  get coarseCount(): number {
    return this.coarse.size;
  }

  /**
   * DOM phase (5), after the walk. Give the coarse items their detail.
   *
   * Deliberately **not** budgeted across frames, unlike `paintInk`. This runs on
   * a settled camera, on the frame the world subtree is repainting anyway — the
   * demote is queued for the end of this very phase (`World.flushDemote`) — so
   * the whole point is that everything upgrades *before* the one paint, rather
   * than dribbling in over the next six and repainting each time.
   *
   * If that turns out to be too much on one frame, the answer is a budget here
   * and it is a small change. It is not one to make before measuring, and D-33
   * has the numbers that would say.
   */
  private payTheDetailDebt(scene: Scene): void {
    if (this.coarse.size === 0) {
      this.upgradeWanted = false;
      return;
    }
    let left = UPGRADE_BUDGET;
    const done: string[] = [];
    for (const id of this.coarse) {
      if (left <= 0) break;
      left -= 1;
      done.push(id);
      const view = this.views.get(id);
      // Culled since it went on the list. `sync`'s unmount walk already dropped
      // it from the set, so this is belt and braces.
      if (view === undefined) continue;
      const slot = scene.slotOf(id);
      const cold = slot === undefined ? null : scene.coldAt(slot);
      if (slot === undefined || !cold) continue;
      view.el.classList.remove(COARSE);
      const screenPx = Math.max(scene.w[slot]!, scene.h[slot]!) * this.rasterScale;
      // `plain` from the tier alone now, which is the whole of the upgrade: at
      // `card` or `flat` the item was already right and `bind` returns early on
      // its own guard, so a board zoomed out pays nothing here.
      view.bind(
        cold,
        cold.assetId ? this.assetFacts(cold.assetId) : NO_FACTS,
        this.assetUrl,
        screenPx,
        wearOf(cold.seed, this.ageDays(cold)),
        this.tier !== "full",
      );
    }
    for (const id of done) this.coarse.delete(id);
    // Still armed while any remain, so the sweep continues on the next frame
    // without anybody having to ask again.
    this.upgradeWanted = this.coarse.size > 0;
  }

  private create(archetype: Archetype): View {
    if (isCase(archetype)) return new CaseView(archetype);
    if (archetype === "card") return new CardView();
    return archetype === "polaroid" ? new PolaroidView(this.firstSight) : new PaperView();
  }

  destroy(): void {
    // Before the views, since it takes the field out of one of them.
    this.editor?.destroy();
    this.editorView = null;
    // And the recording, for the same reason and one more: a window going away
    // with a cassette still playing would keep making the sound until the
    // element was collected.
    this.deck.destroy();
    this.deckView = null;
    // `release()` and not just `remove()`, because a released node frees its ink
    // canvas's backing store — dropping the element alone leaves the bitmap
    // alive until the collector gets to it, and a torn-down layer still holding
    // megabytes is the kind of leak that only shows up in a long session.
    for (const view of this.views.values()) {
      view.release();
      view.el.remove();
    }
    // Every bucket, and that is a fix rather than a style change (T-339). This
    // named `polaroid` and `paper` and was written when those were the only two
    // — so the three case objects have been going unreleased since T-267, and a
    // pooled folder holds exactly what the paragraph above says a dropped
    // element holds: an ink canvas's backing store, alive until the collector
    // gets to it. Iterating the record is what stops the sixth face being the
    // fourth thing this line forgets.
    for (const bucket of Object.values(this.pool)) {
      for (const pooled of bucket) pooled.release();
      bucket.length = 0;
    }
    this.views.clear();
    this.inkPending.clear();
    this.coarse.clear();
    this.upgradeWanted = false;
    this.developed.clear();
    this.order = [];
    this.orderedBy.clear();
    this.rank.clear();
    this.edges.clear();
  }
}
