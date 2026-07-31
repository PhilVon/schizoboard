/**
 * What this client is doing, for everyone else's benefit.
 *
 * > One state object per client, flushed at most every other frame. Never
 * > persisted; dropped on disconnect, which is correct.
 * > — docs/DATA-MODEL.md section 9
 *
 * Awareness is a last-write-wins channel with no history, so this is not a
 * stream of events — it is one small object, replaced whole, as often as is
 * useful and no oftener. Two rules follow, and both are load-bearing:
 *
 *   - **Every other frame, at most.** A cursor at 60 Hz is 60 messages a second
 *     per peer, fanned out to every other peer, for a position nobody can see
 *     move that precisely. Half that is already generous.
 *   - **Only when something changed.** The cadence caps the rate; this is what
 *     makes an idle board silent. Yjs's `Awareness` bumps its own clock every
 *     fifteen seconds regardless, so silence here never reads as absence.
 *
 * ## What is deliberately not here
 *
 * > Anything durable. Awareness is dropped on disconnect by design, so anything
 * > that must survive a reconnect belongs in the document. — section 9.4
 *
 * That is AC-83, and the way it is kept is `publish` below: the payload is an
 * object literal with a fixed set of fields, built from values this module has
 * narrowed itself. Nothing is spread, copied wholesale or passed through, so
 * there is no route by which a scene object — or a `Y.Map`, or a whole
 * selection with its methods — can arrive on the wire because somebody handed
 * one to a setter.
 *
 * `impulse` from section 9 is absent because the work that produces it has not
 * happened. It adds its own field and its own test — `locks` did in T-130, and
 * `wet` in T-168.
 *
 * `cam` was here and is gone (T-226, Q-171). It was published every other frame
 * and read by nobody: the one sentence justifying its place on the wire was that
 * a seeding peer could push assets a collaborator is about to look at, and no
 * such path exists — `crdt/sync/exchange.ts` is pull-only by construction and
 * drops unsolicited `DATA` outright, so the offer would have to be built before
 * the field could be consumed. Three numbers every other frame were never the
 * cost; a stated justification that is not true was. Putting it back is this
 * comment in reverse, and belongs to whichever task builds the offer path.
 */

import type { WetStroke } from "@/lib/ink";
import type { Camera } from "@/state/camera";
import type { Selection } from "@/state/selection";
import { WetWire, type PresenceWetRun } from "@/state/wetwire";

/** Who this is. The only field a peer shows a human directly. */
export interface PresenceUser {
  id: string;
  name: string;
  /** CSS colour. One per peer, so cursors and chrome can be told apart. */
  color: string;
}

export interface PresenceCursor {
  /** Board coordinates, not screen: the other peer's viewport is not ours. */
  x: number;
  y: number;
  tool: string;
}

/**
 * By kind, where section 9 writes a flat `[itemId, …]`.
 *
 * The document predates pins and strings being selectable at all (T-119,
 * T-121), and a peer drawing what somebody else has selected needs to know
 * which chrome to draw. Plain string arrays, matching `Selection.snapshot`.
 */
export interface PresenceSelection {
  readonly items: readonly string[];
  readonly strings: readonly string[];
  readonly pins: readonly string[];
}

/**
 * One item's pose inside a grab. Position and angle only — `w`/`h` are a resize,
 * which is a document write and not a motion anybody has to smooth.
 */
export interface PresenceGrabPose {
  x: number;
  y: number;
  /** Radians, and unbounded, exactly as the scene stores it. */
  rot: number;
}

/**
 * What this client has hold of *right now*, so that a peer can move it before
 * the document has said anything.
 *
 * > `grab: null | { kind, ids, pose, seq, t, phase }` — docs/DATA-MODEL.md
 * > section 9
 *
 * ## Absolute poses, not a delta
 *
 * `poses` is one per entry in `ids`, and each is the item's
 * whole position rather than an offset from where the gesture started. A delta
 * would be one triple regardless of how many items are held, which is tempting
 * for a fifty-item marquee — and wrong here, because awareness is
 * last-write-wins with no history (section 9). A delta needs a baseline, the
 * baseline can only be established by the frame that opens the gesture, and
 * that is precisely the frame a dropped update loses forever. Every absolute
 * sample stands on its own: a receiver that joins mid-drag, or misses six in a
 * row, is still exactly right on the seventh.
 */
export interface PresenceGrab {
  /** What sort of thing is held. Items today; a dragged pin is its own kind. */
  kind: "items";
  ids: readonly string[];
  /** Parallel to `ids`, and the same length. A receiver must check that. */
  poses: readonly PresenceGrabPose[];
  /**
   * Rises by one on every published grab, for the life of this client.
   *
   * A receiver's duplicate and out-of-order filter. `t` cannot do that job: two
   * publishes a frame apart can carry the same millisecond.
   */
  seq: number;
  /**
   * The sender's clock when the poses were read.
   *
   * Its epoch is this client's `performance.now()`, which means nothing on
   * another machine — only the *intervals* between two of these do, and that is
   * all a receiver uses them for (`state/remote.ts`).
   */
  t: number;
  /**
   * `final` is the release: the last pose of the gesture, and the document write
   * that agrees with it is already on its way.
   *
   * The same two words `BoardWriter.setPoses` uses, for the same distinction —
   * one drag produces a run of `live` and exactly one `final`. A receiver needs
   * the `final` to know when to stop extrapolating and start waiting for the
   * document (section 9.2), which a grab that simply vanished would not tell it.
   */
  phase: "live" | "final";
}

/**
 * One segment of one string, claimed by whoever is in the middle of splitting
 * it — DATA-MODEL section 5.4's third bullet.
 *
 * > Take an advisory lock on the segment over awareness, purely as a UX hint —
 * > never as a correctness mechanism.
 *
 * The two halves of that sentence are both load-bearing, and the second is the
 * one worth being careful about: nothing may read this to decide whether a
 * write is allowed. 5.4 accepts what happens when two people split the same
 * segment — they compute from the same prior state, the total rest length
 * changes once, and the result is valid and sags slightly differently than
 * either expected. A lock that could refuse the second write would be a
 * correctness mechanism, which the same sentence rules out.
 *
 * ## Named by its two pins
 *
 * Not by the node it starts at, which is how `crdt/ops/strings.ts` addresses a
 * gap. A receiver has to *draw* this, and the only route from a node id to the
 * particles on screen is to pair `RopeSet.visit`'s arrival order against the
 * run's node array — two orders that ropes.ts's own comment says disagree the
 * moment a segment has no particles to draw. The simulation indexes a segment
 * by the pins at its ends, so those are what travel.
 */
export interface PresenceLock {
  /** The string the segment belongs to. */
  string: string;
  /** The pin the segment runs from, and the one it runs to. */
  a: string;
  b: string;
}

export interface PresenceState {
  user: PresenceUser;
  cursor: PresenceCursor | null;
  selection: PresenceSelection;
  grab: PresenceGrab | null;
  /**
   * > `locks: { segments: [...] }` — docs/DATA-MODEL.md section 9
   *
   * An object with one array in it rather than a bare array, because that is
   * what section 9 writes and because a segment is not the only thing anybody
   * might come to claim — a `compact layers` operation wants one too (section
   * 7), and that belongs beside this rather than in a second field.
   */
  locks: { segments: readonly PresenceLock[] };
  /**
   * The stroke under this client's pen right now, windowed — DATA-MODEL section
   * 9.1, and `state/wetwire.ts` for how.
   *
   * A list rather than one run, because one gesture is several marks once it
   * crosses an edge (T-137, Q-81), and empty rather than null when there is
   * nothing in hand, for the same reason `locks.segments` is: an absent array
   * and an empty one are the same statement, and a reader that has to handle
   * both is a reader with a branch that can be got wrong. Section 9 described
   * this as `null | {…}` until a re-survey caught up with it.
   */
  wet: readonly PresenceWetRun[];
}

/** The narrow slice of `Awareness` this needs. Keeps the tests free of Yjs. */
export interface PresenceChannel {
  setLocalState(state: Record<string, unknown> | null): void;
}

/**
 * Where a held item's pose is read from — `state/scene.ts`, in practice.
 *
 * Narrow and injected for the reason `PresenceChannel` is: so that the rule
 * about what may reach the wire stays a property of this file, and so the tests
 * need neither a Scene nor Yjs.
 */
export interface PresencePoses {
  poseOf(id: string): { x: number; y: number; rot: number } | null;
}

export interface PresenceOptions {
  /**
   * Publish on every nth frame. Two is section 9's "at most every other frame";
   * a slower peer or a busier board can be given a larger number without
   * anything else changing.
   */
  everyNthFrame?: number;
  /**
   * The clock stamped onto a grab. Injected so the tests can hand out the times
   * they want to reason about rather than the ones a real clock happens to give.
   */
  now?: () => number;
}

/**
 * Board units. A cursor is drawn a few pixels across and an item is three
 * hundred units wide, so a fractional unit is beneath anybody's notice — and
 * rounding is what stops `-1234.5678901234` going out sixty times a second.
 * It doubles as noise suppression: sub-unit drift is not a change.
 */
function round(value: number): number {
  return Math.round(value);
}

/**
 * Radians. A ten-thousandth is a third of an arcminute, which across a
 * three-hundred-unit photograph is a twentieth of a board unit at the corner —
 * beneath the position rounding above, so it cannot be the coarser of the two.
 */
function roundAngle(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Whether a grab is different from the one already on the wire.
 *
 * Both sides are already rounded, so this is exact equality on integers and
 * ten-thousandths — and rounding is what makes it useful: an item held
 * perfectly still by a hand that is not quite still produces no messages.
 */
function grabMoved(
  now: { ids: readonly string[]; poses: readonly PresenceGrabPose[] },
  sent: { ids: readonly string[]; poses: readonly PresenceGrabPose[] },
): boolean {
  if (now.ids.length !== sent.ids.length) return true;
  for (let i = 0; i < now.ids.length; i += 1) {
    if (now.ids[i] !== sent.ids[i]) return true;
    const a = now.poses[i]!;
    const b = sent.poses[i]!;
    if (a.x !== b.x || a.y !== b.y || a.rot !== b.rot) return true;
  }
  return false;
}

/** Whether the claim is the one already on the wire. Three string comparisons,
 *  on the frames a segment is being held — which is a gesture, not a session. */
function sameLock(now: PresenceLock | null, sent: PresenceLock | null): boolean {
  if (now === null || sent === null) return now === sent;
  return now.string === sent.string && now.a === sent.a && now.b === sent.b;
}

export class Presence {
  private readonly channel: PresenceChannel;
  private readonly camera: Camera;
  private readonly selection: Selection;
  private readonly poses: PresencePoses;
  private readonly user: PresenceUser;
  private readonly everyNthFrame: number;

  /** Last published, so an unchanged frame costs a comparison and no message. */
  private cursor: PresenceCursor | null = null;
  private selected: PresenceSelection = { items: [], strings: [], pins: [] };
  /**
   * The version the selection was on when it was last published.
   *
   * `Selection` keeps a counter that every mutator bumps, for exactly this — so
   * the comparison is one integer rather than a walk over three sets inside the
   * frame loop. `-1` because a fresh selection is already on 1.
   */
  private selectionVersion = -1;
  private published = false;

  /** Set by input, consumed at the next flush. */
  private pointer: PresenceCursor | null = null;
  private stopped = false;

  /**
   * The segment this client has hold of, or null.
   *
   * One, not a list, because one pointer splits one segment. The wire carries an
   * array because section 9 says `segments`, and because a claim is a property
   * of the *client* rather than of the gesture — the day a second kind of claim
   * exists it goes in the same array rather than in a second field.
   */
  private lock: PresenceLock | null = null;
  /** What the last published state said about locks, so an unchanged frame
   *  costs a comparison rather than a message. */
  private sentLock: PresenceLock | null = null;
  /** The same array for every client claiming nothing, which is nearly all of
   *  them nearly all of the time. */
  private static readonly NO_LOCKS: readonly PresenceLock[] = Object.freeze([]);

  /**
   * The sliding window over whatever the pen is drawing — the one field with an
   * algorithm rather than a rounding rule behind it, so it has a file.
   *
   * Fed every frame by [`drawing`] and read on the frames that publish, which
   * is why it cannot be a comparison in [`changed`] like the others: the
   * decimation wants every sample the hand made, and half of those arrive on
   * the frames nothing is sent.
   */
  private readonly wet = new WetWire();

  private readonly now: () => number;
  /**
   * The grab as it stands, rebuilt by `grabbing` and published from here.
   *
   * `seq` and `t` are not on it: those are stamped at the flush that sends it,
   * so a grab that is staged twice between two publishing frames goes out once,
   * with one sequence number.
   */
  private grab: { kind: "items"; ids: string[]; poses: PresenceGrabPose[] } | null = null;
  /**
   * A release must go out even though it says nothing new about position, so it
   * cannot be discovered by comparing poses. This is the one-shot that carries
   * it: set by `released`, consumed by the next flush.
   */
  private releasing = false;
  private grabSeq = 0;
  /** What the last published grab said, for the same reason `cam` is kept. */
  private sent: { ids: string[]; poses: PresenceGrabPose[] } | null = null;
  /** The grab as it will go out, stamped at the flush that sends it. */
  private grabWire: PresenceGrab | null = null;

  constructor(
    channel: PresenceChannel,
    camera: Camera,
    selection: Selection,
    poses: PresencePoses,
    user: PresenceUser,
    options: PresenceOptions = {},
  ) {
    this.channel = channel;
    this.camera = camera;
    this.selection = selection;
    this.poses = poses;
    this.user = user;
    this.everyNthFrame = Math.max(1, Math.floor(options.everyNthFrame ?? 2));
    this.now = options.now ?? (() => performance.now());
  }

  /**
   * The pointer moved, in **board** coordinates.
   *
   * Board rather than screen because the other peer's viewport is not ours, and
   * a cursor drawn at our screen position would be somewhere else entirely on
   * their board. A non-finite coordinate is dropped rather than published:
   * `NaN` survives `JSON.stringify` as `null` and would arrive as a cursor at
   * the origin.
   */
  pointerAt(x: number, y: number, tool: string): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.pointer = { x: round(x), y: round(y), tool };
  }

  /** The pointer left the board. Peers should stop drawing it at once. */
  pointerGone(): void {
    this.pointer = null;
  }

  /**
   * These items are being dragged, and here is where they are this frame.
   *
   * Called every frame a gesture is holding something; what actually goes out is
   * the flush cadence's business, and an item that has not moved a whole board
   * unit since the last publish is not a change (`changed` below). Ids the pose
   * source does not know are dropped rather than published as an item at the
   * origin — a receiver cannot tell the difference.
   */
  grabbing(ids: Iterable<string>): void {
    const kept: string[] = [];
    const poses: PresenceGrabPose[] = [];
    for (const id of ids) {
      const pose = this.poses.poseOf(id);
      if (pose === null) continue;
      if (!Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !Number.isFinite(pose.rot)) {
        continue;
      }
      kept.push(id);
      poses.push({ x: round(pose.x), y: round(pose.y), rot: roundAngle(pose.rot) });
    }
    this.grab = kept.length === 0 ? null : { kind: "items", ids: kept, poses };
  }

  /**
   * The gesture let go.
   *
   * Publishes one last grab, marked `final`, carrying the poses the document
   * write made at the same moment will settle on. A receiver holds that pose
   * until the document agrees or a grace period expires (DATA-MODEL section
   * 9.2), and it is this message — not the grab merely disappearing — that tells
   * it to start counting. So it is sent even when nothing moved on the last
   * frame, which is why `releasing` exists rather than being inferred.
   *
   * The poses are re-read here rather than taken from the last staged grab: the
   * release lands in phase 1 and the flush in phase 9, and between them sit the
   * phases that put a released item where it hangs.
   */
  released(): void {
    if (this.grab === null && this.sent === null) return;
    const ids = this.grab?.ids ?? this.sent?.ids ?? [];
    this.grabbing(ids);
    // `grabbing` clears the grab when it can no longer find any of the items —
    // deleted mid-gesture, or the release itself removed them. There is still a
    // release to announce, and an empty `ids` says exactly that.
    this.grab ??= { kind: "items", ids: [], poses: [] };
    this.releasing = true;
  }

  /**
   * This client is in the middle of splitting a segment, or has stopped being.
   *
   * Called every frame the gesture is running, like [`grabbing`], and with null
   * on the frame it ends. A hint and nothing else: it is published, drawn by
   * whoever sees it, and read by nothing that decides whether a write may
   * happen — see [`PresenceLock`].
   *
   * A segment naming a pin that is not a string, or an empty id, is dropped
   * rather than published. A receiver cannot draw a claim it cannot find, and a
   * malformed one would sit on their board until this client disconnected.
   */
  splitting(segment: PresenceLock | null): void {
    if (segment === null) {
      this.lock = null;
      return;
    }
    if (segment.string === "" || segment.a === "" || segment.b === "") {
      this.lock = null;
      return;
    }
    this.lock = { string: segment.string, a: segment.a, b: segment.b };
  }

  /**
   * The runs the pen has on the overlay this frame, or nothing.
   *
   * Called on **every** frame rather than every publishing one, and that is the
   * difference between this and [`grabbing`]: a grab is a position and the
   * newest one is the whole truth about it, while a stroke is a *path* and the
   * samples that arrive between two publishes are what decide where the
   * decimation puts its points (DATA-MODEL section 9.1). Sampling this at the
   * publish cadence would halve the resolution of every remote preview and make
   * it depend on `everyNthFrame`, which is a transport setting.
   *
   * The pen's runs, never the eraser's smudge — that one is already on the ink
   * canvas, and a peer drawing it here would paint an opaque mark over the hole
   * it had just made. `app/main.ts` makes the same distinction for the local
   * overlay, from the same accessor.
   */
  drawing(runs: readonly WetStroke[]): void {
    this.wet.update(runs, this.camera.zoom);
  }

  /**
   * Publish, if this is a publishing frame and anything is different.
   *
   * Takes the frame index rather than the frame, so that nothing in `state/`
   * has to know what a frame is.
   */
  flush(frameIndex: number): void {
    if (this.stopped) return;
    if (frameIndex % this.everyNthFrame !== 0) return;

    const cursor = this.pointer;
    if (this.published && !this.changed(cursor)) return;

    this.cursor = cursor;
    this.selected = this.selection.snapshot();
    this.selectionVersion = this.selection.version;

    const final = this.releasing;
    this.releasing = false;
    // Field by field, from values `grabbing` narrowed and rounded. `ids` and
    // `poses` are handed over rather than copied because `grabbing` builds fresh
    // arrays every time and nothing else holds these two.
    this.grabWire =
      this.grab === null
        ? null
        : {
            kind: "items",
            ids: this.grab.ids,
            poses: this.grab.poses,
            seq: (this.grabSeq += 1),
            t: this.now(),
            phase: final ? "final" : "live",
          };
    this.sent = this.grab === null ? null : { ids: this.grab.ids, poses: this.grab.poses };
    this.sentLock = this.lock;
    // A `final` is the last word about this gesture, so the grab goes away with
    // it. Awareness keeps whatever it was last told until it is told otherwise,
    // and a `final` left sitting there is a trap for the next peer to connect:
    // it would arrive, read a grab, and hold a pose for a gesture that ended
    // minutes ago. The next flush publishes `grab: null` and clears it.
    if (final) this.grab = null;

    this.published = true;
    this.publish();
  }

  /**
   * Take this client off every other board.
   *
   * Presence is dropped on disconnect anyway, but a peer that is still
   * connected and has merely stopped — a board closing, a session ending —
   * would otherwise leave a cursor sitting there until the awareness timeout.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.channel.setLocalState(null);
  }

  /**
   * **The only place a field reaches the wire.**
   *
   * An object literal, field by field, from values narrowed above. Not a spread
   * and not a copy of anything the rest of the application owns — which is what
   * makes "nothing durable ever goes on awareness" (section 9.4) a property of
   * this function rather than a rule somebody has to remember.
   */
  private publish(): void {
    const state: PresenceState = {
      user: { id: this.user.id, name: this.user.name, color: this.user.color },
      cursor:
        this.cursor === null
          ? null
          : { x: this.cursor.x, y: this.cursor.y, tool: this.cursor.tool },
      // Named field by field like the rest, but not copied again: `snapshot`
      // already hands over three fresh arrays that nothing else holds.
      selection: {
        items: this.selected.items,
        strings: this.selected.strings,
        pins: this.selected.pins,
      },
      // Built in `flush`, from values `grabbing` narrowed. Same argument as
      // `selection` above: naming the fields again here would copy an object
      // this module has just made and nobody else can reach.
      grab: this.grabWire,
      // Field by field like everything else, and a fresh single-entry array
      // rather than one held anywhere: the claim is three strings and the point
      // of naming them here is that nothing else can arrive by this route.
      locks: {
        segments:
          this.lock === null
            ? Presence.NO_LOCKS
            : [{ string: this.lock.string, a: this.lock.a, b: this.lock.b }],
      },
      // The one field not named again here, because there is nothing to name it
      // *from*: `WetWire` cuts fresh arrays of numbers it quantised itself out
      // of primitives, holds nothing anybody else can reach, and this is the
      // call that takes them. Naming a run's six fields a second time would
      // copy an object made a microsecond ago for this and nothing else — the
      // same bargain `selection` and `grab` above already make.
      wet: this.wet.payload(),
    };
    this.channel.setLocalState(state as unknown as Record<string, unknown>);
  }

  /**
   * Called only when something has already been published, which is what the
   * first line used to be: `cam` was set on every flush, so `cam === null` was
   * how a first publish announced itself. `published` in [`flush`] says the same
   * thing and says it about the message rather than about one field of it.
   *
   * **Panning and zooming are no longer changes.** With `cam` off the wire
   * (T-226) there is nothing in this payload a camera move alters: `cursor` is
   * in board coordinates, so a pan under a still hand moves the screen and not
   * the position anybody draws. An idle peer scrolling around a board now says
   * nothing at all, which is the whole of what removing the field bought.
   */
  private changed(cursor: PresenceCursor | null): boolean {
    // A release says nothing new about position and still has to go out.
    if (this.releasing) return true;
    if ((this.grab === null) !== (this.sent === null)) return true;
    if (this.grab !== null && this.sent !== null && grabMoved(this.grab, this.sent)) return true;
    // Taking a segment and letting go of one are both changes, and neither
    // moves the cursor by a whole board unit on the frame it happens.
    if (!sameLock(this.lock, this.sentLock)) return true;
    // A line that has grown, or whose tip has moved, and neither shows up in
    // anything above: the pen captures the pointer, so a stroke is drawn by a
    // cursor that has already been published at that position.
    if (this.wet.changed) return true;

    if ((cursor === null) !== (this.cursor === null)) return true;
    if (cursor !== null && this.cursor !== null) {
      if (cursor.x !== this.cursor.x || cursor.y !== this.cursor.y) return true;
      if (cursor.tool !== this.cursor.tool) return true;
    }

    return this.selection.version !== this.selectionVersion;
  }
}
