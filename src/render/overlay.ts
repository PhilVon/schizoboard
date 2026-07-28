/**
 * The overlay canvas â€” phase 8.
 *
 * > 8. OVERLAY   remote cursors, ghosts, wet ink, selection chrome
 * > â€” docs/ARCHITECTURE.md section 3
 *
 * Everything drawn here is transient: it belongs to a gesture or to a
 * collaborator, never to the document. The canvas is cleared and redrawn whole
 * on the frames it has anything to change, which is affordable precisely because
 * most frames have nothing â€” and free on those, because a frame that would
 * redraw the same picture does not touch the canvas at all.
 *
 * Screen space, like the rope canvases: points are converted through the camera
 * at draw time rather than the canvas being transformed. That is what keeps a
 * one-pixel line one pixel wide at 400% zoom.
 *
 * ## Selection chrome is here, and that is the point
 *
 * It used to be a CSS `outline` on each item's own frame, which put its width in
 * *board* units: legible at 54% zoom, a hairline at 20%, and gone by 15% â€” while
 * thickening into a slab at 400%. Chrome is not part of the photograph. Drawing
 * it here costs the rotation the CSS outline got for free, and buys exact screen
 * widths, no per-item DOM bookkeeping, and chrome that is not painted over by
 * whatever item happens to stack above the selected one.
 */

import { carryScale } from "@/lib/carry";
import type { WetStroke } from "@/lib/ink";
import { rotateOut } from "@/lib/rotate";
import { type ItemFrame, WetInk } from "@/render/ink/wet";
import { PeerPainter } from "@/render/presence/draw";
import type { PeerSource } from "@/render/presence/peers";
import { pinHitRadius } from "@/render/pins/dom";
import { bodyWidth } from "@/render/ropes/paint";
import type { Bounds, Camera, Vec2 } from "@/state/camera";
import type { DirtySets } from "@/state/dirty";
import {
  chromeFrame,
  emptyFrame,
  HANDLE_RADIUS,
  HANDLE_STALK,
  rotateHandle,
  SELECT_PAD,
  SELECT_WIDTH,
  type HandleFrame,
} from "@/state/handles";
import type { Scene } from "@/state/scene";
import type { Selection } from "@/state/selection";

/** Warm, like everything else on this board; matches the item outline. */
/** No ink in flight — the same array every frame nobody is drawing, which is
 *  almost all of them. */
const EMPTY_WET: readonly WetStroke[] = Object.freeze([]);

const MARQUEE_FILL = "rgba(255, 244, 214, 0.10)";
const MARQUEE_STROKE = "rgba(255, 244, 214, 0.85)";

/**
 * Dark rather than light, and that is not a taste call: a pale line is invisible
 * against a polaroid's own off-white frame, which is most of what anyone selects.
 * A dark warm line is the only one legible against both the cork and the paper,
 * and it reads as something drawn round the photograph rather than as a UI
 * rectangle floating over it.
 *
 * Exported so that `app/sync.test.ts` can hold it and the peer palette apart:
 * a peer's chrome is drawn in their own colour, and one that landed on this
 * value would make somebody else's outline look like yours (T-152).
 */
export const SELECT_STROKE = "rgba(34, 21, 10, 0.8)";

/**
 * The rotation knob is filled in the same warm dark as the outline and ringed in
 * the cork's own highlight, so it reads as a brass tack pushed into the board
 * rather than as a widget floating above it â€” and so it stays legible whether the
 * stalk crosses cork or another photograph.
 */
const HANDLE_RING = "rgba(255, 244, 214, 0.9)";

/**
 * The ring round the item a pin would land on â€” "candidate items highlight with
 * a ring" (DESIGN section 3.3).
 *
 * Two strokes, a dark one under a pale one, for the reason the selection
 * outline is dark: neither colour alone is legible against both cork and an
 * off-white polaroid frame, and this line has to be readable in the half second
 * before somebody commits to a drop. Pale on top, so it reads as a different
 * thing from the selection outline rather than as a thicker one.
 */
const CANDIDATE_UNDER = "rgba(34, 21, 10, 0.7)";
const CANDIDATE_OVER = "rgba(255, 246, 222, 0.95)";
const CANDIDATE_PAD = 5;
const CANDIDATE_WIDTH = 2;

/**
 * A selected pin: a ring around the head.
 *
 * A ring rather than the box a selected item gets, because a pin is round and
 * because the thing being marked is a *point* — the box would claim an area the
 * pin does not occupy, and on a hub pin with six strings through it the area is
 * exactly what is confusing.
 *
 * The pin layer is DOM and sits above this canvas, so the ring is drawn behind
 * the head it rings and shows as a halo around it. That is the right way round:
 * a ring painted over the head would hide the one part of a pin anybody looks
 * at, and pins are small.
 *
 * Sized from `pinHitRadius`, so the chrome is exactly the target — what you can
 * see you have hold of is what you can grab.
 */
const PIN_RING_PAD = 3;
const PIN_RING_WIDTH = 2;
const PIN_RING_UNDER = "rgba(34, 21, 10, 0.55)";
const PIN_RING_OVER = "rgba(255, 244, 214, 0.95)";

/**
 * What an undo just changed — DESIGN section 7.6's "flash-highlight what
 * changed so it's never silent", and `state/flash.ts` for why it is needed.
 *
 * Amber, and that is the one colour decision here that carries weight. Every
 * other mark on this canvas is either the warm dark of the selection family or
 * the pale cream of the cork's own highlight, and a flash that landed in either
 * would read as "you have selected this" — which is exactly the wrong sentence
 * for a thing that has just moved without being asked. Amber belongs to neither
 * family, sits well clear of the cotton red of a string, and is the one hue that
 * is legible on cork, on an off-white polaroid frame and on a photograph.
 *
 * Dark under pale over, like the candidate ring and the selected-pin ring, for
 * the reason those are: no single colour survives all three surfaces, and this
 * mark gets under a second to be seen.
 */
const FLASH_UNDER = "rgba(30, 18, 6, 0.7)";
const FLASH_OVER = "rgba(255, 186, 74, 0.95)";
const FLASH_WIDTH = 2.5;
/**
 * How far the outline stands off the thing it lights, at the start of the fade
 * and at the end of it. A ring that opens outwards as it goes reads as a pulse
 * leaving the item; one that held still would read as a second, blinking
 * selection.
 */
const FLASH_PAD = 4;
const FLASH_SPREAD = 10;
/**
 * The fade holds near full for the first third and falls away over the rest.
 * A straight linear ramp spends most of its life at an alpha too low to see and
 * reads as a much shorter flash than it is.
 */
const FLASH_HOLD = 1.5;
/**
 * A string is lit rather than outlined — a band outside the cotton and a wash
 * inside it, both well short of opaque. See [`STRING_HALO`] for what happens to
 * a string covered by a solid pale stroke.
 */
const FLASH_STRING_GLOW = 0.4;
const FLASH_STRING_CORE = 0.85;

/** Full for the first third of the life, then away. See [`FLASH_HOLD`]. */
function alphaOf(life: number): number {
  return Math.min(1, life * FLASH_HOLD);
}

/**
 * The lives of the things an undo just touched — `state/flash.ts`. Structural
 * rather than the class, like [`RopeGeometry`] and for the same reason: this
 * canvas draws what it is handed and has no opinion about how it decays.
 */
export interface FlashSource {
  /** Item id -> life, 1 the moment it changed and 0 when the flash is over. */
  readonly items: ReadonlyMap<string, number>;
  readonly pins: ReadonlyMap<string, number>;
  readonly strings: ReadonlyMap<string, number>;
  readonly isEmpty: boolean;
}

/**
 * The string run being drawn. The cotton red of a real string, so the run
 * reads as the thing it is about to become rather than as UI chrome — but
 * thinner and flat, with no shadow and no highlight, because it is not string
 * yet and must not be mistaken for some.
 */
const PENDING_STROKE = "rgba(168, 50, 44, 0.9)";
const PENDING_WIDTH = 2;
const PENDING_DASH: readonly number[] = [7, 5];

/**
 * A run drawn on this canvas, and how much of it is provisional.
 *
 * `"tail"` is a run being built with the string tool: the stops already clicked
 * are decisions and only the leg chasing the cursor is not. `"all"` is the loop
 * being pulled out of an existing string — nothing about it is written until
 * the release, including which two pins it hangs between, so drawing any of it
 * solid would claim more than has happened.
 */
export interface PendingRun {
  /** Board space, the live cursor last. */
  readonly points: readonly Vec2[];
  readonly dashed: "tail" | "all";
}

/**
 * The half of `sim/ropes.ts` this canvas reads: where a string's particles
 * are. Structural rather than the class, so the overlay depends on the shape it
 * walks and not on the simulation — the same seam `state/tools/tool.ts` draws
 * for the same reason.
 */
export interface RopeGeometry {
  readonly positions: Float64Array;
  visit(id: string, fn: (at: number, count: number) => void): void;
}

/**
 * The point on a string under the cursor — "the nearest point on the rope
 * highlights, tracking your cursor along the curve" (DESIGN section 3.4).
 *
 * A small disc rather than a glow along the string, because what it is
 * promising is precise: press here and a pin is born *there*. In the cotton red
 * of the string it came off, ringed pale so it stays legible against the string
 * itself, against cork and against a photograph.
 */
const STRING_HOVER_RADIUS = 4;
const STRING_HOVER_FILL = "rgba(168, 50, 44, 0.95)";
const STRING_HOVER_RING = "rgba(255, 246, 222, 0.95)";

/**
 * A selected string.
 *
 * This canvas sits above both rope canvases, so a halo stroked along the string
 * lands *on top* of it, and a wide pale stroke — which is the obvious way to
 * write this — makes the selected string read as **faded** rather than as
 * marked. Seen immediately on a real board and invisible in every unit test.
 *
 * So the band over the string itself is taken back out with `destination-out`
 * after it is laid down, leaving only the fringe either side. The string keeps
 * its own colour, its shadow and its highlight, and gains an outline — which is
 * the same thing the selection outline does for a photograph, and reads the
 * same way.
 */
const STRING_HALO = "rgba(255, 244, 214, 0.85)";
const STRING_HALO_WIDEN = 7;
/** A shade wider than the string, so the fringe does not eat its own edges. */
const STRING_HALO_CLEAR = 2;

/**
 * > | See its threads | Hover | Every string through the pin highlights |
 * > — DESIGN section 3.3
 *
 * A *lit* string rather than a haloed one, and the difference is the whole
 * design of it: the halo is what a **selected** string looks like, and hovering
 * must not look like having selected something. So this is a warm pale wash
 * inside the string's own width — the cotton lifts toward the light and does
 * not gain an outline, which is exactly the difference between "this is the one
 * you are pointing at" and "this is the one you have hold of".
 *
 * Confined to the string's own width for the reason `STRING_HALO` is not: a
 * wide pale stroke laid over a string reads as faded, and a faded string on
 * hover would say the opposite of what this means.
 */
const THREAD_LIT = "rgba(255, 236, 196, 0.32)";

export class Overlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  /** Did the previous frame leave anything behind that needs clearing? */
  private inked = false;
  /** Reused; `boardToScreen` allocates otherwise, and this runs per frame. */
  private readonly a: Vec2 = { x: 0, y: 0 };
  private readonly b: Vec2 = { x: 0, y: 0 };
  private hadPending = false;
  private readonly knob: Vec2 = { x: 0, y: 0 };
  private readonly frame: HandleFrame = emptyFrame();

  /**
   * What the picture currently on the canvas was drawn from. An idle board must
   * cost nothing (`state/selection.ts`), and a selection is the first thing this
   * canvas holds that *persists* â€” the marquee only existed mid-drag, so until
   * now "nothing to draw" and "nothing changed" were the same frame. They are
   * not any more: a board sitting still with three photographs selected would
   * otherwise clear and restroke a full-viewport canvas sixty times a second to
   * arrive at the identical image.
   */
  private cameraVersion = -1;
  private selectionVersion = -1;
  private hadMarquee = false;
  /** The candidate ring changes with nothing else: dragging a pin across a
   *  still board moves no item, no camera and no selection. */
  private highlighted: string | null = null;
  /** Was there a string highlight on the canvas last frame? It tracks along a
   *  curve that nothing else on this canvas knows about, so it is its own
   *  flag — the frame it disappears is a frame that has to clear. */
  private hadStringHover = false;
  /** Was an undo's flash on the canvas last frame? Like the wet-ink flag, the
   *  frame it expires is a frame that has to clear and changes nothing else. */
  private hadFlash = false;
  /** The pin whose threads were lit last frame. Like the candidate ring, it
   *  changes with nothing else: moving the cursor from one pin to the next
   *  touches no camera, no selection and no item. */
  private hoveredPin: string | null = null;
  /** Was there wet ink on the canvas last frame? The frame after a release has
   *  to clear the mark, and a release changes nothing else on this canvas. */
  private hadWet = false;
  /** Reset at the top of every `draw` â€” see [`Overlay.clear`]. */
  private cleared = false;
  /** What the peers on the canvas were drawn from — see [`PeerSource.version`]. */
  private peersVersion = -1;
  /** Holds the reused screen-space buffer, so it survives between frames. */
  private readonly wetInk = new WetInk();
  /** Everybody else. Holds its own scratch point, like [`WetInk`] above. */
  private readonly painter = new PeerPainter();
  /**
   * Handed to [`PeerPainter`], whose entry points cannot know whether this frame
   * has cleared yet and must not clear a frame that turns out to draw nothing.
   *
   * Bound once rather than rebuilt per frame: this is phase 8 of every frame
   * anything moves on.
   */
  private readonly clearOnce = (): void => {
    if (this.ctx) this.clear(this.ctx);
  };
  /** Refilled every frame a glued stroke is drawn — see [`Overlay.inkFrame`]. */
  private readonly ink: ItemFrame = { cx: 0, cy: 0, cos: 1, sin: 0, hw: 0, hh: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  /**
   * OVERLAY phase.
   *
   * `marquee` is in board coordinates so it stays pinned to the cork if the
   * camera moves while it is being dragged out.
   *
   * `dirty` is read only to answer one question â€” did anything *selected* move
   * this frame â€” because a selected photograph being dragged changes this picture
   * without changing the camera or the membership.
   */
  draw(
    camera: Camera,
    scene: Scene,
    selection: Selection,
    marquee: Bounds | null,
    dirty: DirtySets,
    /** The item a pin being dragged would parent to, ringed. */
    highlight: string | null = null,
    /**
     * The string run being drawn, in board space, with the live cursor as its
     * last point.
     *
     * Here rather than on a rope canvas because it is a *gesture*, and this is
     * the layer for those: it belongs to whoever is holding the mouse, it is
     * never in the document, and it vanishes the moment the run ends
     * (ARCHITECTURE section 3, phase 8).
     */
    pending: PendingRun | null = null,
    /**
     * Where the ropes are, for the selected ones. Null when there is no
     * simulation to ask — which is every test that does not care.
     */
    ropes: RopeGeometry | null = null,
    /** The point on a string under the cursor, board space (DESIGN 3.4). */
    stringHover: Vec2 | null = null,
    /**
     * The pin under the cursor, whose threads light up — DESIGN section 3.3's
     * "see its threads" row.
     *
     * The id rather than the strings, because the scene is already here and
     * `stringsThrough` is the index that answers it: handing over a list would
     * make `main.ts` do the lookup on every frame the cursor moves, whether or
     * not this canvas turned out to need it.
     */
    hoveredPin: string | null = null,
    /**
     * The stroke being drawn — DESIGN section 6.5's wet ink, on the canvas
     * section 6.2 names for it.
     *
     * A **list**, because a gesture that crosses off the surface it started on is
     * several runs (T-137): the pieces already behind the hand plus the live one,
     * each in the space its own `item` names, oldest first. The scene above is
     * what resolves the difference, once per run per frame. A list of one is the
     * common case and an empty one is the answer for every frame nobody is
     * drawing.
     *
     * Last in the list because it is drawn last: ink goes *over* the chrome, since
     * it is a mark being made on the board rather than a thing said about it.
     */
    wet: readonly WetStroke[] = EMPTY_WET,
    /**
     * Everybody else on the board — their cursors, and what they have hold of.
     *
     * Null when this client has no wire at all, which is a plain browser with no
     * `?relay=` and is most of the time in development. Nothing is allocated,
     * compared or walked in that case: presence costs a null check per frame on
     * a board that is alone.
     */
    peers: PeerSource | null = null,
    /**
     * What the last undo changed, fading — DESIGN section 7.6. Null in every
     * test that is not about it, and on any board where nothing has been undone
     * it is an empty source that costs one boolean per frame.
     */
    flashes: FlashSource | null = null,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const wantsMarquee = marquee !== null;
    const wantsPending = pending !== null && pending.points.length >= 2;
    const wantsStrings = ropes !== null && selection.strings.size > 0;
    const wantsThreads = ropes !== null && hoveredPin !== null;
    // One drawable run is enough to make the canvas stale. A run of a single
    // sample is a press that has not moved, and `MarkerTool.runsInFlight`
    // withholds it — but a one-sample run that arrives here after a crossing is
    // the continuation of a mark and is drawn.
    const wantsWet = wet.length > 0 && wet.some((run) => run.samples.length >= 2);
    // A peer's outlines ride whatever they are drawn round, and none of it is
    // ours: a collaborator's selected photograph is moved by *them*, which
    // touches neither our camera nor our selection. Broad on purpose, and the
    // same breadth the selected-string check above settles for — the alternative
    // is a per-peer reverse index rebuilt on every awareness message, to save
    // work on the frames where something is already moving.
    const wantsPeerChrome = peers !== null && peers.chromed;
    // A flash fades, so every frame of one is a different picture — and unlike
    // everything else here it is stale on frames where the board is otherwise
    // completely still, which is the usual case: you press Ctrl+Z and nothing
    // else on the board is moving at all.
    const wantsFlash = flashes !== null && !flashes.isEmpty;
    const stale =
      wantsMarquee ||
      wantsFlash ||
      // The frame the last one expires on still has it on the canvas.
      this.hadFlash ||
      wantsPending ||
      // Every frame of a stroke, and the frame after the last one — a stroke that
      // grew by one sample is a different picture, and a release leaves a mark on
      // the canvas that nothing else will clear.
      wantsWet ||
      this.hadWet ||
      stringHover !== null ||
      this.hadStringHover ||
      hoveredPin !== this.hoveredPin ||
      // The lit strings sag and settle like any others, and hovering a pin on a
      // board where something is still swinging must not freeze them.
      (wantsThreads && (dirty.all || dirty.ropes.size > 0 || dirty.strings.size > 0)) ||
      // A selected string sags, settles and follows the photograph it is tied
      // to, none of which touches the camera or the selection.
      (wantsStrings && (dirty.all || dirty.ropes.size > 0 || dirty.strings.size > 0)) ||
      this.hadPending ||
      highlight !== this.highlighted ||
      // A candidate that is itself moving â€” a pin held over a photograph being
      // dragged by a collaborator â€” restrokes with it.
      (highlight !== null && (dirty.all || dirty.items.has(highlight))) ||
      // It was there last frame and is not now, so the canvas is wrong even if
      // nothing else changed â€” dragging a marquee across empty cork and letting
      // go never touches the selection.
      this.hadMarquee ||
      // A cursor that moved, a peer who joined or left, a selection of theirs
      // that changed. One integer, and it is the *drawn* cursor rather than the
      // published one, so a peer's spring settling is a change and a peer
      // sitting still is not (`render/presence/peers.ts`).
      (peers !== null && peers.version !== this.peersVersion) ||
      (wantsPeerChrome &&
        (dirty.all ||
          dirty.items.size > 0 ||
          dirty.pins.size > 0 ||
          dirty.ropes.size > 0 ||
          dirty.strings.size > 0)) ||
      camera.version !== this.cameraVersion ||
      selection.version !== this.selectionVersion ||
      this.selectedMoved(selection, scene, dirty);
    if (peers !== null) this.peersVersion = peers.version;
    this.hadMarquee = wantsMarquee;
    this.hadPending = wantsPending;
    this.hadStringHover = stringHover !== null;
    this.hadFlash = wantsFlash;
    this.hadWet = wantsWet;
    this.hoveredPin = hoveredPin;
    this.highlighted = highlight;
    this.cameraVersion = camera.version;
    this.selectionVersion = selection.version;
    if (!stale) return;

    // The clear is deferred rather than done up front, so that a frame which
    // turns out to draw nothing does not touch the canvas at all. That is not a
    // theoretical case: a selection whose items are all off screen is stale on
    // every frame of a pan and draws nothing on any of them, and clearing a
    // blank canvas to arrive at a blank canvas is the cost this module exists
    // to not pay.
    this.cleared = false;
    // Before even our own halo, because a peer's string outline composites with
    // `destination-out` and would erase anything already on the canvas — see
    // [`PeerPainter.strings`].
    let drew =
      peers !== null &&
      ropes !== null &&
      this.painter.strings(ctx, camera, scene, ropes, peers, this.clearOnce);
    // The halo next, so every other piece of chrome lands on top of it rather
    // than being washed out by it.
    if (wantsStrings && this.drawStrings(ctx, camera, scene, selection, ropes)) drew = true;
    // Straight after the halo and before every other piece of chrome, so a
    // string that is both hovered and selected still reads as selected first.
    if (wantsThreads && this.drawThreads(ctx, camera, scene, ropes, hoveredPin)) drew = true;
    // Under the selection outline rather than over it: a flash is transient and
    // the selection is a fact, and an amber ring painted across the outline of
    // something you have hold of would make the two read as one confused mark.
    if (wantsFlash && this.drawFlashes(ctx, camera, scene, flashes, ropes)) drew = true;
    if (this.drawSelection(ctx, camera, scene, selection)) drew = true;
    if (this.drawPins(ctx, camera, scene, selection)) drew = true;
    // A peer's boxes and rings, after our own and outside them, so that on
    // something both of us have hold of ours is the outline in front.
    if (peers !== null && this.painter.chrome(ctx, camera, scene, peers, this.clearOnce)) {
      drew = true;
    }
    // The rotation handle. `chromeFrame` is what decides that one item has one
    // and a group does not, and the select tool asks the same function where the
    // knob is â€” so what is drawn and what is grabbable cannot drift apart.
    const frame = chromeFrame(camera, scene, selection, this.frame);
    if (frame && this.drawRotateHandle(ctx, camera, frame)) drew = true;
    if (highlight !== null && this.drawCandidate(ctx, camera, scene, highlight)) drew = true;
    if (marquee) {
      this.drawMarquee(ctx, camera, marquee);
      drew = true;
    }
    if (wantsPending && this.drawPending(ctx, camera, pending)) drew = true;
    // Last, and over everything: it is the thing under the cursor, and a pin is
    // about to be born exactly where it sits.
    if (stringHover && this.drawStringHover(ctx, camera, stringHover)) drew = true;
    // After even that. Wet ink is over every piece of chrome on this canvas
    // because it is not chrome: it is a mark being made, and a selection outline
    // painted on top of the line you are drawing would read as the line going
    // *under* the photograph it is being drawn on.
    if (wantsWet && this.drawWet(ctx, camera, scene, wet)) drew = true;
    // And over even the ink. A pointer is not part of the picture the board is
    // making — it is the thing pointing at it, and one that can be hidden behind
    // a mark somebody is drawing is a pointer you lose exactly when two people
    // are working in the same place.
    if (peers !== null && this.painter.cursors(ctx, camera, peers, this.clearOnce)) drew = true;
    // Nothing to draw, but last frame there was â€” so the clear is the work.
    if (!drew && this.inked) this.clear(ctx);
    this.inked = drew;
  }

  /**
   * The string run in progress: straight legs between the stops, and a dashed
   * one to the cursor.
   *
   * Straight rather than sagging, deliberately. A run that has not been written
   * down has no rope in `sim/ropes.ts` and therefore no pose to draw, and
   * inventing one here would mean a second, subtly different catenary in the
   * renderer — and a visible jump at the moment the real one took over. A
   * drawn-taut run reads as intent rather than as string, which is what it is.
   */
  private drawPending(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    run: PendingRun,
  ): boolean {
    const points = run.points;
    if (!this.cleared) this.clear(ctx);
    ctx.save();
    ctx.lineWidth = PENDING_WIDTH;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = PENDING_STROKE;
    // A loop pulled out of a string is provisional end to end, so it is dashed
    // end to end — see [`PendingRun`].
    if (run.dashed === "all") ctx.setLineDash([...PENDING_DASH]);

    // The committed part of the run is solid.
    ctx.beginPath();
    for (let i = 0; i < points.length - 1; i++) {
      const p = camera.boardToScreen(points[i]!.x, points[i]!.y, this.a);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    const lastStop = camera.boardToScreen(
      points[points.length - 2]!.x,
      points[points.length - 2]!.y,
      this.a,
    );
    ctx.lineTo(lastStop.x, lastStop.y);
    ctx.stroke();

    // The leg chasing the cursor is dashed, because it is not a decision yet.
    const cursor = camera.boardToScreen(
      points[points.length - 1]!.x,
      points[points.length - 1]!.y,
      this.b,
    );
    ctx.setLineDash([...PENDING_DASH]);
    ctx.beginPath();
    ctx.moveTo(lastStop.x, lastStop.y);
    ctx.lineTo(cursor.x, cursor.y);
    ctx.stroke();
    ctx.restore();
    return true;
  }

  /**
   * The gesture in progress. All of the drawing is `render/ink/wet.ts`'s; this is
   * the deferred clear, and the one scene read that module is not allowed to do
   * for itself — so that a frame whose only content was a stroke that turned out
   * to be a single sample still does not touch the canvas.
   *
   * Every run, in the order the hand made them (T-137), each against its own
   * surface's frame. A run drawn on a photograph and a run drawn on the cork are
   * two different conversions of the same gesture, resolved one after the other.
   *
   * The frame is resolved here, in phase 8, and not carried on the stroke from
   * phase 1. A whole frame happens in between: the binding lands a peer's drag of
   * the very photograph being drawn on, and `sim/torsion.ts` steps its swing. Ink
   * placed against a pose fetched in the INPUT phase would trail the paper by
   * exactly one frame for the whole of a stroke, and would do it worst on the
   * gesture — drawing on something that is still swinging — where it is most
   * obvious.
   */
  private drawWet(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    scene: Scene,
    wet: readonly WetStroke[],
  ): boolean {
    if (!this.cleared) this.clear(ctx);
    let drew = false;
    for (const run of wet) {
      if (this.wetInk.draw(ctx, camera, run, this.inkFrame(scene, run.item))) drew = true;
    }
    return drew;
  }

  /**
   * Where the item a stroke is glued to is drawn — null for a board-space stroke,
   * and also for an item that is no longer on the board, which a peer's delete
   * can do with the pen still down.
   *
   * Exactly the frame `state/tools/frame.ts`'s `itemLocal` converted *into* when
   * the samples were taken, and that is the property to preserve: the two are
   * inverses, and the ink lands under the cursor only for as long as they agree.
   * Which is why the 2% a carried item is drawn at (`lib/carry.ts`) is
   * deliberately absent here — `itemLocal` does not apply it either, and a
   * renderer that did would put the mark 2% off the cursor rather than 2% off the
   * paper. The window where that could show at all is the fraction of a second a
   * just-dropped item takes to settle back to full size, since a pointer drawing
   * ink is not a pointer dragging paper.
   */
  private inkFrame(scene: Scene, itemId: string | null): ItemFrame | null {
    if (itemId === null) return null;
    const slot = scene.slotOf(itemId);
    if (slot === undefined) return null;
    const angle = scene.rot[slot]! + scene.swing[slot]!;
    this.ink.cx = scene.renderX(slot);
    this.ink.cy = scene.renderY(slot);
    this.ink.cos = Math.cos(angle);
    this.ink.sin = Math.sin(angle);
    // The paper the wet stroke is clipped to (T-136). Stored rather than
    // rendered size: the carry scale is deliberately absent from this frame, for
    // the reason above, so the clip must not have it either.
    this.ink.hw = scene.w[slot]! / 2;
    this.ink.hh = scene.h[slot]! / 2;
    return this.ink;
  }

  /**
   * The halo along a selected string, walked from the rope particles.
   *
   * From the particles rather than from the pins, for the reason the hit test
   * is: a string with any drape in it is nowhere near the chord between its
   * pins, and chrome drawn along the chord would sit in mid-air above the
   * string it claims to be marking.
   *
   * One `beginPath` per string rather than one for all of them, because the
   * width is the string's own thickness and a batch would have to share one.
   */
  private drawStrings(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    scene: Scene,
    selection: Selection,
    ropes: RopeGeometry,
  ): boolean {
    const pool = ropes.positions;
    const zoom = camera.zoom;
    const camX = camera.x;
    const camY = camera.y;
    let drew = false;

    for (const id of selection.strings) {
      const style = scene.strings.get(id);
      // A collaborator can delete a string this selection still names;
      // `Selection.prune` clears that up, but not before this frame draws.
      if (style === undefined) continue;

      let any = false;
      ctx.beginPath();
      ropes.visit(id, (at, count) => {
        ctx.moveTo((pool[at]! - camX) * zoom, (pool[at + 1]! - camY) * zoom);
        for (let i = 1; i < count; i++) {
          const j = at + i * 2;
          ctx.lineTo((pool[j]! - camX) * zoom, (pool[j + 1]! - camY) * zoom);
        }
        any = true;
      });
      if (!any) continue;

      this.clear(ctx);
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      // Screen pixels, like the string itself (`render/ropes/paint.ts`), so the
      // fringe either side of it is the same width at every zoom.
      // Off the *drawn* width, not the authored thickness: a yarn draws half
      // again as wide as it is stored, and a fringe sized off the number in the
      // document would be hidden under the strand — see [`bodyWidth`].
      const drawn = bodyWidth(style.thickness, style.material);
      ctx.lineWidth = drawn + STRING_HALO_WIDEN;
      ctx.strokeStyle = STRING_HALO;
      ctx.stroke();
      // And back out of the middle, so what is left is an outline rather than a
      // wash — see [`STRING_HALO`].
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = drawn + STRING_HALO_CLEAR;
      ctx.stroke();
      ctx.restore();
      drew = true;
    }
    return drew;
  }

  /**
   * Every string through the hovered pin, lit — DESIGN section 3.3.
   *
   * The whole reason this is cheap enough to do on a hover is
   * `Scene.stringsThrough`: without it the answer to "what hangs off this pin"
   * is a walk of every string on the board and every node in it, on every frame
   * the cursor moves across a pin.
   *
   * Walked from the rope particles rather than the pins, like the halo above
   * and for the same reason — a string with drape in it is nowhere near the
   * chord between its pins, and a highlight along the chord would sit in
   * mid-air over the string it claims to be lighting.
   */
  private drawThreads(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    scene: Scene,
    ropes: RopeGeometry,
    pinId: string,
  ): boolean {
    const through = scene.stringsThrough(pinId);
    if (through.size === 0) return false;

    const pool = ropes.positions;
    const zoom = camera.zoom;
    const camX = camera.x;
    const camY = camera.y;
    let drew = false;

    for (const id of through) {
      const style = scene.strings.get(id);
      if (style === undefined) continue;

      let any = false;
      ctx.beginPath();
      ropes.visit(id, (at, count) => {
        ctx.moveTo((pool[at]! - camX) * zoom, (pool[at + 1]! - camY) * zoom);
        for (let i = 1; i < count; i++) {
          const j = at + i * 2;
          ctx.lineTo((pool[j]! - camX) * zoom, (pool[j + 1]! - camY) * zoom);
        }
        any = true;
      });
      if (!any) continue;

      if (!drew) {
        this.clear(ctx);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = THREAD_LIT;
      }
      // The string's own drawn width, so the wash stays inside the cotton — see
      // [`THREAD_LIT`]. Set per string, because a hub pin can host strings of
      // different thicknesses and of different materials.
      ctx.lineWidth = bodyWidth(style.thickness, style.material);
      ctx.stroke();
      drew = true;
    }
    return drew;
  }

  /** The point on the string under the cursor — see [`STRING_HOVER_RADIUS`]. */
  private drawStringHover(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    point: Vec2,
  ): boolean {
    const p = camera.boardToScreen(point.x, point.y, this.a);
    const edge = STRING_HOVER_RADIUS + 2;
    if (p.x + edge < 0 || p.x - edge > camera.width) return false;
    if (p.y + edge < 0 || p.y - edge > camera.height) return false;

    this.clear(ctx);
    ctx.beginPath();
    ctx.arc(p.x, p.y, STRING_HOVER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = STRING_HOVER_FILL;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = STRING_HOVER_RING;
    ctx.stroke();
    return true;
  }

  /**
   * At most once per frame, and only from something about to draw.
   *
   * The context is pre-scaled by devicePixelRatio (`world.resizeCanvases`), so
   * every other coordinate in this file is in CSS pixels â€” the clear is taken
   * back to the identity so it covers the backing store exactly rather than
   * relying on this module knowing what the scale was.
   */
  private clear(ctx: CanvasRenderingContext2D): void {
    if (this.cleared) return;
    this.cleared = true;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  }

  /**
   * Did anything in the selection move, resize or turn this frame?
   *
   * Walks the dirty set rather than the selection because the dirty set is the
   * short one â€” one item under a drag, against a marquee that may hold every
   * photograph on the board.
   */
  private selectedMoved(selection: Selection, scene: Scene, dirty: DirtySets): boolean {
    if (selection.isBare) return false;
    if (dirty.all) return true;
    for (const id of dirty.items) if (selection.has(id)) return true;
    if (selection.pins.size === 0) return false;
    // A free pin dragged across bare cork is its own dirt — it moves without
    // any item moving, which is exactly what `dirty.pins` is for.
    for (const id of dirty.pins) if (selection.hasPin(id)) return true;
    // And a parented one rides the photograph it is pushed into, where the
    // *item* is what is dirty. Asked from the item side, because `dirty.items`
    // is the smaller set to walk and `pinsOf` is the index that makes it cheap.
    for (const id of dirty.items) {
      for (const pinId of scene.pinsOf(id)) if (selection.hasPin(pinId)) return true;
    }
    return false;
  }

  /**
   * Rings round the selected pins.
   *
   * Nothing selects a pin by itself — these arrive as part of a thread (DESIGN
   * section 3.3), so this is usually a scattering of rings across a whole
   * component rather than one.
   *
   * Two strokes, dark under pale, for the reason `drawCandidate` uses the same
   * pair: a single ring has to be legible on cork, on a white polaroid border
   * and on a black-and-white photograph, and no one colour is.
   */
  private drawPins(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    scene: Scene,
    selection: Selection,
  ): boolean {
    if (selection.pins.size === 0) return false;
    const radius = pinHitRadius(camera.zoom) + PIN_RING_PAD;
    let drew = false;

    for (const id of selection.pins) {
      const pin = scene.pins.get(id);
      // A collaborator can delete a pin this selection still names; `prune`
      // clears that up, but not before this frame draws.
      if (pin === undefined) continue;
      const at = camera.boardToScreen(pin.wx, pin.wy, this.a);
      if (at.x + radius < 0 || at.x - radius > camera.width) continue;
      if (at.y + radius < 0 || at.y - radius > camera.height) continue;

      if (!drew) {
        this.clear(ctx);
        ctx.lineWidth = PIN_RING_WIDTH + 2;
        ctx.strokeStyle = PIN_RING_UNDER;
        drew = true;
      }
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (!drew) return false;

    // The pale pass second and over the whole set, so the two strokes are two
    // state changes for the batch rather than two per pin.
    ctx.lineWidth = PIN_RING_WIDTH;
    ctx.strokeStyle = PIN_RING_OVER;
    for (const id of selection.pins) {
      const pin = scene.pins.get(id);
      if (pin === undefined) continue;
      const at = camera.boardToScreen(pin.wx, pin.wy, this.a);
      if (at.x + radius < 0 || at.x - radius > camera.width) continue;
      if (at.y + radius < 0 || at.y - radius > camera.height) continue;
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    return true;
  }

  /**
   * The amber pulse round everything the last undo touched — DESIGN section
   * 7.6, and `state/flash.ts` for the argument.
   *
   * Three shapes for the three kinds of thing, and each borrows the chrome
   * already proven for that kind: a box round an item, a ring round a pin, and
   * a light along a string. That is not economy of code — the point is that a
   * flash reads as *this thing changed*, so it has to be the shape of the
   * thing, and a box drawn round a string would be a box drawn round the
   * rectangle two pins happen to span.
   *
   * `globalAlpha` rather than a per-life `rgba()` string: this runs on every
   * frame of every flash, and building two colour strings per lit object per
   * frame is an allocation in the middle of phase 8.
   */
  private drawFlashes(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    scene: Scene,
    flashes: FlashSource,
    ropes: RopeGeometry | null,
  ): boolean {
    let drew = false;

    for (const [id, life] of flashes.items) {
      const slot = scene.slotOf(id);
      // The binding removes an item the moment a collaborator deletes it, and
      // a flash outlives its own frame — so this is the ordinary case here,
      // not the defensive one.
      if (slot === undefined) continue;

      const pad = FLASH_PAD + (1 - life) * FLASH_SPREAD;
      const scale = carryScale(scene.lift[slot]!);
      const hw = (scene.w[slot]! * camera.zoom * scale) / 2 + pad;
      const hh = (scene.h[slot]! * camera.zoom * scale) / 2 + pad;
      const centre = camera.boardToScreen(scene.renderX(slot), scene.renderY(slot), this.a);
      const reach = Math.hypot(hw, hh);
      if (centre.x + reach < 0 || centre.x - reach > camera.width) continue;
      if (centre.y + reach < 0 || centre.y - reach > camera.height) continue;

      this.clear(ctx);
      drew = true;
      ctx.save();
      ctx.globalAlpha = alphaOf(life);
      ctx.translate(centre.x, centre.y);
      // `rot + swing`, like the selection outline: a photograph knocked back
      // into place by an undo is still settling on its pin while it flashes.
      ctx.rotate(scene.rot[slot]! + scene.swing[slot]!);
      ctx.strokeStyle = FLASH_UNDER;
      ctx.lineWidth = FLASH_WIDTH + 2;
      ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
      ctx.strokeStyle = FLASH_OVER;
      ctx.lineWidth = FLASH_WIDTH;
      ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
      ctx.restore();
    }

    const head = pinHitRadius(camera.zoom);
    for (const [id, life] of flashes.pins) {
      const pin = scene.pins.get(id);
      if (pin === undefined) continue;
      const radius = head + FLASH_PAD + (1 - life) * FLASH_SPREAD;
      const at = camera.boardToScreen(pin.wx, pin.wy, this.a);
      if (at.x + radius < 0 || at.x - radius > camera.width) continue;
      if (at.y + radius < 0 || at.y - radius > camera.height) continue;

      this.clear(ctx);
      drew = true;
      ctx.save();
      ctx.globalAlpha = alphaOf(life);
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = FLASH_UNDER;
      ctx.lineWidth = FLASH_WIDTH + 2;
      ctx.stroke();
      ctx.strokeStyle = FLASH_OVER;
      ctx.lineWidth = FLASH_WIDTH;
      ctx.stroke();
      ctx.restore();
    }

    if (ropes === null || flashes.strings.size === 0) return drew;
    const pool = ropes.positions;
    const zoom = camera.zoom;
    const camX = camera.x;
    const camY = camera.y;
    for (const [id, life] of flashes.strings) {
      const style = scene.strings.get(id);
      if (style === undefined) continue;

      let any = false;
      ctx.beginPath();
      ropes.visit(id, (at, count) => {
        ctx.moveTo((pool[at]! - camX) * zoom, (pool[at + 1]! - camY) * zoom);
        for (let i = 1; i < count; i++) {
          const j = at + i * 2;
          ctx.lineTo((pool[j]! - camX) * zoom, (pool[j + 1]! - camY) * zoom);
        }
        any = true;
      });
      // A string whose pins have gone has no particles to walk, and there is
      // nothing to light along a curve that does not exist.
      if (!any) continue;

      this.clear(ctx);
      drew = true;
      const alpha = alphaOf(life);
      const drawn = bodyWidth(style.thickness, style.material);
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = FLASH_OVER;
      // A soft band outside the cotton and a wash inside it, both amber and
      // neither opaque. The pale outline a selected string gets is deliberately
      // not reused: at 0.85 of near-white it makes a string read as *faded*
      // (see [`STRING_HALO`]), which is why that one punches its own middle
      // back out — and a `destination-out` pass here would take the halo and
      // the lit threads underneath with it.
      ctx.globalAlpha = alpha * FLASH_STRING_GLOW;
      ctx.lineWidth = drawn + FLASH_SPREAD * (1 - life) + FLASH_WIDTH * 2;
      ctx.stroke();
      ctx.globalAlpha = alpha * FLASH_STRING_CORE;
      ctx.lineWidth = drawn;
      ctx.stroke();
      ctx.restore();
    }
    return drew;
  }

  /** True if it put anything on the canvas. */
  private drawSelection(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    scene: Scene,
    selection: Selection,
  ): boolean {
    if (selection.isEmpty) return false;
    let drew = false;

    for (const id of selection.members) {
      const slot = scene.slotOf(id);
      // A selection can name an item a collaborator has just deleted;
      // `Selection.prune` clears that up, but not before this frame draws.
      if (slot === undefined) continue;

      // The item's own box, which is exactly what `.pol-frame` and
      // `.paper-surface` occupy â€” both are `inset: 0` â€” so the line lands on the
      // paper's edge rather than on the item's bounding box.
      const scale = carryScale(scene.lift[slot]!);
      const hw = (scene.w[slot]! * camera.zoom * scale) / 2 + SELECT_PAD;
      const hh = (scene.h[slot]! * camera.zoom * scale) / 2 + SELECT_PAD;
      const centre = camera.boardToScreen(scene.renderX(slot), scene.renderY(slot), this.a);
      const cx = centre.x;
      const cy = centre.y;

      // Circle-against-viewport reject. Culling (T-27) has already unmounted the
      // item's node, but the selection is not culled and does not need to be â€”
      // the far side of a marquee that took in the whole board is a few
      // multiplications, not a DOM node.
      const reach = Math.hypot(hw, hh);
      if (cx + reach < 0 || cx - reach > camera.width) continue;
      if (cy + reach < 0 || cy - reach > camera.height) continue;

      // The rendered angle, `rot + swing`, so the chrome rides a photograph that
      // is still settling on its pin rather than sitting where it came to rest.
      // No half-pixel snapping: it only sharpens an axis-aligned line, and an
      // item that is exactly straight is the rare one on a board whose whole
      // aesthetic is that nothing is.
      this.clear(ctx);
      if (!drew) {
        // Set once for the whole selection, not per item.
        ctx.strokeStyle = SELECT_STROKE;
        ctx.lineWidth = SELECT_WIDTH;
        drew = true;
      }
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(scene.rot[slot]! + scene.swing[slot]!);
      ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
      ctx.restore();
    }
    return drew;
  }

  /**
   * The knob and its stalk, standing off the top edge of the paper in the
   * paper's own direction â€” so a note lying at 30Â° carries its handle at 30Â°
   * too, and the handle says which way is up on the thing it turns.
   *
   * The stalk starts at the outline rather than at the centre, so it is a short
   * mark in open cork instead of a line drawn across the photograph.
   */
  private drawRotateHandle(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    frame: HandleFrame,
  ): boolean {
    const knob = rotateHandle(frame, this.knob);
    const edge = HANDLE_RADIUS + SELECT_WIDTH;
    if (knob.x + edge < 0 || knob.x - edge > camera.width) return false;
    if (knob.y + edge < 0 || knob.y - edge > camera.height) return false;

    this.clear(ctx);
    ctx.strokeStyle = SELECT_STROKE;
    ctx.lineWidth = SELECT_WIDTH;
    ctx.beginPath();
    // From the outline out to the near side of the knob, so the line does not
    // show through the disc. Straight up the paper, like the knob itself.
    const cos = Math.cos(frame.angle);
    const sin = Math.sin(frame.angle);
    const near = rotateOut(0, -frame.hh, frame.cx, frame.cy, cos, sin, this.a);
    ctx.moveTo(near.x, near.y);
    const far = rotateOut(
      0,
      -(frame.hh + HANDLE_STALK - HANDLE_RADIUS),
      frame.cx,
      frame.cy,
      cos,
      sin,
      this.b,
    );
    ctx.lineTo(far.x, far.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(knob.x, knob.y, HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = SELECT_STROKE;
    ctx.fill();
    ctx.strokeStyle = HANDLE_RING;
    ctx.stroke();
    return true;
  }

  /**
   * The candidate ring: the item's own box, the same geometry the selection
   * outline uses, a couple of pixels further out and in the opposite value.
   *
   * Independent of whether the item is selected, and drawn after it, so a pin
   * dragged onto something already selected still says so.
   */
  private drawCandidate(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    scene: Scene,
    id: string,
  ): boolean {
    const slot = scene.slotOf(id);
    if (slot === undefined) return false;

    const scale = carryScale(scene.lift[slot]!);
    const hw = (scene.w[slot]! * camera.zoom * scale) / 2 + CANDIDATE_PAD;
    const hh = (scene.h[slot]! * camera.zoom * scale) / 2 + CANDIDATE_PAD;
    const centre = camera.boardToScreen(scene.renderX(slot), scene.renderY(slot), this.a);
    const reach = Math.hypot(hw, hh);
    if (centre.x + reach < 0 || centre.x - reach > camera.width) return false;
    if (centre.y + reach < 0 || centre.y - reach > camera.height) return false;

    this.clear(ctx);
    ctx.save();
    ctx.translate(centre.x, centre.y);
    ctx.rotate(scene.rot[slot]! + scene.swing[slot]!);
    ctx.lineWidth = CANDIDATE_WIDTH + 2;
    ctx.strokeStyle = CANDIDATE_UNDER;
    ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
    ctx.lineWidth = CANDIDATE_WIDTH;
    ctx.strokeStyle = CANDIDATE_OVER;
    ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
    ctx.restore();
    return true;
  }

  private drawMarquee(ctx: CanvasRenderingContext2D, camera: Camera, marquee: Bounds): void {
    this.clear(ctx);
    const a = camera.boardToScreen(marquee.minX, marquee.minY, this.a);
    const b = camera.boardToScreen(marquee.maxX, marquee.maxY, this.b);
    const x0 = a.x;
    const y0 = a.y;
    const w = b.x - x0;
    const h = b.y - y0;

    ctx.fillStyle = MARQUEE_FILL;
    ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = MARQUEE_STROKE;
    ctx.lineWidth = 1;
    // Half-pixel offset, or a one-pixel line straddles two rows and renders as
    // a soft two-pixel one.
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(w), Math.round(h));
  }
}
