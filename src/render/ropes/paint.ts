/**
 * The rope painter — phase 7, and the most important surface in the
 * application.
 *
 * > Rendered as a three-pass stroke along the simulated polyline:
 * >
 * > 1. **Shadow** — offset along the light direction, dark, low alpha, wider
 * >    than the string.
 * > 2. **Body** — the main colour, full width, round joins and caps.
 * > 3. **Highlight** — a brighter tint at reduced width, offset perpendicular
 * >    to the light by about a pixel.
 * >
 * > Three `stroke()` calls, and it reads as a lit cylinder.
 * > — DESIGN section 4.6
 *
 * Three strokes of the *same path*, which is what makes it three and not
 * three-per-string: the offsets are applied by translating the context between
 * passes, so a batch of forty red strings is one `Path2D` and three `stroke()`
 * calls in total.
 *
 * ## Screen space, and why the widths are constant (AC-70)
 *
 * > Rope particles simulate in board space and are transformed to screen space
 * > at draw time — two multiplies and two adds each. Drawing in screen space
 * > means line widths are absolute and crisp at every zoom, with no scaling and
 * > no compensation. — DESIGN section 6.4
 *
 * So `lineWidth` is set from the string's thickness and nothing else. Not
 * multiplied by zoom, not divided by it, not compensated anywhere. Zoom out to
 * 15% and the string stays a crisp three pixels rather than fading to a
 * sub-pixel smear; zoom in to 400% and it does not become a rope-coloured
 * ribbon. The camera reaches the drawing only through the *points*.
 *
 * The corollary is that a cached path is only good while the camera is still,
 * because the cache holds screen coordinates. That is the right trade: a
 * camera move already means every layer on the board redraws.
 *
 * ## Never `shadowBlur` (AC-69)
 *
 * > The string's shadow is a **second offset pass at lower alpha** — never
 * > `shadowBlur`, which is brutally slow on canvas and would dominate the frame
 * > on its own. — DESIGN section 6.4
 *
 * Nothing in this file touches `shadowBlur`, `shadowColor` or `filter`, and
 * `paint.test.ts` asserts it against a recording context rather than trusting
 * anybody to remember.
 *
 * ## Two canvases, one painter
 *
 * ARCHITECTURE lists `ropes/under.ts` and `ropes/over.ts`. They would be the
 * same file twice: the layer stack needs two canvases because a photograph can
 * be pinned on top of string that was already there (DESIGN section 6.2), but
 * *painting* does not change between them. So this is one class, instantiated
 * once per canvas with the layer it draws.
 */

import { fibre } from "@/lib/material";
import { presetSlack } from "@/lib/slack";
import { tucked, tuckedGap, type ShownPage } from "@/render/facing";
import { LIGHT_DX, LIGHT_DY, SHADOW_RGB } from "@/render/items/shadow";
import type { RopeSet } from "@/sim/ropes";
import type { Camera } from "@/state/camera";
import type { DirtySets } from "@/state/dirty";
import type { Bounds, Scene } from "@/state/scene";

/**
 * How far the shadow sits from the string, in screen pixels, how much wider it
 * is, and how faint.
 *
 * Screen pixels rather than board units, like everything else here — a string
 * lying on cork is a fixed small distance off it, and the shadow of a real one
 * does not grow when you lean in.
 *
 * One shadow, everywhere, including where a string lies across an item. DESIGN
 * section 4.6 asks for a second, raised one there — "the offset widens and the
 * alpha drops... the detail that sells draping" — and it was built and then
 * taken out. `shadowBlur` is forbidden (AC-69), so a shadow here is an offset
 * stroke and nothing else, which leaves "wider" as the only way to say
 * "softer"; and a wider hard-edged stroke vanishes into mottled cork and turns
 * into a solid grey bar on white paper. Draping itself went with it (D-22).
 *
 * The colour is the warm brown every other shadow in the application uses
 * (DESIGN section 4.1). It was black here for four phases, which survives
 * against cork and reads as grey ink the moment a string lies on a white note.
 */
const SHADOW_OFFSET = 2.2;
const SHADOW_WIDEN = 1.45;
const SHADOW_ALPHA = 0.26;

/**
 * The highlight rides the lit side, a fraction of the body's width — but never
 * thinner than `HIGHLIGHT_MIN`.
 *
 * The floor is not a nicety. A default string is three pixels, and a plain
 * fraction of that is a stroke of about one, which the rasteriser spreads
 * across two pixels at half opacity and the eye reads as nothing: the string
 * comes out flat, and only a deliberately thick one looks like a cylinder.
 * Seen immediately on a real board and invisible in every unit test.
 */
const HIGHLIGHT_OFFSET = 0.9;
const HIGHLIGHT_WIDTH = 0.38;
const HIGHLIGHT_MIN = 1.25;
/** How far toward white the body colour is pushed for the highlight. */
const HIGHLIGHT_LIFT = 0.42;
/**
 * Ceiling on that lift once a material's `sheen` has multiplied it.
 *
 * Wire's whole character is a bright specular, and the number that gives it is
 * comfortably over 1 — which would blend the body colour all the way to white
 * and lose the difference between a red wire and a blue one. Metal reflects a
 * lot of the light and still has a colour.
 */
const HIGHLIGHT_LIFT_MAX = 0.82;

/**
 * Twist — the width of the nick between one turn of ply and the next.
 *
 * > Twist and fibre come from a subtle repeating variation along the length
 * > rather than from simulation. — DESIGN section 4.6
 *
 * The one sentence in 4.6 that had nothing behind it. What it asks for is a
 * *repeat along arc length*, and the batching is what makes that hard: a batch
 * is one `Path2D` and a handful of `stroke()` calls, so anything that varies
 * within a batch has to be context state set once — which rules out a per-point
 * width, a per-segment alpha, and everything else that would need the painter to
 * re-walk the points. The slack rungs above take the other way out, quantising
 * and adding to the batch key, and that is not available here: a rung is a fact
 * about a whole gap and cannot repeat *inside* one.
 *
 * `setLineDash` is the one thing canvas repeats along arc length for free. It is
 * context state, it applies to a whole path, and the rasteriser does the arc
 * length — so the twist costs no extra `stroke()`, no extra batch and no walk,
 * and 300 strings redrawn every frame measure 0.50 ms with it and 0.50 ms
 * without.
 *
 * And it lands on the **highlight**, which is what makes it read as twist rather
 * than as a dotted line: light on a twisted cord is not a continuous specular,
 * it is a row of glints, one on each crest of the ply, dipping where the groove
 * between them turns away from the light. Breaking the highlight is not an
 * effect added on top of the three passes — it is the third pass drawn right.
 *
 * ## The gap is half a pixel, and that is the whole idea
 *
 * `TWIST_GAP` is *sub-pixel and constant*, which is what separates this from a
 * dashed line. A gap of half a pixel cannot clear a pixel, so the rasteriser
 * never removes anything: it renders the nick as a partial coverage, and what
 * comes out is a highlight that dims and recovers, once per turn of the ply. A
 * modulation rather than an interruption.
 *
 * That is also why it is constant rather than a fraction of the width. A
 * fraction makes the *interruption* grow with the string until it is a break,
 * and the pitch already carries everything that ought to scale. Driven at 100%
 * on a ladder, the peak-to-trough brightness of a 6 px string's highlight goes
 * 2.6 with no twist, 17.7 at a fifth of a pixel, 43 at a half, 60 at 0.8 and 76
 * at 2.2 — and the pictures either side of the half are the argument: at 0.8 a
 * thick string is visibly *ticked*, a row of white dashes, and by 2.2 it is a
 * rope drawn as a dashed line. Half a pixel is the last value that still reads
 * as fibre.
 *
 * Being sub-pixel is also what lets every string carry it. An earlier version
 * bounded the gap in whole pixels and had to decline thin strings and wire
 * outright, because a whole-pixel break in a 1.25 px highlight is a dotted line;
 * a half-pixel dip in the same highlight is simply a slightly restless glint.
 *
 * The pitch is the part that scales, as a multiple of the *drawn* width — see
 * `StringFibre.twist`. It rides on the width for free, which also means it
 * inherits AC-70: the width is in screen pixels at every zoom, so the twist is
 * too. Driven at 40%, 100% and 250%, an 11 px pitch measures 11 px at all three.
 */
const TWIST_GAP = 0.5;

/**
 * The shortest pitch that is still a texture, in screen pixels.
 *
 * Below about this, a repeat stops being read as a repeat and starts being read
 * as a *dotted line*: the nick comes round often enough that its share of the
 * highlight stops being a rhythm and becomes an overall beading. Wire is what
 * found it — its ply is the tightest of the three and it draws the thinnest, so
 * a 3 px wire came out at a 2.8 px pitch, which put a half-pixel nick every
 * three pixels along the brightest specular on the board and read as a string of
 * beads rather than as braid.
 *
 * Flooring the pitch rather than lowering wire's `twist` because it is not a
 * fact about wire: any fibre thin enough lands here, and the number that decides
 * it is a property of the screen. The cost is that the tightest-plied strings
 * all converge on the same pitch at the thin end of the ladder, which is exactly
 * what happens to real cord seen from far enough away.
 */
const TWIST_MIN_PITCH = 4.5;

/**
 * The floor on a body stroke, in screen pixels.
 *
 * `palette.ts` starts its thickness ladder at 2 rather than 1 because a 1 px
 * body rasterises to a smear the eye reads as nothing, and notes that unlike
 * the highlight it has "no floor to save it". A material weight is exactly the
 * thing that can push it back under: wire at the thinnest rung is 1.6. So it
 * gets a floor after all, at the bottom of what the same argument says is
 * legible. A wire is meant to be the thinnest thing on the board — it is not
 * meant to be an invisible one.
 */
const BODY_MIN = 1.75;

/**
 * How wide a string is actually drawn: what the user asked for, through what
 * it is made of.
 *
 * Exported because the *chrome* has to agree with it. `render/overlay.ts` draws
 * the selection halo as a fringe a couple of pixels either side of the string
 * and the hover glow as a wash exactly the string's own width — both of which
 * are questions about the drawn width and neither of which is the authored
 * thickness once a material is involved. A yarn halo sized off the thickness
 * would sit *inside* the strand and disappear, which is the selection quietly
 * failing rather than looking wrong.
 */
export function bodyWidth(thickness: number, material: string): number {
  return Math.max(BODY_MIN, thickness * fibre(material).weight);
}

/** How much wider than the body the fuzz halo is drawn. Wide enough to read as
 *  a fringe of loose fibre and not as a second, blurrier string. */
const HALO_WIDEN = 2.1;

/**
 * > A taut string is very slightly thinner than a slack one.
 * > — DESIGN section 4.6
 *
 * Which is a fact about **one gap**, not about a run: pull a pin out of the
 * middle of a string and one side goes tight while the other keeps its drape,
 * and a width averaged over the whole run would say neither.
 *
 * ## Rungs, not a curve
 *
 * The honest version is a continuous function of slack, and it would cost the
 * batching: `strokeBatch` sets `lineWidth` once and strokes one `Path2D`, so a
 * width that varies continuously is a stroke per segment and an idle board of
 * 500 strings stops being a handful of calls. So the slack is quantised, and
 * the batch key gains a rung.
 *
 * Four is enough because the effect is "very slightly" — the whole span here is
 * fourteen percent, so the step between neighbouring rungs is a fraction of a
 * pixel on a default string, and a continuous version would be indistinguishable
 * from this one at any zoom the board is ever at.
 *
 * The boundaries are places the `1`-`9` presets actually stop, taken from the
 * same geometric ladder rather than picked: pressing `1` lands on the thin rung
 * and `9` on the thick one, and the useful middle — DATA-MODEL's 0.05 to 0.3,
 * which is where `DEFAULT_SLACK` sits — is the rung that draws at exactly the
 * width it always has. So no existing board changes appearance except where
 * somebody has deliberately gone to an end of the ladder.
 */
const SLACK_RUNGS: readonly { readonly from: number; readonly scale: number }[] = [
  { from: presetSlack(1), scale: 0.9 },
  { from: presetSlack(3), scale: 0.95 },
  { from: presetSlack(5), scale: 1 },
  { from: presetSlack(8), scale: 1.04 },
];

/**
 * Which rung a gap's slack falls on.
 *
 * Exported for `paint.test.ts`, which is the only thing that can check the
 * boundaries line up with the presets — from inside the painter they are four
 * numbers in an array.
 */
export function slackRung(slack: number): number {
  let rung = 0;
  for (let i = 1; i < SLACK_RUNGS.length; i++) {
    if (slack >= SLACK_RUNGS[i]!.from) rung = i;
  }
  return rung;
}

/**
 * One turn of ply as a dash: a lit run, and the sub-pixel nick that ends it.
 *
 * The pitch rides on the *drawn* width rather than the authored thickness, so a
 * string on the taut rung has a slightly tighter twist than a slack one — which
 * is what happens to a real cord you pull on, and which comes out of the numbers
 * already there rather than out of a rule.
 *
 * Null only for a fibre with no ply at all, and for a string so narrow that its
 * pitch would not clear the nick — neither of which any material and any rung of
 * the thickness ladder can currently produce, and both of which would otherwise
 * ask the rasteriser for a dash of a negative length.
 *
 * Exported for `paint.test.ts`: from inside the painter this is two multiplies,
 * and what is worth asserting is that the pitch scales and the nick does not.
 */
export function twistDash(width: number, twist: number): number[] | null {
  if (twist <= 0) return null;
  const pitch = Math.max(TWIST_MIN_PITCH, width * twist);
  return [pitch - TWIST_GAP, TWIST_GAP];
}

/**
 * How far outside the viewport a string still counts as visible, in board
 * units. A string whose bounding box is just off-screen can still have a
 * *stroke* on screen once the shadow and half the line width are added, and a
 * rope that popped in at the edge of the viewport would be worse than the
 * handful of extra paths this costs.
 */
const CULL_MARGIN = 64;

/**
 * One stroke set: everything that can be drawn in the same few `stroke()`
 * calls.
 *
 * Keyed on colour, thickness *and* material, because all three change what the
 * context is set to between passes. That is a third dimension on the batch
 * key and it costs nothing worth counting: material is three values and the
 * realistic board uses one of them, so the batch count is unchanged on every
 * board that exists and at worst triples on one that has gone out of its way.
 *
 * And on the slack rung, which is the fourth and the only one that is not a
 * property of the whole string — see `SLACK_RUNGS`. Same argument for the cost:
 * a run whose gaps are all at the default is one rung and therefore one batch,
 * exactly as before, and a board that has been deliberately re-slacked segment
 * by segment pays at most four.
 */
/** The gaps of one string that share a slack rung — and a layer, since T-330,
 *  because a gap that ends at a tucked tape goes behind the paper whatever the
 *  rest of the string does. */
interface RungPath {
  readonly rung: number;
  readonly layer: string;
  readonly path: Path2D;
}

interface Batch {
  path: Path2D;
  color: string;
  /** The authored thickness and material — the batch *key*, alongside colour.
   *  Keyed on the inputs rather than on the widths they resolve to, because
   *  two different materials can land on the same body width off different
   *  rungs of the ladder and still want different highlights. */
  thickness: number;
  material: string;
  /** Which `SLACK_RUNGS` step the gaps in this batch are on. */
  rung: number;
  highlight: string;
  /** The body width the material actually draws at — thickness × weight, floored. */
  width: number;
  /** Highlight width, already through the material's gloss and the floor. */
  highlightWidth: number;
  /** Alpha of the fuzz pass, or zero for a fibre that has none. */
  halo: number;
  /** One turn of ply as a dash — the lit run and the sub-pixel nick that ends
   *  it, in screen pixels. Null for a fibre with no ply, which draws a solid
   *  highlight. */
  twist: number[] | null;
}

export class RopeLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly layer: string;

  /**
   * One `Path2D` per string per slack rung, in screen space.
   *
   * > Sleeping ropes keep a cached `Path2D`, so an idle board of 500 strings is
   * > a handful of path fills. — DESIGN section 6.4
   *
   * Per string rather than per batch, because a batch is where the drawing is
   * cheap and a string is where the *walk* is: rebuilding one moving string's
   * path and re-assembling the batch from cached ones costs a few hundred
   * `addPath` calls, against ten thousand `lineTo`s to rebuild the board.
   *
   * Per rung within that, because the rung decides `lineWidth` and a run can
   * hold gaps at more than one of them — see `SLACK_RUNGS`. Almost always a
   * one-element array: it takes a deliberately re-slacked segment to make two.
   */
  private readonly paths = new Map<string, RungPath[]>();
  /** Camera pose the cached paths were built at. */
  private cachedX = Number.NaN;
  private cachedY = Number.NaN;
  private cachedZoom = Number.NaN;
  /** Whether the canvas currently has anything on it. */
  private inked = false;

  private readonly view: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly batches: Batch[] = [];
  private readonly visible: string[] = [];

  /** See [`setShownPage`]. */
  private shownPage: ShownPage | null = null;
  /**
   * The strings with a put-away tape somewhere on them — rebuilt at the top of
   * each draw, and empty on every board that has never quoted a case file.
   *
   * It exists for the hot loop and for nothing else: without it, "is this string
   * one that has to be split" would be a walk of its nodes for every string in
   * the viewport on every frame. Which of its *gaps* go behind the paper is
   * `tuckedGap`'s question, asked one level down where there is a gap to ask
   * about.
   */
  private readonly tuckedStrings = new Set<string>();

  constructor(canvas: HTMLCanvasElement, layer: "over" | "under") {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.layer = layer;
  }

  /**
   * Which face each item is showing — T-330, and the same function the pin
   * layer, the item layer and the pen are handed.
   *
   * A thread taped to page four of a filing runs **under** the sheet on show
   * whenever page four is not it — and a shut folder shows no page, so a shut
   * folder's threads run under the folder and vanish into it. That is one
   * sentence rather than three cases, and it is the whole of what this layer
   * does with the answer.
   *
   * Only the gap that ends at the tape moves. A quote card's thread is a single
   * gap so the distinction is invisible on the gesture that makes one, and it
   * stops being invisible the moment somebody pulls a pin out of the middle of
   * that thread (T-46): tucking the far half, which never went near the folder,
   * would hide a string behind every note between here and the card.
   */
  setShownPage(resolve: ShownPage): void {
    this.shownPage = resolve;
  }

  /**
   * Which tapes are put away this frame, and which strings end at one.
   *
   * Rebuilt rather than invalidated, because it is derived from three things
   * that change without a document write — the folder opening, shutting, and
   * being turned — and because on every board it has ever run on the first line
   * returns. `scene.pagedPins` is empty until somebody quotes a case file.
   */
  private findTucked(scene: Scene): void {
    this.tuckedStrings.clear();
    if (scene.pagedPins.size === 0) return;
    for (const id of scene.pagedPins) {
      const pin = scene.pins.get(id);
      if (pin === undefined || !tucked(pin, this.shownPage)) continue;
      for (const sid of scene.stringsThrough(id)) this.tuckedStrings.add(sid);
    }
  }

  /**
   * ROPES phase (7).
   *
   * Returns whether it drew, which is what the dev HUD wants and what makes
   * "an idle board costs nothing" checkable rather than asserted.
   */
  draw(scene: Scene, ropes: RopeSet, camera: Camera, dirty: DirtySets): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;

    const moved = camera.x !== this.cachedX || camera.y !== this.cachedY || camera.zoom !== this.cachedZoom;
    if (moved || dirty.all) this.paths.clear();
    else {
      // Only what actually changed loses its cached walk.
      for (const id of dirty.ropes) this.paths.delete(id);
      for (const id of dirty.strings) this.paths.delete(id);
    }

    // A frame where the camera is still and no rope moved is a frame where the
    // canvas already holds the right picture. This is the whole reason a board
    // of five hundred sleeping strings is free.
    if (!moved && !dirty.all && dirty.ropes.size === 0 && dirty.strings.size === 0) {
      return false;
    }

    this.cachedX = camera.x;
    this.cachedY = camera.y;
    this.cachedZoom = camera.zoom;

    camera.visibleBounds(CULL_MARGIN, this.view);
    this.visible.length = 0;
    ropes.stringsIn(this.view, this.visible);

    this.findTucked(scene);
    this.batches.length = 0;
    for (const id of this.visible) {
      const style = scene.strings.get(id);
      if (style === undefined) continue;
      // The whole string is on one canvas unless a tape on it has been put
      // away, which is the case for every string on every board bar the one
      // being read — so this stays the single comparison it always was, plus a
      // `has` on a set that is usually empty.
      if (style.layer !== this.layer && !this.tuckedStrings.has(id)) continue;
      const parts = this.pathsFor(id, ropes, camera, scene, style.layer);
      if (parts === null) continue;
      for (const part of parts) {
        if (part.layer !== this.layer) continue;
        this.batchFor(style.color, style.thickness, style.material, part.rung).path.addPath(
          part.path,
        );
      }
    }

    if (this.batches.length === 0) {
      // Nothing to draw. Clearing a canvas that is already blank is a full
      // backing-store write for no reason, and on the `under` layer of a board
      // where every string is over the items, that would be every frame.
      if (!this.inked) return false;
      this.clear(ctx);
      this.inked = false;
      return true;
    }

    this.clear(ctx);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const batch of this.batches) this.strokeBatch(ctx, batch);
    this.inked = true;
    return true;
  }

  /**
   * EXPORT. Draw the strings into a canvas *somebody else is also drawing on*
   * (T-206).
   *
   * `draw` clears first, and that is right for the layer it owns: a rope canvas
   * on the board holds nothing but ropes, and the strings that moved cannot be
   * repainted over the ones that were there. On an export canvas it is
   * catastrophic and silent — the cork, the board ink, the items and the
   * *other* rope layer are all already on it, and clearing takes the lot. The
   * first export driven with a string on the board came back as one blue curve
   * on white, which is exactly what "the last painter wiped the canvas" looks
   * like and nothing like a bug in any of the four layers that vanished.
   *
   * So this is `draw` without the clear and without the caching: an export
   * canvas is drawn once, so there is nothing for a cached path or an `inked`
   * flag to save, and both of those are about *this* layer's canvas rather than
   * about the strings.
   */
  drawInto(ctx: CanvasRenderingContext2D, scene: Scene, ropes: RopeSet, camera: Camera): number {
    camera.visibleBounds(CULL_MARGIN, this.view);
    const visible: string[] = [];
    ropes.stringsIn(this.view, visible);

    const batches: Batch[] = [];
    // The batch map is keyed off `this.batches`, so it is emptied and refilled
    // rather than worked around — the export owns this layer for the duration
    // and `invalidate` puts it back for the board.
    this.batches.length = 0;
    this.findTucked(scene);
    for (const id of visible) {
      const style = scene.strings.get(id);
      if (style === undefined) continue;
      if (style.layer !== this.layer && !this.tuckedStrings.has(id)) continue;
      const parts = this.pathsFor(id, ropes, camera, scene, style.layer);
      if (parts === null) continue;
      for (const part of parts) {
        if (part.layer !== this.layer) continue;
        this.batchFor(style.color, style.thickness, style.material, part.rung).path.addPath(
          part.path,
        );
      }
    }
    batches.push(...this.batches);

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const batch of batches) this.strokeBatch(ctx, batch);
    ctx.restore();

    // Everything above was built at the export camera and cached under it, and
    // the *window* camera is what `cachedZoom` still names — so a later frame
    // that only dirties one string would keep the export's geometry for all the
    // others and draw them into the window at the wrong scale.
    //
    // `dropPaths` and deliberately not `invalidate`, which would also clear
    // `inked` — and `inked` is a fact about *this layer's own canvas*, which an
    // export never touched. Clearing it would tell the layer its canvas is
    // blank when it is not, and the next frame that finds no strings left would
    // skip the clear it needs and leave the last ropes on screen for ever.
    this.dropPaths();
    return batches.length;
  }

  /** Drop every cached path. For a resize, which invalidates the canvas, and
   *  for teardown. */
  invalidate(): void {
    this.dropPaths();
    this.inked = false;
  }

  /** The cached walks, and the camera they were walked at. */
  private dropPaths(): void {
    this.paths.clear();
    this.cachedZoom = Number.NaN;
  }

  /**
   * The three passes, on one path.
   *
   * The translations are what put the shadow and the highlight where they
   * belong — the same geometry, moved — so the offsets cost a transform rather
   * than a second walk of the points.
   */
  private strokeBatch(ctx: CanvasRenderingContext2D, batch: Batch): void {
    // 1. Shadow: down-light, wider, dark and faint. An offset pass, never
    //    `shadowBlur` (AC-69). One of them, everywhere — see the note at the
    //    top of the file on why a string lying on a photograph does not get a
    //    second, raised one.
    //
    //    Warm brown and never black (DESIGN section 4.1). It was black here
    //    until T-143, which survives against cork and reads as grey ink the
    //    moment a string lies on a white note.
    ctx.save();
    ctx.translate(LIGHT_DX * SHADOW_OFFSET, LIGHT_DY * SHADOW_OFFSET);
    ctx.strokeStyle = `rgba(${SHADOW_RGB}, ${SHADOW_ALPHA})`;
    ctx.lineWidth = batch.width * SHADOW_WIDEN;
    ctx.stroke(batch.path);
    ctx.restore();

    /**
     * 1a. Fuzz, for a fibre that has any — a wide, faint pass of the body
     * colour, sitting exactly under the body rather than offset from it.
     *
     * This is the fourth stroke DESIGN section 4.6 does not list, and it is
     * here because "yarn" has to be *visibly* yarn from across the board and
     * three strokes of a lit cylinder is precisely what yarn is not. Loose
     * fibre standing off the strand is a soft edge of the strand's own colour;
     * one wide low-alpha stroke is what that looks like at any zoom the board
     * is ever at, and it stays inside the batch — no per-string cost, and the
     * whole thing costs nothing at all on a board with no yarn on it.
     */
    if (batch.halo > 0) {
      ctx.save();
      ctx.globalAlpha = batch.halo;
      ctx.strokeStyle = batch.color;
      ctx.lineWidth = batch.width * HALO_WIDEN;
      ctx.stroke(batch.path);
      ctx.restore();
    }

    // 2. Body: the string's own colour, at its own width, in screen pixels.
    ctx.strokeStyle = batch.color;
    ctx.lineWidth = batch.width;
    ctx.stroke(batch.path);

    // 3. Highlight: perpendicular to the light, toward the lit side. How bright
    //    and how tight is the material's doing — see `lib/material.ts`.
    //
    //    And dipping once per turn of the ply, which is the twist — see
    //    `TWIST_GAP`. The dash and the cap are both context state and `restore`
    //    puts them back, so they stay inside the pass and no later stroke
    //    inherits either.
    ctx.save();
    ctx.translate(-LIGHT_DY * HIGHLIGHT_OFFSET, LIGHT_DX * HIGHLIGHT_OFFSET);
    ctx.strokeStyle = batch.highlight;
    ctx.lineWidth = batch.highlightWidth;
    if (batch.twist !== null) {
      ctx.setLineDash(batch.twist);
      // Butt caps, and only here. `lineCap` is round for the whole batch, and a
      // round cap does not stop at the end of its dash — it puts a semicircle of
      // half the line width past it, at *both* ends of every gap. So a gap
      // narrower than the highlight is filled in by the two dashes either side
      // of it and the twist is simply not drawn, which is not a subtle twist but
      // an absent one, and it goes wrong worst on the widest strings: a top-rung
      // yarn draws a 5.6 px highlight, which closes a 2.2 px gap completely.
      // Found by sampling the pixels of a driven board — twelve pixels of flat
      // highlight where a groove was supposed to be — and invisible from here.
      ctx.lineCap = "butt";
    }
    ctx.stroke(batch.path);
    ctx.restore();
  }

  private batchFor(color: string, thickness: number, material: string, rung: number): Batch {
    for (const batch of this.batches) {
      if (
        batch.color === color &&
        batch.thickness === thickness &&
        batch.material === material &&
        batch.rung === rung
      ) {
        return batch;
      }
    }
    const fib = fibre(material);
    // The rung rides on the *body* width and everything else follows from it,
    // so a taut segment's highlight and shadow narrow with it rather than
    // sitting proud of a string that has quietly got thinner. The floor is
    // still `bodyWidth`'s, applied after: a thin rung must not push wire under
    // the width the same argument already called illegible.
    const width = Math.max(BODY_MIN, bodyWidth(thickness, material) * SLACK_RUNGS[rung]!.scale);
    const batch: Batch = {
      path: new Path2D(),
      color,
      thickness,
      material,
      rung,
      highlight: lighten(color, Math.min(HIGHLIGHT_LIFT_MAX, HIGHLIGHT_LIFT * fib.sheen)),
      width,
      highlightWidth: Math.max(HIGHLIGHT_MIN, width * HIGHLIGHT_WIDTH * fib.gloss),
      halo: fib.halo,
      twist: twistDash(width, fib.twist),
    };
    this.batches.push(batch);
    return batch;
  }

  /**
   * One string's polyline in screen space, cached — as one path per slack rung
   * it uses, which for almost every string on almost every board is one.
   *
   * Each segment is its own subpath — a `moveTo` and then a run of `lineTo` —
   * so a multi-pin run draws as one continuous string and a segment whose pin
   * has gone missing simply leaves a gap rather than a straight line across
   * the board to wherever the next one starts. Splitting by rung uses the same
   * property from the other end: the subpaths of one run can be spread across
   * several paths without the drawing changing, because they were never joined.
   *
   * And by *layer* since T-330, on exactly the same property and for a reason
   * that is not a style at all: a gap that ends at a tape on a page nobody is
   * looking at is behind the paper, and the gaps either side of it are not.
   * `layer` on the string is what it is drawn on when nothing is put away, so a
   * board with no case file open builds the one part it always did.
   */
  private pathsFor(
    id: string,
    ropes: RopeSet,
    camera: Camera,
    scene: Scene,
    layer: string,
  ): RungPath[] | null {
    const cached = this.paths.get(id);
    if (cached !== undefined) return cached;

    const pool = ropes.positions;
    const zoom = camera.zoom;
    const camX = camera.x;
    const camY = camera.y;
    const parts: RungPath[] = [];

    ropes.visit(id, (at, count, _asleep, slack, a, b) => {
      const rung = slackRung(slack);
      // Under, whatever the string says, when this gap reaches a tape that has
      // been put away — see `tuckedGap`, which is also what the overlay asks
      // before it lights a thread it would otherwise light across a shut
      // folder.
      const on = tuckedGap(scene, this.shownPage, a, b) ? "under" : layer;
      let part = parts.find((p) => p.rung === rung && p.layer === on);
      if (part === undefined) {
        part = { rung, layer: on, path: new Path2D() };
        parts.push(part);
      }
      const path = part.path;
      path.moveTo((pool[at]! - camX) * zoom, (pool[at + 1]! - camY) * zoom);
      for (let i = 1; i < count; i++) {
        const j = at + i * 2;
        path.lineTo((pool[j]! - camX) * zoom, (pool[j + 1]! - camY) * zoom);
      }
    });

    if (parts.length === 0) return null;
    this.paths.set(id, parts);
    return parts;
  }

  /**
   * The context is pre-scaled by devicePixelRatio (`world.resizeCanvases`), so
   * clearing has to step outside that transform to reach the backing store.
   */
  private clear(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  }
}

/**
 * Push a hex colour toward white, for the highlight.
 *
 * Blending toward white rather than scaling the channels, because scaling a
 * dark red gives a slightly *less* dark red and reads as a smudge; the
 * highlight has to look like light landing on a fibre. Anything that is not a
 * six-digit hex comes back unchanged, which draws a string with no highlight
 * rather than throwing inside the paint path.
 */
export function lighten(hex: string, amount: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const value = Number.parseInt(hex.slice(1), 16);
  const mix = (channel: number): number =>
    Math.round(channel + (255 - channel) * amount);
  const r = mix((value >> 16) & 0xff);
  const g = mix((value >> 8) & 0xff);
  const b = mix(value & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
