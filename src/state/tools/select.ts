/**
 * The select tool — `V`, and the one the board starts in.
 *
 * Click to select, `Shift`+click to add, drag on empty cork for a marquee,
 * `Ctrl+A` for everything visible, `Delete` to remove, `R`+drag or the rotation
 * handle to rotate, and an edge of a sheet of paper to resize it (DESIGN
 * sections 3.2 and 3.8).
 *
 * ## The chrome is asked first
 *
 * A press is offered to the selection's handles before it is offered to the
 * board, because the rotation knob stands off the top edge in open cork and the
 * resize band straddles the paper's edge — in both cases the press would
 * otherwise mean something else entirely, and in the knob's case that something
 * else is a marquee that clears the selection the knob belongs to. Where the
 * handles are is `state/handles.ts`, shared with the overlay that draws them, so
 * that what is grabbable and what is visible are the same geometry.
 *
 * ## Nothing snaps to anything
 *
 * > There is no grid, no alignment guide, no distribution tool. This is
 * > deliberate and it is not a missing feature. — DESIGN section 3.2
 *
 * So a drag is arithmetic and nothing else: every selected item's start pose
 * plus the board-space delta the cursor has travelled. No rounding, no
 * quantisation, no candidate positions. The delta is measured between two
 * *board* points rather than accumulated from screen deltas, which also means
 * zooming mid-drag leaves the item exactly where it was under the cursor.
 *
 * ## Carried, not teleported
 *
 * > While an item is dragged, its shadow lifts and softens, it scales up by
 * > about 2%, and it gains a slight lag-and-catch-up rotation in the direction
 * > of travel. On release it settles. — DESIGN section 3.2
 *
 * None of that is in the document, so all of it lives in the scene's two
 * transient arrays — `lift` and `swing` — and is stepped in `tick()` from the
 * frame's dt. There are no CSS transitions on board content, by rule
 * (ARCHITECTURE section 3): the loop owns every pixel of motion, which is also
 * why the lag survives a paused tab and a 5 fps frame rate without lurching.
 *
 * ## The document sees two writes per drag, not sixty
 *
 * A throttled `live` write every half second is crash safety (DESIGN section
 * 7.3); the `final` write is the release. Both are queued and flushed in phase
 * 9, and their origins are chosen so the undo manager merges them into one
 * entry — one drag, one undo.
 */

import { rotateIn, rotateOut, type Point } from "@/lib/rotate";
import { presetSlack, toggleTaut } from "@/lib/slack";
import type { Bounds, Vec2 } from "@/state/camera";
import {
  chromeFrame,
  emptyFrame,
  handleAt,
  handleAxes,
  type HandleFrame,
  type HandleId,
} from "@/state/handles";
import { eraseSelection } from "@/state/erase";
import type { ItemPose, StringNode, StringNodes } from "@/state/scene";
import type { SelectionSnapshot } from "@/state/selection";
import { threadFrom } from "@/state/thread";
import {
  anchorAt,
  anchorParent,
  itemLocal,
  settleOnPin,
  stringAt,
} from "@/state/tools/frame";
import { PinDrag } from "@/state/tools/pindrag";
import { QuickPull } from "@/state/tools/quickpull";
import { Scissors } from "@/state/tools/scissors";
import type {
  PointerSample,
  StringHit,
  Tool,
  ToolContext,
  ToolHint,
  ToolInput,
  WritePose,
  WriteSize,
} from "@/state/tools/tool";

/** Screen pixels the pointer must travel before a press becomes a drag. Below
 *  this, a click that trembles is still a click. */
const DRAG_THRESHOLD_PX = 3;

/**
 * What a turn of the wheel is adjusting.
 *
 * > | Adjust one segment | Wheel over a selected segment | Slack up or down |
 * > | Adjust the whole string | `Alt`+wheel | All segments together |
 * > — DESIGN section 3.4
 *
 * The two are different enough to be different shapes. One gap is named by the
 * node it starts at, because that is what survives a concurrent insert; a whole
 * string is named by the selection it came out of, snapshotted, because the
 * modifier is read once at the start of a roll and so is what it applied to.
 */
type SlackRoll =
  | { readonly kind: "segment"; readonly string: string; readonly nodeId: string }
  | { readonly kind: "whole"; readonly strings: readonly string[] };

/**
 * Crash-safety write interval during a drag.
 *
 * DESIGN section 7.3 says "a throttled write every half second... merged into
 * the same undo entry", and those two clauses are in conflict: DATA-MODEL
 * section 11 fixes the undo manager at `captureTimeout: 400`, and merging is
 * purely a matter of the gap between transactions — the origin decides whether
 * a change is *tracked*, never whether it *merges*. Write every 500 ms and
 * every one of them lands 100 ms outside the window, so a three-second drag
 * becomes seven undo entries and Ctrl+Z walks the photograph home in hops.
 *
 * "One drag, one undo entry" (section 3.2) is the requirement; half a second
 * was the illustration. So: comfortably inside 400.
 */
export const LIVE_WRITE_MS = 300;

/** Time constants for the carry. Picking up is quicker than putting down,
 *  which is what reads as weight rather than as a lag spike. */
const LIFT_RISE_MS = 55;
const LIFT_FALL_MS = 130;

/**
 * The lag. `LAG_PER_VELOCITY` is radians per screen-pixel-per-millisecond of
 * travel; a brisk drag is around 2 px/ms, so the cap is reached at speed and
 * approached gently below it.
 *
 * Positive velocity gives positive rotation, and that direction is not
 * arbitrary: an object held at the top and carried to the right trails to the
 * left of its pivot, which in a y-down space is a clockwise turn.
 */
const LAG_PER_VELOCITY = 0.045;
const LAG_MAX_RAD = 0.08;
const LAG_TAU_MS = 70;

/** Below this, a transient is written to exactly zero and stops costing a
 *  dirty flag. Three thousandths of a degree; nobody is watching. */
const SETTLED_EPSILON = 5e-5;

/** Screen pixels from the pivot inside which a rotation angle is noise. */
const ROTATE_DEAD_RADIUS_PX = 24;

/**
 * Wheel delta to slack factor — one 100 px mouse notch multiplies the slack by
 * about 1.22.
 *
 * **Multiplicative, like the zoom and for the same reason.** Slack is a ratio
 * with no natural step: an additive nudge that reads as a gentle adjustment at
 * a heavy drape walks straight through the minimum at a taut one, and one that
 * is safe at the taut end takes a hundred notches to reach the other. A factor
 * is the same *proportion* of drape wherever on the ladder you are.
 *
 * Brisker than the zoom's rate because the coarse control already exists: `1`-`9`
 * get you to the right neighbourhood in one keystroke, so the wheel's job is the
 * last little bit, and about twenty-five notches end to end is the fine end of
 * usable rather than the coarse.
 *
 * The sign follows the zoom's — wheel away from you for more, which on this
 * board already means more magnification and here means more sag. See Q-14.
 */
const WHEEL_SLACK_RATE = 0.002;

/**
 * How long after the last notch a slack roll stays latched to the segment it
 * started on, in milliseconds.
 *
 * Without this the gesture eats itself. Rolling slack *up* lets the rope droop,
 * and the rope drooping is the rope leaving the eight screen pixels either side
 * of the cursor that made it grabbable — so somewhere mid-roll the board would
 * stop claiming the wheel and the camera would start zooming instead, which
 * reads as the application having lost its mind. A roll therefore keeps hold of
 * the gap it began on, exactly as a drag keeps hold of the handle it began on,
 * until the wheel stops.
 *
 * Comfortably longer than the gap between notches of a continuous roll and
 * shorter than the pause before someone means something else by the wheel.
 */
const SLACK_ROLL_IDLE_MS = 250;

/**
 * The smallest a sheet of paper can be dragged down to, in board units.
 *
 * The schema floor is one unit (invariant 6), and an item one unit across is a
 * dot: legal, unhittable, and unrecoverable without undo. Items arrive between
 * about 170 and 330 units across (`lib/polaroid.ts`), so this is small enough to
 * be a deliberate scrap and large enough to still be a thing you can get hold of.
 */
export const MIN_RESIZE = 24;

type GesturePhase =
  | "idle"
  | "pending"
  /** Drag from the middle of a string: a loop of it being pulled out to a new
   *  pin — the headline gesture (DESIGN 3.4). */
  | "looping"
  | "dragging"
  | "rotating"
  | "resizing"
  | "marquee"
  /** Drag over the page of an open case file: a rectangle being cut out of it
   *  as a clipping — T-282. Square with the *page*, never with the screen. */
  | "clip"
  | "pin";

function approach(current: number, target: number, dt: number, tau: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/**
 * The preset a key code names, or null if it names none.
 *
 * By `code` rather than `key`, like every other binding on the board: `Digit1`
 * is the physical key and is the same on every layout, where `key` is `"1"` on a
 * US keyboard and `"&"` on a French one. `machine.ts` already filters to bare
 * `Digit1`-`Digit9` and `Numpad1`-`Numpad9`, so this is a parse rather than a
 * second gate — and it is here rather than there because which keys mean
 * something is the tool's business.
 */
function presetFor(code: string): number | null {
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return digit === null ? null : Number(digit[1]);
}

/**
 * The free pins inside a board rectangle — what `Ctrl+A` and a marquee sweep
 * up alongside the items (T-106).
 *
 * **Free ones only.** A parented pin is part of its paper: it travels with the
 * item for nothing, because its stored position is in item-local space, and
 * selecting it beside its own item would transform it twice. DESIGN section
 * 3.8 draws exactly that line — "group rotation transports parented pins for
 * free ... but free pins inside the selection have their board coordinates
 * transformed as leaves of the same transform". A free pin has no paper to
 * carry it, which is the same sentence read the other way round and is why it
 * has to be a member in its own right.
 *
 * A pin is a **point**, not a disc. It is in if its board position is in,
 * which is the rule that needs no radius and does not change with zoom — and
 * for a free pin `lx`/`ly` *are* the board position, so this asks nothing of
 * the LAYOUT phase having run.
 */
function freePinsIn(ctx: ToolContext, rect: Bounds): string[] {
  const found: string[] = [];
  for (const pin of ctx.scene.pins.values()) {
    if (pin.parent !== null) continue;
    if (
      pin.lx >= rect.minX &&
      pin.lx <= rect.maxX &&
      pin.ly >= rect.minY &&
      pin.ly <= rect.maxY
    ) {
      found.push(pin.id);
    }
  }
  return found;
}

/**
 * The node a grabbed segment *ends* at: the next one along whose pin still
 * resolves, wrapping round a closed run.
 *
 * Not `from + 1`, which is what this used to assume. Since T-77 a rope segment
 * runs from each resolving node to the next resolving one, *however many dead
 * ones lie between* — DATA-MODEL section 8.1's "a string node pointing at a
 * missing pin is skipped at render time". So on a run that a peer's delete left
 * a node behind in, the node immediately after the segment's start is quite
 * possibly the dead one, and reading it as the far end refused the whole
 * gesture on a string that draws, hovers and reports a hit perfectly well.
 *
 * `sim/ropes.ts` makes this exact walk when it builds the segment; this is the
 * tool asking the same question of the scene, which is the side of the seam it
 * is allowed to read. The two must agree, or the loop is measured against a pin
 * the string is not actually drawn to.
 *
 * Wrapping unconditionally is safe on an open run: there, a node is only ever a
 * segment's start if some later node resolves, so the walk finds one before it
 * gets round. Null means nothing does — a run with no drawable segment left,
 * which is no gesture rather than a bad one.
 */
function farNode(ctx: ToolContext, run: StringNodes, from: number): StringNode | null {
  for (let step = 1; step < run.nodes.length; step++) {
    const node = run.nodes[(from + step) % run.nodes.length];
    if (node && ctx.scene.pins.has(node.pin)) return node;
  }
  return null;
}

export class SelectTool implements Tool {
  readonly id = "select";

  /**
   * What this tool does, for the info bar — see [`ToolHint`].
   *
   * The longest of the eight, because select is where everything that is not a
   * pen lives. Every row below names a gesture implemented in *this* file, and
   * two of them say something more careful than the old hint line did:
   *
   *   - `Shift`+click **toggles**. Pressing it on something already selected
   *     takes it out, and ends the gesture there — a sentence reading "adds to
   *     the selection" would be wrong half the time somebody used it.
   *   - the wheel, `Alt`+wheel and `1`-`9` all need the string **selected**
   *     first. Rolling the wheel over an unselected one is the camera's, and
   *     the readout has to say which, or the gesture reads as broken.
   *
   * `Alt`+drag, `Alt`+click and `Ctrl`+`Alt`+click are absent on purpose: those
   * three belong to `quickpull.ts` and `scissors.ts` and work in *every* tool,
   * so they are declared once as ambient rows rather than eight times here.
   */
  readonly hint: ToolHint = {
    name: "Select",
    key: "V",
    verb: "drag to move · drag the cork to marquee · a note's edge resizes",
    rows: [
      { keys: "Shift+click", does: "add one, or take it out", holds: ["Shift"] },
      { keys: "Shift+drag", does: "marquee on to the selection", holds: ["Shift"] },
      { keys: "R+drag", does: "rotate without the handle" },
      { keys: "Ctrl+drag a pin", does: "keep it in its own item", holds: ["Control"] },
      { keys: "double-click a pin", does: "follow the whole thread" },
      // The gesture nothing else on the board suggests, which is this readout's
      // whole reason for existing: a case file offers *Open* on its menu and
      // there is no other sign that the key exists. Shutting it says so here
      // too, because clicking away deliberately does *not* do it (T-273) — so
      // without this line an open folder is a state with no visible way out.
      // A cassette is named in the same row rather than given one of its own,
      // because it is the same key on the same selection — and because what it
      // does is the one thing on this board a person could otherwise press
      // twice by mistake: nothing opens, nothing is covered, and the only sign
      // it worked is the spools starting to turn (T-277).
      { keys: "Enter", does: "open a case file or play a tape, and Esc shuts it" },
      // Beside it rather than anywhere else, because it is only meaningful
      // while the line above has been used — and because the arrows are the
      // one binding on this board that nobody would think to try on cork.
      { keys: "arrows", does: "turn a page in an open case file" },
      { keys: "wheel", does: "sag one gap, selected string" },
      { keys: "Alt+wheel", does: "sag every gap at once", holds: ["Alt"] },
      { keys: "1-9", does: "slack presets, taut to slack" },
      { keys: "Shift+Delete", does: "remove, but leave the pins", holds: ["Shift"] },
    ],
  };

  private phase: GesturePhase = "idle";

  /** `Alt` on a pin, which is nobody's tool — `state/tools/quickpull.ts`. */
  private readonly pull = new QuickPull();
  /** `Ctrl`+`Alt` on a string: the cut that belongs to no tool either (Q-186). */
  private readonly scissors = new Scissors();

  pullPreview(cursor: { x: number; y: number } | null): readonly { x: number; y: number }[] | null {
    return this.pull.preview(cursor);
  }

  /**
   * The string a press landed on, before the press became a drag. A click that
   * never moves selects it instead (DESIGN section 3.4).
   */
  private pendingString: StringHit | null = null;

  /**
   * The insertion being pulled out of a string, held from the press until the
   * release — and *only* here, because nothing about it is written until then.
   * That is the whole of AC-71: `Esc` mid-drag reverts by dropping these.
   *
   * The two neighbouring pins are held by id rather than by position, so the
   * chords are measured against wherever they are at the moment of the release
   * rather than wherever they were when the string was grabbed.
   */
  private loopString: string | null = null;
  /**
   * The node the grabbed segment starts at, by id — the new pin goes behind it.
   *
   * By id and not by position, for the same reason `loopFrom`/`loopTo` are pin
   * ids: this is captured at the press and not spent until the release queues a
   * write, and a peer inserting anywhere earlier in the run renumbers a position
   * inside that window. The gesture would then pull a loop out of a segment
   * nobody grabbed, with nothing on screen to say so.
   */
  private loopAfter: string | null = null;
  /** Arc-length fraction along the grabbed segment — where the user took hold
   *  of the string, which is what the split divides the sag at. */
  private loopT = 0;
  /**
   * The gap's slack before the split is deliberately *not* held here.
   *
   * The sum of the two halves has to come back to it or the string flinches at
   * the instant the gesture succeeds — but the value that has to be conserved
   * is the one at the moment of the write, and this tool would be remembering
   * the one from pointer-down. `crdt/ops/strings.ts` reads it inside the
   * transaction instead (DATA-MODEL section 5.4); all this sends is geometry.
   */
  private loopFrom: string | null = null;
  private loopTo: string | null = null;
  /** The three-point run drawn while the loop is out. Reused rather than minted
   *  per frame; the overlay reads it and does not keep it. */
  private readonly loopPoints: Vec2[] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];

  /**
   * The loop being pulled out, for `render/overlay.ts` — the pin behind, the
   * cursor, and the pin ahead.
   *
   * > A new pin is born at that point on the string, free-floating, and follows
   * > your cursor. The string now runs *through* it. — DESIGN section 3.4
   *
   * Straight legs, like the string tool's run and for the same reason: there is
   * no rope for a node that has not been written down, and inventing a second
   * catenary here would show as a jump the moment the real one took over.
   */
  loopPreview(cursor: { x: number; y: number } | null): readonly Vec2[] | null {
    if (this.phase !== "looping" || !cursor) return null;
    this.loopPoints[1]!.x = cursor.x;
    this.loopPoints[1]!.y = cursor.y;
    return this.loopPoints;
  }


  /** Where the press landed, in both spaces. */
  private downX = 0;
  private downY = 0;
  private downBoardX = 0;
  private downBoardY = 0;

  /** The most recent pointer position, screen space. */
  private lastX = 0;
  private lastY = 0;
  /** Where it was at the previous tick — the whole of the velocity model. */
  private prevTickX = 0;

  /** Pose of every item the gesture picked up, at the moment it picked it up. */
  private readonly starts = new Map<string, ItemPose>();

  /**
   * The same, for the **free** pins the gesture picked up — board coordinates,
   * which is what a free pin's stored position is.
   *
   * > Group rotation transports parented pins for free — they're in item-local
   * > space — but free pins inside the selection have their board coordinates
   * > transformed as leaves of the same transform. Miss that and rotating a
   * > selection visibly shears the string web. — DESIGN section 3.8
   *
   * Which is why only the free ones are here. A parented pin is stored in its
   * item's frame and arrives at the right place for nothing, and putting it in
   * this map would move it *twice*.
   *
   * Empty for every gesture but one. Nothing else selects a pin: these arrive
   * through follow-the-thread, which is the gesture DESIGN section 3.8 says
   * exists so you can "grab an entire thread of an investigation and move it
   * somewhere else".
   */
  private readonly pinStarts = new Map<string, Vec2>();
  /** The same ids, as a set, because phase 3 asks "is this one held?" of every
   *  item it is about to swing and a Map's keys are not a set. */
  private readonly holding = new Set<string>();

  /**
   * The carry lag, eased — one number for the whole gesture rather than one per
   * item, because it is a property of how fast the *hand* is moving.
   *
   * Kept here as well as written into the scene so that `sim/torsion.ts` can
   * add it on top of where a single-pinned item hangs, rather than the two
   * fighting over one Float32Array.
   */
  private lag = 0;

  /** Items whose `lift`/`swing` are not zero and not finished moving. */
  private readonly animating = new Set<string>();

  /** Selection at the moment a marquee began, so `Shift` extends rather than
   *  replaces — and so `Esc` can put it back. Every kind, because a sweep now
   *  gathers free pins as well as items and an extend has to keep both. */
  private marqueeBase: SelectionSnapshot = { items: [], strings: [], pins: [] };
  private rect: Bounds | null = null;
  private readonly rectBuf: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  /**
   * The open case file a clipping is being cut out of, and where the press
   * landed in its own frame — T-282.
   *
   * **Item-local, and that is the whole reason this is not the marquee.** A
   * folder sits at its seeded angle and goes on sitting at it while you read
   * it: `readItem` flies the camera to the item's *bounds* and never turns it
   * square to the screen. So a rectangle tracked in board space would be
   * skewed against the lines of the page, and the picture cut out of it would
   * come out with the text running off one corner. Tracked in the page's own
   * frame it is square with what is written on it, which is what a cutting is.
   */
  private clipItem: string | null = null;
  private clipDownX = 0;
  private clipDownY = 0;
  private readonly clipBuf: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private clipRect: Bounds | null = null;
  /** The four corners of {@link clipRect} in board space, for the overlay —
   *  a quad rather than a rect, because the page is turned. Reused. */
  private readonly clipQuad: Vec2[] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];

  /**
   * Pressing an item that is *already* selected must not collapse the
   * selection, or a group could never be dragged — but a plain click on one
   * still has to mean "just this one" (DESIGN section 3.8). So the intent is
   * recorded here at pointer-down and only acted on at pointer-up, if the
   * gesture turned out not to be a drag.
   */
  private pendingSelect: string | null = null;

  /**
   * Was the press that is still pending the second of a double-click? Recorded
   * at pointer-down and acted on at pointer-up, alongside the rest of what the
   * press landed on — because pressing twice on a string and *then* pulling
   * means pull a loop out of it, not toggle it taut as well.
   */
  private pendingDouble = false;

  /**
   * The slack roll in progress, latched to what the first notch decided, or null
   * between rolls. See `SLACK_ROLL_IDLE_MS` for why it is latched at all.
   */
  private slackRoll: SlackRoll | null = null;
  /** Milliseconds since the last notch, for expiring the latch. */
  private sinceRoll = 0;

  /** Reused, because the camera hands back a fresh object otherwise and this
   *  runs on every pointer move of every gesture. */
  private readonly board: Vec2 = { x: 0, y: 0 };
  /** Two, not one: a resize converts a point in and another one back out on the
   *  same pointer move, and sharing a scratch between them is a trap. */
  private readonly probe: Point = { x: 0, y: 0 };
  private readonly placed: Point = { x: 0, y: 0 };

  private pivotX = 0;
  private pivotY = 0;
  private rotateApplied = 0;
  private lastAngle: number | null = null;

  /**
   * Which piece of selection chrome this gesture started on, or null for a press
   * that landed on the board itself. Set at pointer-down and read at `begin`,
   * because the handle under the *press* is what the gesture means — by the time
   * it has become a drag the pointer is somewhere else entirely.
   */
  private grabbed: HandleId | null = null;
  private resizeId: string | null = null;
  /** Which way the grabbed edge pushes, in the item's un-rotated frame. */
  private axisU = 0;
  private axisV = 0;
  /** Reused; `chromeFrame` fills it rather than minting one per press. */
  private readonly frame: HandleFrame = emptyFrame();

  private sinceWrite = 0;
  /** Has this gesture already put a crash-safety pose in the document? */
  private wroteLive = false;

  /**
   * Pins are grabbable in the select tool, not only in the pin tool — DESIGN
   * section 3.3 names the tool for the three rows that *place* a pin and for
   * none of the rows that manipulate one, and section 6.2 puts pins in a layer
   * of their own labelled "hit targets", above items. See `state/tools/pin.ts`.
   *
   * The gesture itself lives next door because it shares none of this tool's
   * state: no selection, no start poses, no marquee.
   */
  private readonly pinDrag = new PinDrag();
  /** The pin a press took hold of, before the press became a drag. */
  private pendingPin: string | null = null;

  /** The marquee rectangle in **board** coordinates, or null. Board rather
   *  than screen so it stays anchored to the cork if the camera moves under
   *  it. Read by the overlay in phase 8. */
  get marquee(): Bounds | null {
    return this.rect;
  }

  /**
   * The clipping rectangle as four **board**-space corners, or null — T-282.
   *
   * A quad and not a `Bounds` because it is square with a page that is turned,
   * so there is no axis-aligned box that describes it. Converted here rather
   * than in the overlay for the reason the marquee is converted there: what the
   * overlay is owed is where to draw, and the frame the rectangle lives in is
   * this gesture's business and nobody else's.
   *
   * Clockwise from the corner the press landed on, which is the order a path
   * wants and the order the harvest reads it back in.
   */
  get clipping(): readonly Vec2[] | null {
    return this.clipRect === null ? null : this.clipQuad;
  }

  /** True while a gesture is in progress — the pointer is captured and the
   *  board is being changed. */
  get gesturing(): boolean {
    return this.phase !== "idle";
  }

  /**
   * The handle this gesture has hold of, or null. Read by the cursor, which must
   * keep saying "resize" while the pointer is dragged far away from the edge it
   * started on — a cursor that reverts halfway through the gesture reads as the
   * gesture having been dropped.
   */
  get activeHandle(): HandleId | null {
    return this.grabbed;
  }

  /**
   * The item a pin being dragged would parent to if it were let go now, or
   * null. Drawn as a ring by the overlay — "candidate items highlight with a
   * ring" (DESIGN section 3.3), which is the only feedback that says whether
   * the drop has taken before you commit to it.
   */
  get pinCandidate(): string | null {
    return this.pinDrag.candidate;
  }

  /**
   * The items this gesture has hold of, and the carry rotation it has built up.
   *
   * Read by `sim/torsion.ts` in phase 3. A single-pinned item's `swing` belongs
   * to the swing simulation, not to this tool — it does not settle to zero, it
   * settles to wherever the item hangs — so the two divide it: this owns the
   * lag, that owns the hang, and the sum is written once, over there.
   */
  get heldItems(): ReadonlySet<string> {
    return this.holding;
  }

  get carryLag(): number {
    return this.lag;
  }

  /**
   * The segment this gesture is in the middle of splitting, or null.
   *
   * > Take an advisory lock on the segment over awareness, purely as a UX hint
   * > — never as a correctness mechanism. — docs/DATA-MODEL.md section 5.4
   *
   * Read once a frame by whoever publishes presence, which is the only reader
   * there is or should be. Nothing in this tool asks it: a segment somebody
   * else has hold of is one this gesture may still split, and 5.4 says so in
   * the same sentence that asks for the lock.
   *
   * Named by the two pins it runs between, because that is what a receiver can
   * find on their own board — `state/presence.ts` has the argument.
   */
  get heldSegment(): { string: string; a: string; b: string } | null {
    if (this.loopString === null || this.loopFrom === null || this.loopTo === null) return null;
    return { string: this.loopString, a: this.loopFrom, b: this.loopTo };
  }

  /**
   * Where a held item was pivoting when the gesture took hold, for the items
   * this tool knows better than the scene does — which today is exactly one:
   * the item a pin being dragged hangs from, because the pin whose position
   * phase 3 would otherwise read is the one this gesture is moving.
   *
   * Empty for every other gesture. A drag or a rotation moves the item and
   * leaves its pins where they are in its own frame, so the scene is still the
   * best answer and `sim/torsion.ts` goes on asking it.
   */
  get heldPivots(): ReadonlyMap<string, { lx: number; ly: number }> {
    return this.pinDrag.heldPivots;
  }

  handle(input: ToolInput, ctx: ToolContext): void {
    // The scissors first. Both of these belong to no tool (DESIGN section 3.4);
    // this one is offered ahead of the pull because it is the more specific
    // press — `Ctrl`+`Alt` rather than `Alt` — and a pin sitting over the string
    // being aimed at must not turn a cut into a pin removal.
    if (this.scissors.handle(input, ctx)) return;

    // `Alt` on a pin belongs to no tool — see `state/tools/quickpull.ts`. Offered
    // the input before anything here looks at it, because the press it takes is
    // one this tool would otherwise turn into a marquee.
    if (this.pull.handle(input, ctx)) return;
    switch (input.kind) {
      case "down":
        this.onDown(input.at, ctx, input.double === true);
        break;
      case "move":
        this.onMove(input.at, ctx);
        break;
      case "up":
        this.onUp(input.at, ctx);
        break;
      case "cancel":
        this.cancel(ctx);
        break;
      case "key":
        this.onKey(input, ctx);
        break;
      case "wheel":
        this.onWheel(input.at, input.dy, ctx);
        break;
    }
  }

  /**
   * Does a wheel notch here mean slack rather than zoom?
   *
   * Asked by the camera, from inside the wheel listener, before it decides
   * whether to zoom — so this is pure, and `onWheel` below asks the same
   * question again in the INPUT phase and gets the same answer. See
   * `Tool.claimsWheel`.
   */
  claimsWheel(at: PointerSample, ctx: ToolContext): boolean {
    return this.slackTarget(at, ctx) !== null;
  }

  /**
   * One notch of the wheel, on a string.
   *
   * The document is handed a *factor* rather than a value in both cases. A tool's
   * writes are queued to phase 9, so a slack read here is always one frame older
   * than the write it would produce: reading and multiplying in the tool would
   * make a steady roll move the sag once and then keep re-deriving the same
   * answer from the same stale number. `crdt/ops/strings.ts` compounds it
   * instead.
   */
  private onWheel(at: PointerSample, dy: number, ctx: ToolContext): void {
    const target = this.slackTarget(at, ctx);
    // Only reachable if the claim and this disagreed, which the latch is there
    // to make impossible after the first notch. Dropping the latch is still the
    // right response: whatever it was holding is no longer there.
    if (target === null) {
      this.slackRoll = null;
      return;
    }
    this.slackRoll = target;
    this.sinceRoll = 0;

    // Away from the user is more sag, which is the sign the zoom already uses
    // for "more" on this board (Q-14).
    const factor = Math.exp(-dy * WHEEL_SLACK_RATE);
    if (target.kind === "whole") ctx.write.scaleStringSlack(target.strings, factor);
    else ctx.write.scaleNodeSlack(target.string, target.nodeId, factor);
  }

  /**
   * What a wheel notch at this point, with these modifiers, would adjust — or
   * null, which means the camera keeps it.
   *
   * Pure: `claimsWheel` runs it from a listener. Nothing here writes, and the
   * only state it reads that a frame can change is the scene and the selection.
   */
  private slackTarget(at: PointerSample, ctx: ToolContext): SlackRoll | null {
    // `Ctrl`+wheel is a zoom on every engine and is what a trackpad pinch
    // synthesises, so it is never ours. Nor is a wheel arriving in the middle of
    // a drag — the gesture in progress is what the pointer is doing.
    if (at.ctrl || this.gesturing) return null;

    /**
     * No selected string and nothing latched: the notch is the camera's, and
     * this says so without a hit test.
     *
     * Selection is what disambiguates the whole gesture — both branches below
     * end in `selection.hasString` — so this is the same answer arrived at
     * sooner, not a different rule. It earns its place because the question
     * stopped being one-per-notch: `ToolMachine.wheelClaimed` asks it once a
     * frame so the cursor can say which way the wheel will go, and an idle
     * board with the pointer at rest on it must stay free.
     */
    if (ctx.selection.strings.size === 0 && this.slackRoll === null) return null;

    // A roll already under way keeps what it took hold of, even once the sag has
    // drooped out from under the cursor — which is the point (`SLACK_ROLL_IDLE_MS`).
    const latched = this.liveRoll(ctx);
    if (latched !== null) return latched;

    // > Adjust the whole string | `Alt`+wheel — DESIGN section 3.4, and unlike
    // the per-segment case it asks nothing about where the cursor is. That is
    // the whole difference between them: one needs aiming and one does not.
    if (at.alt) {
      const strings = [...ctx.selection.strings];
      return strings.length > 0 ? { kind: "whole", strings } : null;
    }

    // > Wheel over a **selected** segment. Selection is what disambiguates this
    // from a zoom, so a string merely under the cursor is not enough — and
    // `stringAt` is the same function the press and the hover highlight use, so
    // the wheel cannot claim a segment a click would not have offered.
    const hit = stringAt(
      ctx.scene,
      ctx.camera,
      ctx.hitTest,
      ctx.hitPin,
      ctx.hitString,
      at.x,
      at.y,
    );
    if (hit === null || !ctx.selection.hasString(hit.string)) return null;
    const nodeId = ctx.scene.strings.get(hit.string)?.nodes[hit.node]?.nodeId;
    return nodeId === undefined ? null : { kind: "segment", string: hit.string, nodeId };
  }

  /**
   * The latched roll, if it is still a thing that exists — a collaborator can
   * cut the string mid-roll, and a click elsewhere can deselect it.
   *
   * Does not clear the latch when it answers null, because it is called from
   * `claimsWheel`, which may not change anything. `onWheel` and `tick` are what
   * let go.
   */
  private liveRoll(ctx: ToolContext): SlackRoll | null {
    const roll = this.slackRoll;
    if (roll === null) return null;
    if (roll.kind === "segment") {
      return ctx.selection.hasString(roll.string) && ctx.scene.strings.has(roll.string)
        ? roll
        : null;
    }
    for (const id of roll.strings) {
      if (!ctx.selection.hasString(id) || !ctx.scene.strings.has(id)) return null;
    }
    return roll;
  }

  // --- pointer --------------------------------------------------------------

  private onDown(at: PointerSample, ctx: ToolContext, double: boolean): void {
    // A collaborator may have deleted something we still think we have hold
    // of. Dragging a ghost silently does nothing, which is the worst kind.
    ctx.selection.prune(
      (id) => ctx.scene.has(id),
      (id) => ctx.scene.strings.has(id),
      (id) => ctx.scene.pins.has(id),
    );

    this.downX = this.lastX = this.prevTickX = at.x;
    this.downY = this.lastY = at.y;
    this.pendingSelect = null;
    this.pendingPin = null;
    this.pendingString = null;
    this.pendingDouble = double;
    this.grabbed = null;
    const board = ctx.camera.screenToBoard(at.x, at.y, this.board);
    this.downBoardX = board.x;
    this.downBoardY = board.y;

    /**
     * The chrome gets the press before the board does, and that ordering is the
     * whole reason the handle works at all: the rotation knob stands off the top
     * edge in open cork, so a press that reached it would otherwise fall through
     * to `hitTest`, find nothing, and start a marquee — which clears the very
     * selection the knob belongs to. The edges are the same story one step in,
     * where falling through starts a drag instead of a resize.
     *
     * Nothing about the selection changes here, `Shift` included. Pressing an
     * item's own handle is not a statement about what is selected.
     */
    const frame = chromeFrame(ctx.camera, ctx.scene, ctx.selection, this.frame);
    const handle = frame ? handleAt(frame, at.x, at.y) : null;
    if (handle !== null) {
      this.grabbed = handle;
      this.phase = "pending";
      return;
    }

    /**
     * A pin, then. It beats the item beneath it because it is physically on
     * top of it — and nothing about the selection changes, for the same reason
     * pressing a handle does not: taking hold of a pin is not a statement about
     * which photographs are selected.
     *
     * The `Alt` press on a pin never reaches here: it is a quick pull or a
     * removal, and `state/tools/quickpull.ts` has already taken it.
     */
    const pin = ctx.hitPin(at.x, at.y);
    if (pin !== null) {
      this.pendingPin = pin;
      this.phase = "pending";
      return;
    }

    /**
     * A string, then — the headline gesture (DESIGN section 3.4), and it beats
     * the item under it for the same reason the pin does: where a run is drawn
     * over items it is physically on top of them. `stringAt` is what decides
     * that, and it is the same function the hover highlight asks, so a press
     * cannot mean something the highlight did not offer.
     *
     * Which of the two things a press on a string means — pull a loop out, or
     * select it — is not decided here. The pointer decides, exactly as it does
     * for `Alt` on a pin: travel makes it a pull, stillness makes it a click.
     */
    const onString = stringAt(
      ctx.scene,
      ctx.camera,
      ctx.hitTest,
      ctx.hitPin,
      ctx.hitString,
      at.x,
      at.y,
    );
    if (onString !== null) {
      this.pendingString = onString;
      this.phase = "pending";
      return;
    }

    /**
     * A drag over the page of an open case file cuts a clipping out of it
     * rather than dragging the folder the page is in — T-282, D-46 section 3.
     *
     * **No modifier, and the press is still unambiguous**, which is the whole
     * reason this gesture could be built at all: T-230 searched for a free
     * modifier and found none, and `isScissors` exists because `Ctrl`+`Alt` was
     * the only pair left. What makes a bare drag safe here is that the two
     * questions below are already asked by other people for other reasons and
     * together they name exactly one surface on the board.
     *
     * `inkHitTest` stops at the **silhouette**, and `DomItemLayer.silhouette`
     * has answered "the A4 sheet" rather than "the folder" for an open case
     * file since T-278 — that is what makes redaction land on the page. And
     * `shownPage` is non-null for the one item that is open and nothing else.
     * So this is true only over paper somebody is reading.
     *
     * Which leaves the folder draggable by the kraft you can see either side of
     * the page: that margin is inside the item's rectangle and outside the
     * sheet's silhouette, so `hitTest` claims it and this does not. The page
     * cuts, the border moves — and a shut folder is unchanged in every way.
     */
    const page = ctx.inkHitTest(board.x, board.y);
    if (page !== null && ctx.shownPage(page) !== null) {
      const local = itemLocal(ctx.scene, page, board.x, board.y);
      if (local !== null) {
        this.clipItem = page;
        this.clipDownX = local.x;
        this.clipDownY = local.y;
        this.clipBuf.minX = this.clipBuf.maxX = local.x;
        this.clipBuf.minY = this.clipBuf.maxY = local.y;
        this.clipRect = this.clipBuf;
        this.quadFrom(ctx);
        this.phase = "clip";
        return;
      }
    }

    const hit = ctx.hitTest(board.x, board.y);

    if (hit === null) {
      // Empty cork: a marquee. Without Shift it starts from nothing, which is
      // also what makes a plain click on the cork a deselect.
      if (!at.shift) ctx.selection.clear();
      this.marqueeBase = ctx.selection.snapshot();
      this.rectBuf.minX = this.rectBuf.maxX = board.x;
      this.rectBuf.minY = this.rectBuf.maxY = board.y;
      this.rect = this.rectBuf;
      this.phase = "marquee";
      return;
    }

    if (at.shift) {
      ctx.selection.toggle(hit);
      // Shift-clicking something *out* of the selection must not then drag the
      // rest of it around — the gesture was a deselect and it is over.
      if (!ctx.selection.has(hit)) {
        this.phase = "idle";
        return;
      }
    } else if (!ctx.selection.has(hit)) {
      ctx.selection.replace([hit]);
    } else {
      // Already selected. Keep the rest of the selection for now so a group
      // drag works, and narrow to this one at release if no drag happened.
      this.pendingSelect = hit;
    }

    this.phase = "pending";
  }

  private onMove(at: PointerSample, ctx: ToolContext): void {
    this.lastX = at.x;
    this.lastY = at.y;

    switch (this.phase) {
      case "pending": {
        const dx = at.x - this.downX;
        const dy = at.y - this.downY;
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        if (!this.begin(ctx)) return;
        // Fall through into the first frame of the gesture, so the item does
        // not sit still for the frame in which it was picked up.
        this.applyGesture(ctx);
        return;
      }
      case "dragging":
      case "rotating":
      case "resizing":
      case "pin":
      case "looping":
        this.applyGesture(ctx);
        return;
      case "marquee":
        this.applyMarquee(at, ctx);
        return;
      case "clip":
        this.applyClip(at, ctx);
        return;
      default:
        return;
    }
  }

  private onUp(at: PointerSample, ctx: ToolContext): void {
    /**
     * The two ends of the string gesture, and the same shape as the `Alt` one
     * above. A loop that got as far as moving writes the new pin and the node
     * that carries it; one that never moved was a click, and
     *
     * > A plain click without dragging selects the string instead.
     * > — DESIGN section 3.4
     */
    if (this.phase === "looping") {
      this.commitLoop(at, ctx);
      this.resetLoop();
      this.phase = "idle";
      ctx.dirty.camera = true;
      return;
    }
    if (this.pendingString !== null) {
      const hit = this.pendingString;
      this.pendingString = null;
      ctx.selection.replaceStrings([hit.string]);
      /**
       * > | Toggle taut | Double-click a segment | Snaps between taut and
       * > default slack | — DESIGN section 3.4
       *
       * The second click of the double, which by now has already selected the
       * string on the first one — so the toggle and the selection are the same
       * two presses rather than a gesture that needs setting up.
       *
       * Absolute rather than a factor, unlike the wheel: this one is a *state*
       * and it needs the current slack to know which of the two states to go to.
       * Reading it here is safe where reading it for the wheel is not, because
       * nothing is compounding — a second double-click computed from a frame-old
       * number gives the same answer, and the answer is one of two values.
       */
      const node = ctx.scene.strings.get(hit.string)?.nodes[hit.node];
      if (this.pendingDouble) {
        if (node) {
          ctx.write.setNodeSlack(hit.string, node.nodeId, toggleTaut(node.slackAfter));
        }
      }
      this.pendingDouble = false;
      this.phase = "idle";
      return;
    }

    if (this.phase === "pin") {
      this.lastX = at.x;
      this.lastY = at.y;
      this.pinDrag.move(at.x, at.y, ctx);
      this.pinDrag.end(ctx);
      // Let go: the item is free to re-hang from wherever the pin ended up.
      this.holding.clear();
    } else if (
      this.phase === "dragging" ||
      this.phase === "rotating" ||
      this.phase === "resizing"
    ) {
      // The release position is part of the gesture. Skipping it drops the
      // last few pixels of a fast flick, which is exactly where the pointer
      // moves furthest between samples.
      this.lastX = at.x;
      this.lastY = at.y;
      this.applyGesture(ctx);
      this.commit(ctx, "final");
      this.release();
    } else if (this.phase === "marquee") {
      this.rect = null;
    } else if (this.phase === "clip") {
      const item = this.clipItem;
      const rect = this.clipRect;
      /**
       * A press that never became a drag is a click, and a click on a page is
       * not a cut — AC-855, and the same threshold every other gesture in this
       * tool uses. Measured in **screen** pixels like `DRAG_THRESHOLD_PX`
       * itself, because what is being asked is whether the hand moved, and at
       * 30% zoom a board-unit floor would refuse deliberate rectangles while at
       * 300% it would let a tremor cut one.
       *
       * It falls through to selecting the folder rather than doing nothing.
       * Clicking a thing you are looking at and having the board ignore you is
       * worse than the small surprise of it becoming selected, and it is what a
       * click anywhere else on an item already means.
       */
      if (item !== null && rect !== null) {
        const px = ctx.camera.zoom;
        const wide = (rect.maxX - rect.minX) * px >= DRAG_THRESHOLD_PX;
        const tall = (rect.maxY - rect.minY) * px >= DRAG_THRESHOLD_PX;
        if (wide && tall) ctx.clip(item, rect);
        else ctx.selection.replace([item]);
      }
      this.resetClip();
    } else if (this.pendingSelect !== null) {
      // A press on an already-selected item that never became a drag. It was a
      // click, so it means that one item — DESIGN section 3.8, "click to
      // select" — and the group it was standing in goes.
      ctx.selection.replace([this.pendingSelect]);
      /**
       * > Click into a note or a polaroid's caption area to edit.
       * > — DESIGN section 3.6
       *
       * Which cannot be a plain click, because a plain click on paper is
       * select-and-drag. Q-92 settled it as the double, and this is where the
       * second press lands: the first one selected the item, so by now it is
       * the already-selected one above.
       *
       * At the release and only if the press never became a drag, exactly as
       * follow-the-thread and toggle-taut are — pressing twice on a note and
       * *then* pulling means drag the note, and it must not also leave a caret
       * behind in something the pointer has since moved off.
       */
      if (this.pendingDouble) ctx.edit(this.pendingSelect);
    } else if (this.pendingPin !== null && this.pendingDouble) {
      /**
       * > | Follow the thread | Double-click | Selects the entire connected
       * > component of pins, strings and items | — DESIGN section 3.3
       *
       * At the release and only if the press never became a drag, for the same
       * reason toggle-taut is: pressing twice on a pin and *then* pulling means
       * drag the pin, which is the primary verb a pin has, and it must not also
       * select half the board on the way past.
       *
       * A single click on a pin still leaves the selection exactly as it found
       * it — see the note below. So the first click of the double does nothing
       * and the second does all of it, which is what makes this composable with
       * a pin drag rather than a mode.
       */
      const thread = threadFrom(ctx.scene, this.pendingPin);
      ctx.selection.replaceThread(thread.items, thread.strings, thread.pins);
    }
    this.pendingSelect = null;
    this.pendingDouble = false;
    // A click on a handle that never became a drag rotates and resizes by
    // nothing, which is the right amount, and must not deselect either. A click
    // on a pin is the same: it moves the pin nowhere, and leaves the selection
    // exactly as it found it.
    this.pendingPin = null;
    this.grabbed = null;
    this.phase = "idle";
  }

  /**
   * `R` is read here rather than at pointer-down so that pressing it after
   * putting the cursor down still rotates — which is how people actually reach
   * for a modifier they only just decided they wanted. The *handle*, by
   * contrast, was decided at pointer-down, because a handle is a place and the
   * pointer has left it by now.
   *
   * Returns false if there turned out to be nothing to pick up.
   */
  private begin(ctx: ToolContext): boolean {
    // The press landed on a string and the pointer has moved, so a loop is
    // being pulled out of it. Like the pull above, nothing is written until the
    // release says where the new pin goes.
    if (this.pendingString !== null) {
      const hit = this.pendingString;
      this.pendingString = null;
      if (!this.beginLoop(hit, ctx)) {
        this.phase = "idle";
        return false;
      }
      this.phase = "looping";
      return true;
    }

    // A pin was under the press, so this drag is that pin's and nothing else's
    // — no selection is picked up and no item moves.
    if (this.pendingPin !== null) {
      const pin = this.pendingPin;
      this.pendingPin = null;
      if (!this.pinDrag.begin(pin, this.downX, this.downY, ctx)) {
        this.phase = "idle";
        return false;
      }
      this.phase = "pin";
      this.markPinHold();
      return true;
    }

    // This is a drag, so the click that would have narrowed the selection to
    // one item is off.
    this.pendingSelect = null;
    this.starts.clear();
    this.pinStarts.clear();
    this.holding.clear();
    this.resizeId = null;
    for (const id of ctx.selection.members) {
      const pose = ctx.scene.poseOf(id);
      if (!pose) continue;
      this.starts.set(id, pose);
      this.holding.add(id);
      this.animating.add(id);
    }
    // The free pins of a thread, which travel as leaves of whatever transform
    // the items get (DESIGN section 3.8). A parented one is skipped because it
    // is stored in its item's frame and comes along for nothing — and would
    // otherwise be moved twice.
    for (const id of ctx.selection.pins) {
      const pin = ctx.scene.pins.get(id);
      if (!pin || pin.parent !== null) continue;
      this.pinStarts.set(id, { x: pin.lx, y: pin.ly });
    }
    if (this.starts.size === 0) {
      this.phase = "idle";
      return false;
    }

    this.sinceWrite = 0;
    this.prevTickX = this.lastX;

    if (this.grabbed !== null && this.grabbed !== "rotate") {
      // A resize handle only exists on a single selection (`state/handles.ts`),
      // so there is exactly one item here and it is the one that was grabbed.
      const axes = handleAxes(this.grabbed);
      this.axisU = axes.u;
      this.axisV = axes.v;
      for (const id of this.starts.keys()) this.resizeId = id;
      this.phase = "resizing";
      return true;
    }

    if (this.grabbed === "rotate" || ctx.held.has("KeyR")) {
      /**
       * What is being turned about what.
       *
       * A single item hanging on a single pin turns about **the pin**, because
       * the pin is stuck in the cork and does not move — the same rule the
       * swing follows (`sim/torsion.ts`), and the one place it was not being
       * followed. Turning such an item about its own centre slides the pin
       * across the board for as long as the handle is held, which is exactly
       * the thing that makes a hanging photograph read as a sticker.
       *
       * Otherwise the centre of what is being turned: for a rigid or loose item
       * its own centre, so it spins in place; for a group the middle of the
       * group, so the whole arrangement turns as one thing.
       */
      const sole = this.solePinPivot(ctx);
      const bounds = sole ? null : ctx.scene.boundsOfMany(this.starts.keys());
      this.pivotX = sole ? sole.wx : bounds ? (bounds.minX + bounds.maxX) / 2 : this.downBoardX;
      this.pivotY = sole ? sole.wy : bounds ? (bounds.minY + bounds.maxY) / 2 : this.downBoardY;
      this.rotateApplied = 0;
      this.lastAngle = null;
      this.phase = "rotating";
    } else {
      this.phase = "dragging";
    }
    return true;
  }

  /**
   * While a pin is being dragged, the items at either end of the move count as
   * held — which stops `sim/torsion.ts` swinging them.
   *
   * Without this the gesture chases itself: moving the pin changes where the
   * item hangs, the item swings, and a parented pin's world position is derived
   * from the item's pose — so the item carries the pin out from under the
   * cursor and the pin becomes almost impossible to place. Freezing the swing
   * for the duration means the pin goes exactly where it is put and the item
   * re-hangs when it is let go, which is also what happens when you move a pin
   * on a wall: the photograph does not move until you take your hand off it.
   */
  /**
   * The pin a rotation should turn about, or null.
   *
   * One item, one pin. A group has no single pin to turn about, and asking two
   * pinned photographs to rotate about one of their pins would swing the other
   * one across the board.
   *
   * `wx`/`wy` are the pin's world position, which for a hanging item is
   * invariant under the swing by construction — so the arithmetic below holds
   * whether the item is mid-swing or settled: rotating its stored centre about
   * this point and adding the same angle to `rot` leaves the pin exactly here.
   */
  private solePinPivot(ctx: ToolContext): { wx: number; wy: number } | null {
    if (this.starts.size !== 1) return null;
    for (const id of this.starts.keys()) return ctx.scene.solePin(id);
    return null;
  }

  private markPinHold(): void {
    this.holding.clear();
    const from = this.pinDrag.origin;
    const onto = this.pinDrag.candidate;
    if (from !== null) this.holding.add(from);
    if (onto !== null) this.holding.add(onto);
  }

  /**
   * Take hold of the segment the press landed on: which string, where in its
   * run the new node goes, and which two pins the split is between.
   *
   * `hit.node` is the index of the node the segment *starts* at, and it is read
   * once, here, on the frame of the press — what is kept is that node's id, so
   * that the write at the release still means this segment. On the wrap segment
   * of a closed run the node it starts at is the last one, and inserting behind
   * the last node is the end of the run, which is where a node between the last
   * pin and the first one belongs (DATA-MODEL section 5.2).
   *
   * The segment's far end is `farNode`, not the next node along: since T-77 a
   * segment steps over nodes whose pins have gone, and this has to step over
   * the same ones or it measures the loop against a pin the string is not drawn
   * to — which, when that pin does not exist, refused the gesture outright.
   *
   * Returns false if the run or either of its pins has gone — a collaborator
   * can delete the string between the press and the pointer moving, and pulling
   * a loop out of nothing should be no gesture at all rather than a write.
   */
  private beginLoop(hit: StringHit, ctx: ToolContext): boolean {
    const run = ctx.scene.strings.get(hit.string);
    if (!run) return false;
    const from = run.nodes[hit.node];
    if (!from || !ctx.scene.pins.has(from.pin)) return false;
    const to = farNode(ctx, run, hit.node);
    if (!to) return false;

    this.loopString = hit.string;
    this.loopAfter = from.nodeId;
    this.loopT = hit.t;
    this.loopFrom = from.pin;
    this.loopTo = to.pin;
    this.refreshLoop(ctx);
    return true;
  }

  /** Where the two neighbouring pins are *now*, for the preview. Re-read every
   *  move rather than captured at the press, so a loop held while a
   *  collaborator drags the photograph at one end stays attached to it. */
  private refreshLoop(ctx: ToolContext): void {
    const a = this.loopFrom === null ? undefined : ctx.scene.pins.get(this.loopFrom);
    const b = this.loopTo === null ? undefined : ctx.scene.pins.get(this.loopTo);
    if (a) {
      this.loopPoints[0]!.x = a.wx;
      this.loopPoints[0]!.y = a.wy;
    }
    if (b) {
      this.loopPoints[2]!.x = b.wx;
      this.loopPoints[2]!.y = b.wy;
    }
  }

  /**
   * The release: one write, or none.
   *
   * The drop lands by the same rule every other string end does — a pin, an
   * item that gets its own pin, or the bare cork (`anchorAt`) — and the two
   * slack ratios come from `lib/slack.ts` against the chords as they are at this
   * instant. That is the critical detail of the whole gesture:
   *
   * > when the string splits at that point, the slack must split proportionally
   * > so the two new segments together sag exactly as the original did. Get this
   * > wrong and the string visibly jumps at the moment of insertion.
   * > — DESIGN section 3.4
   *
   * A drop onto a hanging item carries one more thing: that item's pose, by
   * `settleOnPin` and in the same transaction, because the pin being written is
   * the one that stops it hanging.
   */
  private commitLoop(at: PointerSample, ctx: ToolContext): void {
    const stringId = this.loopString;
    const after = this.loopAfter;
    const from = this.loopFrom;
    const to = this.loopTo;
    if (stringId === null || after === null || from === null || to === null) return;
    const a = ctx.scene.pins.get(from);
    const b = ctx.scene.pins.get(to);
    if (!a || !b) return;

    const drop = anchorAt(ctx.scene, ctx.camera, ctx.hitTest, ctx.hitPin, at.x, at.y);
    // Dropped back onto one of the two pins this segment already runs between.
    // That is a node with nothing on one side of it — a duplicate stop, not a
    // pin in the middle of anything — so nothing is written, which is the same
    // revert `Esc` gives and the same rule the `Alt` pull follows.
    if ("pin" in drop.anchor && (drop.anchor.pin === from || drop.anchor.pin === to)) return;

    // Chords only, and the node the gap starts at by id. Both the slack this
    // gets divided against and the position it lands at are the op's to read in
    // the transaction that writes them: what this tool holds is a press old, and
    // the write does not land until the next flush.
    ctx.write.insertPin(
      stringId,
      after,
      drop.anchor,
      {
        chord: Math.hypot(b.wx - a.wx, b.wy - a.wy),
        first: Math.hypot(drop.x - a.wx, drop.y - a.wy),
        second: Math.hypot(b.wx - drop.x, b.wy - drop.y),
        t: this.loopT,
      },
      settleOnPin(ctx.scene, [anchorParent(drop.anchor)]),
    );
  }

  /** Let go of the segment. Nothing to put back: nothing was written. */
  private resetLoop(): void {
    this.loopString = null;
    this.loopAfter = null;
    this.loopFrom = null;
    this.loopTo = null;
  }

  private applyGesture(ctx: ToolContext): void {
    if (this.phase === "pin") {
      this.pinDrag.move(this.lastX, this.lastY, ctx);
      this.markPinHold();
      return;
    }
    if (this.phase === "resizing") {
      this.applyResize(ctx);
      return;
    }
    if (this.phase === "looping") {
      // Nothing on the board moves while a loop is out — the string is still
      // exactly where the document says it is, and the pulled shape lives in
      // the overlay until the release writes it down.
      this.refreshLoop(ctx);
      return;
    }

    const board = ctx.camera.screenToBoard(this.lastX, this.lastY, this.board);

    if (this.phase === "rotating") {
      const dx = board.x - this.pivotX;
      const dy = board.y - this.pivotY;
      const dead = ROTATE_DEAD_RADIUS_PX / ctx.camera.zoom;
      if (dx * dx + dy * dy < dead * dead) {
        // Too close to the pivot for the direction to mean anything. Drop the
        // reference so coming back out re-anchors instead of snapping.
        this.lastAngle = null;
      } else {
        const angle = Math.atan2(dy, dx);
        if (this.lastAngle !== null) {
          let step = angle - this.lastAngle;
          // Crossing the ±pi seam is a small step the long way round.
          if (step > Math.PI) step -= 2 * Math.PI;
          else if (step < -Math.PI) step += 2 * Math.PI;
          this.rotateApplied += step;
        }
        this.lastAngle = angle;
      }

      // Hoisted, so turning forty selected items about one pivot costs two
      // calls to Math.cos rather than eighty.
      const cos = Math.cos(this.rotateApplied);
      const sin = Math.sin(this.rotateApplied);
      for (const [id, start] of this.starts) {
        const turned = rotateOut(
          start.x - this.pivotX,
          start.y - this.pivotY,
          this.pivotX,
          this.pivotY,
          cos,
          sin,
          this.probe,
        );
        ctx.scene.setPose(id, {
          x: turned.x,
          y: turned.y,
          rot: start.rot + this.rotateApplied,
        });
        ctx.dirty.item(id);
      }
      // The free pins turn about the same pivot by the same angle, and gain no
      // rotation of their own — a pushpin has none. About the *items'* pivot
      // deliberately, rather than one recomputed to include the pins: the
      // rotation handle is drawn from `chromeFrame`, which is items only, and a
      // pivot the handle does not sit on turns the selection about a point
      // nobody pointed at.
      for (const [id, start] of this.pinStarts) {
        const turned = rotateOut(
          start.x - this.pivotX,
          start.y - this.pivotY,
          this.pivotX,
          this.pivotY,
          cos,
          sin,
          this.probe,
        );
        this.movePin(ctx, id, turned.x, turned.y);
      }
      return;
    }

    const dx = board.x - this.downBoardX;
    const dy = board.y - this.downBoardY;
    for (const [id, start] of this.starts) {
      ctx.scene.setPose(id, { x: start.x + dx, y: start.y + dy });
      ctx.dirty.item(id);
    }
    for (const [id, start] of this.pinStarts) {
      this.movePin(ctx, id, start.x + dx, start.y + dy);
    }
  }

  /**
   * One free pin to a board point, in the mirror.
   *
   * `wx`/`wy` as well as `lx`/`ly`, and not left to the LAYOUT phase: a free
   * pin's world position is only recomputed from its stored one by
   * `Scene.layoutPin`, which runs in phase 4 — but `sim/ropes.ts` reads pin
   * world positions in phase 3, a phase *earlier*. Setting only the stored pair
   * would leave every string anchored to the pin's previous position for the
   * frame, which on a dragged thread is the whole web trailing a frame behind.
   */
  private movePin(ctx: ToolContext, id: string, x: number, y: number): void {
    const pin = ctx.scene.pins.get(id);
    if (!pin) return;
    pin.lx = x;
    pin.ly = y;
    pin.wx = x;
    pin.wy = y;
    ctx.dirty.pin(id);
  }

  /**
   * The edge follows the cursor and the opposite edge stays exactly where it is.
   *
   * All of it happens in the item's own un-rotated frame — the cursor's travel is
   * rotated into that frame, the size changes along those axes, and the centre's
   * compensating half-step is rotated back out. Working in board space instead
   * would mean the east edge of a note lying at 30° grew towards the screen's
   * right rather than towards the note's own right, which is not what the cursor
   * looked like it was doing.
   *
   * Measured from the press point against the *start* pose rather than
   * accumulated per move, for the same reason the drag is (see the file header):
   * zooming mid-gesture then leaves the edge under the cursor instead of drifting
   * off it, and the clamp at [`MIN_RESIZE`] cannot ratchet. When an axis is
   * clamped the centre stops moving with it, because both come from the same
   * clamped size — so a note squashed to the floor and dragged further stays put
   * rather than sliding away.
   *
   * The angle is the item's *authored* rotation, not the rendered one. A resize
   * cannot start while the item is still turning, and the settling swing of an
   * item just released is at most a few degrees for a few frames.
   */
  private applyResize(ctx: ToolContext): void {
    const id = this.resizeId;
    const start = id === null ? undefined : this.starts.get(id);
    if (id === null || !start) return;

    const board = ctx.camera.screenToBoard(this.lastX, this.lastY, this.board);
    const cos = Math.cos(start.rot);
    const sin = Math.sin(start.rot);
    // How far the cursor has travelled, in the item's frame. The press point is
    // the centre of that frame, so the "point" being converted is the delta.
    const travel = rotateIn(board.x, board.y, this.downBoardX, this.downBoardY, cos, sin, this.probe);

    const w = this.axisU === 0 ? start.w : Math.max(MIN_RESIZE, start.w + this.axisU * travel.x);
    const h = this.axisV === 0 ? start.h : Math.max(MIN_RESIZE, start.h + this.axisV * travel.y);
    // Half the growth, towards the edge being dragged, so the other one holds.
    const centre = rotateOut(
      (this.axisU * (w - start.w)) / 2,
      (this.axisV * (h - start.h)) / 2,
      start.x,
      start.y,
      cos,
      sin,
      this.placed,
    );

    ctx.scene.setPose(id, { x: centre.x, y: centre.y, w, h });
    ctx.dirty.item(id);
  }

  /**
   * Walks every item on the board per pointer move. That is a few thousand
   * cheap arithmetic tests at the very worst, it only happens while a marquee
   * is actually being dragged, and the alternative is a spatial index that has
   * to be kept correct — which is T-27's job and worth doing once, there.
   */
  private applyMarquee(at: PointerSample, ctx: ToolContext): void {
    const board = ctx.camera.screenToBoard(at.x, at.y, this.board);
    const rect = this.rectBuf;
    rect.minX = Math.min(this.downBoardX, board.x);
    rect.minY = Math.min(this.downBoardY, board.y);
    rect.maxX = Math.max(this.downBoardX, board.x);
    rect.maxY = Math.max(this.downBoardY, board.y);
    this.rect = rect;

    const inside = new Set(this.marqueeBase.items);
    for (const id of ctx.scene.itemIds()) {
      if (ctx.scene.intersectsRect(id, rect)) inside.add(id);
    }
    const pins = new Set(this.marqueeBase.pins);
    for (const id of freePinsIn(ctx, rect)) pins.add(id);
    // The strings ride along untouched: a sweep says nothing about them, and
    // dropping one an extend started from would make Shift a partial extend.
    ctx.selection.replaceThread(inside, this.marqueeBase.strings, pins);
  }

  /**
   * The clipping rectangle, tracked in the page's own frame — T-282.
   *
   * The cursor is converted *in* on every move rather than the rectangle being
   * converted out once at the end, because the page can move under the gesture:
   * a folder hanging on one pin is still swinging while you read it, and
   * `itemLocal` goes through the pose it is **drawn** at. Tracking in board
   * space and converting at the release would hand the harvest a rectangle
   * measured against wherever the paper happened to be when the press landed.
   */
  private applyClip(at: PointerSample, ctx: ToolContext): void {
    const item = this.clipItem;
    if (item === null) return;
    const board = ctx.camera.screenToBoard(at.x, at.y, this.board);
    const local = itemLocal(ctx.scene, item, board.x, board.y);
    // The paper has gone — deleted, or taken away by a peer mid-gesture. There
    // is nothing left to cut out of, and nothing has been written.
    if (local === null) {
      this.resetClip();
      this.phase = "idle";
      return;
    }
    const rect = this.clipBuf;
    rect.minX = Math.min(this.clipDownX, local.x);
    rect.minY = Math.min(this.clipDownY, local.y);
    rect.maxX = Math.max(this.clipDownX, local.x);
    rect.maxY = Math.max(this.clipDownY, local.y);
    this.clipRect = rect;
    this.quadFrom(ctx);
  }

  /**
   * The clipping rectangle's four corners in board space, for the overlay.
   *
   * Through the item's **rendered** pose, like every other conversion a tool
   * makes against paper (`state/tools/frame.ts`): the rectangle has to be drawn
   * over the page where the page actually is, swing and all, or the outline
   * would slide off the paper it is supposed to be cutting.
   */
  private quadFrom(ctx: ToolContext): void {
    const item = this.clipItem;
    const rect = this.clipRect;
    if (item === null || rect === null) return;
    const slot = ctx.scene.slotOf(item);
    if (slot === undefined) return;
    const angle = ctx.scene.renderRot(slot);
    const cx = ctx.scene.renderX(slot);
    const cy = ctx.scene.renderY(slot);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    rotateOut(rect.minX, rect.minY, cx, cy, cos, sin, this.clipQuad[0]!);
    rotateOut(rect.maxX, rect.minY, cx, cy, cos, sin, this.clipQuad[1]!);
    rotateOut(rect.maxX, rect.maxY, cx, cy, cos, sin, this.clipQuad[2]!);
    rotateOut(rect.minX, rect.maxY, cx, cy, cos, sin, this.clipQuad[3]!);
  }

  private resetClip(): void {
    this.clipItem = null;
    this.clipRect = null;
  }

  // --- keys -----------------------------------------------------------------

  private onKey(
    input: Extract<ToolInput, { kind: "key" }>,
    ctx: ToolContext,
  ): void {
    switch (input.code) {
      case "Escape":
        // Mid-gesture Escape reverts; otherwise it shuts an open case file,
        // and only if there was not one does it drop the selection. That order
        // is the one Escape has everywhere: it undoes the most recent thing you
        // put on the screen, and an open folder is more recent than a selection
        // you must already have had to open it.
        if (this.gesturing) this.cancel(ctx);
        else if (!ctx.open(null)) ctx.selection.clear();
        return;

      case "ArrowLeft":
      case "ArrowRight": {
        /**
         * Turning a page in an open case file — T-321.
         *
         * The arrows were the only unbound keys left on this board and they are
         * also the right ones: every reader anybody has used turns a page with
         * them, so this is a binding nobody has to be taught. DESIGN section 3.9
         * carries it, which is the rule that decides whether a shortcut may
         * exist at all — "a binding that is not in the table is a binding nobody
         * can find".
         *
         * Left is back and right is forward, which is the direction the folder
         * itself argues for: opening turns its fold to the left and the paper
         * edge to the right, so forward is the way the sheets go.
         *
         * It falls through when nothing is open and when there is no page that
         * way, so an arrow at the last page is not silently eaten. Modifiers are
         * refused rather than ignored: `Shift`+arrow is the shape a selection
         * nudge would take if this board ever grows one, and claiming it now
         * would be spending a binding on nothing.
         */
        if (this.gesturing || input.shift || input.ctrl || input.alt) return;
        ctx.turnPage(input.code === "ArrowLeft" ? -1 : 1);
        return;
      }

      case "Delete":
      case "Backspace": {
        if (this.gesturing) return;
        // The rule — three writes, and what `Shift` means to each of them — is
        // `state/erase.ts`, because `Ctrl+X` is the same delete behind a copy
        // (T-227) and two of them would drift.
        for (const id of eraseSelection(ctx, input.shift)) this.animating.delete(id);
        return;
      }

      case "Enter":
      case "NumpadEnter": {
        /**
         * > Open is either a different gesture, or a double-click that means
         * > open on the kinds that have something to open — which is a rule
         * > nobody can predict. A context menu row plus `Enter` on the
         * > selection is the honest version. — T-274, answered as Q-257
         *
         * `Enter` was spent twice before this and both were modal, which is
         * what leaves it free here: it ends a string run (`tools/string.ts`,
         * and that tool owns the input while the run is live), and it steps the
         * search — inside the field, which `machine.ts` never forwards from
         * because the target is a text field.
         *
         * **Exactly one, or nothing.** Not the first of several and not all of
         * them: D-46 has one thing playing at a time, and a key that opened an
         * arbitrary member of a selection of four would be a coin toss the
         * board could not explain. Modifiers are refused for the same reason —
         * `Shift`+`Enter` is search's *previous match* and must not quietly
         * mean something else out here.
         */
        if (this.gesturing || input.ctrl || input.alt || input.shift) return;
        if (ctx.selection.size !== 1) return;
        const [only] = ctx.selection.toArray();
        if (only !== undefined) ctx.open(only);
        return;
      }

      case "KeyA": {
        if (!input.ctrl || this.gesturing) return;
        // "Ctrl+A for everything visible" — on an unbounded board, everything
        // is not a useful selection. A free pin is visible, so it comes too
        // (T-106); before this it could only be reached one Alt+click at a
        // time, and orphans left by a deleted photograph quietly accumulated
        // until two of them landed on a note and made it rigid.
        const view = ctx.camera.visibleBounds();
        const seen: string[] = [];
        for (const id of ctx.scene.itemIds()) {
          if (ctx.scene.intersectsRect(id, view)) seen.push(id);
        }
        ctx.selection.replaceThread(seen, [], freePinsIn(ctx, view));
        return;
      }

      default: {
        /**
         * > | Slack presets | `1`-`9` with a string selected | Taut through to
         * > heavily draped | — DESIGN section 3.4
         *
         * Absolute and uniform, which is what a preset means: `1` is taut
         * whatever the run looked like a moment ago, and pressing it twice is
         * the same statement twice. It is the one slack verb that deliberately
         * flattens the unequal ratios a mid-string split leaves behind — the
         * wheel and `Alt`+wheel both scale, precisely so that they do not.
         *
         * The ladder itself is `lib/slack.ts`; it is geometric, and that file
         * says why a linear one would put seven of the nine presets in territory
         * nobody can tell apart.
         */
        const preset = presetFor(input.code);
        if (preset === null || input.ctrl || input.alt || this.gesturing) return;
        const strings = [...ctx.selection.strings];
        if (strings.length === 0) return;
        ctx.write.setStringSlack(strings, presetSlack(preset));
        return;
      }
    }
  }

  // --- the frame ------------------------------------------------------------

  tick(dt: number, ctx: ToolContext): void {
    // A roll of the wheel ends by stopping, which is not an event, so it is
    // measured. Until it expires the roll stays latched to the gap it began on —
    // see `SLACK_ROLL_IDLE_MS`, which is about the sag drooping out from under
    // the cursor and the camera taking over mid-roll.
    if (this.slackRoll !== null && dt > 0) {
      this.sinceRoll += dt;
      if (this.sinceRoll >= SLACK_ROLL_IDLE_MS) this.slackRoll = null;
    }

    if (
      dt > 0 &&
      (this.phase === "dragging" || this.phase === "rotating" || this.phase === "resizing")
    ) {
      this.sinceWrite += dt;
      if (this.sinceWrite >= LIVE_WRITE_MS) {
        this.sinceWrite = 0;
        this.commit(ctx, "live");
      }
    }

    if (this.animating.size === 0) return;

    // Screen pixels per millisecond. Screen rather than board, so a carried
    // item lags by the same amount whatever the zoom — the lag is about how
    // fast your hand is moving, not how much board it covered.
    const velocity = dt > 0 && this.phase === "dragging" ? (this.lastX - this.prevTickX) / dt : 0;
    this.prevTickX = this.lastX;

    const lagTarget = Math.max(
      -LAG_MAX_RAD,
      Math.min(LAG_MAX_RAD, velocity * LAG_PER_VELOCITY),
    );
    // Rotation is deliberate, so it gets the lift but not the lag; a turning
    // item that also leaned would read as two things happening at once.
    this.lag = approach(this.lag, this.phase === "dragging" ? lagTarget : 0, dt, LAG_TAU_MS);

    for (const id of this.animating) {
      const slot = ctx.scene.slotOf(id);
      if (slot === undefined) {
        this.animating.delete(id);
        continue;
      }

      // `starts` is populated by begin() and emptied by release(), so
      // membership is exactly "this gesture is holding it".
      const held = this.starts.has(id);
      const liftTarget = held ? 1 : 0;

      const lift = approach(
        ctx.scene.lift[slot]!,
        liftTarget,
        dt,
        liftTarget > ctx.scene.lift[slot]! ? LIFT_RISE_MS : LIFT_FALL_MS,
      );

      /**
       * Whose rotation is this?
       *
       * A single-pinned item hangs, and `sim/torsion.ts` owns its `swing`
       * outright — it does not settle to zero, it settles to wherever the item
       * hangs, and the carry lag is added on top of that over there. Everything
       * else — rigid on two pins, flat on none — still eases its lag back to
       * nothing here, exactly as it did before any of this existed.
       */
      const hangs = ctx.scene.pinCount(id) === 1;
      // Eased from the target rather than from `this.lag`, even though the two
      // are the same calculation: chaining them would put a second first-order
      // filter in the path and the carry would visibly lose its snap.
      const swingTarget = held && this.phase === "dragging" ? lagTarget : 0;
      const swing = hangs
        ? ctx.scene.swing[slot]!
        : approach(ctx.scene.swing[slot]!, swingTarget, dt, LAG_TAU_MS);

      const done =
        !held &&
        Math.abs(lift) < SETTLED_EPSILON &&
        (hangs || Math.abs(swing) < SETTLED_EPSILON);

      ctx.scene.lift[slot] = done ? 0 : lift;
      if (!hangs) ctx.scene.swing[slot] = done ? 0 : swing;
      ctx.dirty.item(id);
      if (done) this.animating.delete(id);
    }
  }

  /**
   * Abandon the gesture and put the board back — `Esc`, a lost pointer, a lost
   * window, a tool switch, teardown.
   *
   * Every phase has to be handled, not just the two that move things. A
   * marquee abandoned halfway has already rewritten the selection, and leaving
   * it rewritten means the next `Delete` removes items the user believed they
   * had just cancelled out of.
   */
  cancel(ctx: ToolContext): void {
    this.pull.cancel();
    this.scissors.cancel();
    /**
     * And the same for a loop pulled out of a string:
     *
     * > `Esc` mid-drag → the whole thing reverts, string unchanged.
     * > — DESIGN section 3.4, AC-71
     *
     * "Completely" is what makes this two lines rather than an inverse
     * operation: the pin and the node are made in one transaction at the
     * release and nowhere else, so before the release there is nothing in the
     * document to undo and the string is still the string it always was.
     */
    this.pendingString = null;
    this.resetLoop();
    // Nothing was written, so putting the pin back is the whole of the revert.
    if (this.phase === "pin") {
      this.pinDrag.cancel(ctx);
      this.holding.clear();
    }

    if (this.phase === "dragging" || this.phase === "rotating" || this.phase === "resizing") {
      // "Esc mid-drag → the whole thing reverts" (DESIGN section 3.4).
      const resizing = this.phase === "resizing";
      const poses = new Map<string, WritePose>();
      const sizes = new Map<string, WriteSize>();
      for (const [id, start] of this.starts) {
        ctx.scene.setPose(id, start);
        ctx.dirty.item(id);
        if (resizing) sizes.set(id, { x: start.x, y: start.y, w: start.w, h: start.h });
        else poses.set(id, { x: start.x, y: start.y, rot: start.rot });
      }
      // Putting the scene back is only half of it if a crash-safety write has
      // already landed: the document would still hold the intermediate pose
      // and the next observer event would drag the item straight back out.
      // Reverting a resize goes back through the resize op, because the pins it
      // moved on the way out have to come back with it.
      // The thread's free pins revert the same way, and for the same reason —
      // a resize never picks any up, because it only ever holds one item.
      const pins = new Map<string, Vec2>();
      if (!resizing) {
        for (const [id, start] of this.pinStarts) {
          this.movePin(ctx, id, start.x, start.y);
          pins.set(id, { x: start.x, y: start.y });
        }
      }
      if (this.wroteLive) {
        if (resizing) {
          if (sizes.size > 0) ctx.write.setSizes(sizes, "final");
        } else {
          if (poses.size > 0) ctx.write.setPoses(poses, "final");
          if (pins.size > 0) ctx.write.movePins(pins, "final");
        }
      }
      this.release();
    } else if (this.phase === "marquee") {
      ctx.selection.restore(
        this.marqueeBase,
        (id) => ctx.scene.has(id),
        (id) => ctx.scene.strings.has(id),
        (id) => ctx.scene.pins.has(id),
      );
    }

    // The carry goes with the gesture rather than easing down, because a
    // cancel means it never happened — and because after a tool switch or a
    // teardown there is no further `tick` to finish an ease, which would
    // strand items scaled up and lit as though still held.
    for (const id of this.animating) {
      const slot = ctx.scene.slotOf(id);
      if (slot !== undefined) {
        ctx.scene.lift[slot] = 0;
        // A hanging item's rotation is not this tool's to zero — zeroing it
        // would stand a photograph up at its authored angle for the frame
        // before phase 3 notices and hangs it again.
        if (ctx.scene.pinCount(id) !== 1) ctx.scene.swing[slot] = 0;
      }
      ctx.dirty.item(id);
    }
    this.animating.clear();
    this.lag = 0;

    this.pendingSelect = null;
    this.pendingDouble = false;
    this.pendingPin = null;
    this.pendingString = null;
    this.grabbed = null;
    this.rect = null;
    // Nothing to put back: a clipping is written at the release and an
    // abandoned one never touched the document or the selection.
    this.resetClip();
    this.phase = "idle";
    // A tool switch or a lost focus ends a roll of the wheel too. Nothing was
    // half-written — every notch is its own complete edit — so letting go of the
    // latch is the whole of it, and keeping it would mean the wheel still meant
    // slack after the board came back.
    this.slackRoll = null;
    this.sinceRoll = 0;
  }

  /** End of a gesture: the items stay in `animating` until their transients
   *  have eased back to nothing. */
  private release(): void {
    this.starts.clear();
    this.pinStarts.clear();
    this.holding.clear();
    this.lastAngle = null;
    this.rotateApplied = 0;
    this.sinceWrite = 0;
    this.wroteLive = false;
    this.grabbed = null;
    this.resizeId = null;
  }

  private commit(ctx: ToolContext, phase: "live" | "final"): void {
    if (this.phase === "resizing") {
      this.commitSize(ctx, phase);
      return;
    }
    const poses = new Map<string, WritePose>();
    const rotating = this.phase === "rotating";
    // Once a crash-safety pose is in the document, the release must write
    // every item it touched even if that item ended up back where it started —
    // otherwise the intermediate pose is the last word.
    const force = phase === "final" && this.wroteLive;
    for (const [id, start] of this.starts) {
      const pose = ctx.scene.poseOf(id);
      if (!pose) continue;
      if (!force && pose.x === start.x && pose.y === start.y && pose.rot === start.rot) continue;
      poses.set(id, rotating ? { x: pose.x, y: pose.y, rot: pose.rot } : { x: pose.x, y: pose.y });
    }
    // The thread's free pins, by the same rule: only the ones that actually
    // moved, unless a crash-safety write has already put an intermediate
    // position in the document and the release has to have the last word.
    const pins = new Map<string, Vec2>();
    for (const [id, start] of this.pinStarts) {
      const pin = ctx.scene.pins.get(id);
      if (!pin) continue;
      if (!force && pin.lx === start.x && pin.ly === start.y) continue;
      pins.set(id, { x: pin.lx, y: pin.ly });
    }

    if (poses.size === 0 && pins.size === 0) return;
    if (phase === "live") this.wroteLive = true;
    if (poses.size > 0) ctx.write.setPoses(poses, phase);
    if (pins.size > 0) ctx.write.movePins(pins, phase);
  }

  /** The same two writes, for the gesture that changes the paper's size as well
   *  as where its centre is. */
  private commitSize(ctx: ToolContext, phase: "live" | "final"): void {
    const id = this.resizeId;
    const start = id === null ? undefined : this.starts.get(id);
    if (id === null || !start) return;
    const pose = ctx.scene.poseOf(id);
    if (!pose) return;

    const force = phase === "final" && this.wroteLive;
    const unchanged =
      pose.x === start.x && pose.y === start.y && pose.w === start.w && pose.h === start.h;
    if (!force && unchanged) return;

    if (phase === "live") this.wroteLive = true;
    ctx.write.setSizes(
      new Map([[id, { x: pose.x, y: pose.y, w: pose.w, h: pose.h }]]),
      phase,
    );
  }
}
