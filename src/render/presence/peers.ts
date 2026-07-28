/**
 * Everybody else, as far as this board is concerned.
 *
 * > Cursors, selections, live drag poses, in-progress strokes and camera
 * > positions travel over an ephemeral awareness channel, not the document.
 * > — docs/DESIGN.md section 7
 *
 * `state/presence.ts` is the publishing half of that sentence and this is the
 * receiving half, for the fields nobody had a use for until something drew them:
 * who a peer is, where their pointer is, and what they have hold of. The `grab`
 * field is deliberately not here — it moves *items*, which is a write into the
 * scene, and `state/remote.ts` already owns it. What is left is the part that is
 * only ever a picture, which is why this lives under `render/`.
 *
 * ## Everything here arrived from another machine
 *
 * So it is validated, exactly as `readGrab` validates the pose stream, and for a
 * sharper reason: a colour off the wire is assigned to `ctx.fillStyle`, and a
 * string the canvas cannot parse is *ignored* rather than rejected — the context
 * quietly keeps whatever colour it had, so one malformed peer would paint itself
 * in the previous peer's identity. A peer that will not say what colour it is
 * gets [`UNKNOWN_COLOR`] instead of being dropped: they are still a real person
 * on the board, and drawing nothing is the one answer that is certainly wrong.
 *
 * ## What is deliberately not read
 *
 * `cam` and `cursor.tool` are both published and neither is drawn. `cam` is for
 * the asset seeder (DATA-MODEL section 9) and belongs to whichever task builds
 * one; a tool badge on a remote cursor is a design decision nobody has made. A
 * reader that parsed them anyway would be claiming they are used.
 *
 * ## The cursor is smoothed, and the item poses are not smoothed *here*
 *
 * A peer publishes at most every other frame (DATA-MODEL section 9), so a raw
 * remote cursor moves in two-frame steps — at 60 Hz that is a visible stutter on
 * the one thing whose whole job is to look like a hand. `state/remote.ts` solves
 * the same problem for poses with a 100 ms buffer and true interpolation,
 * because a pose drives a rope anchor and an anchor that guesses cracks the
 * string hanging off it. A cursor drives nothing. So it gets the cheaper half of
 * the same toolkit — the critically-damped spring DESIGN section 11.1 names as
 * the guaranteed fallback — which needs no clocks, no sample buffer and no
 * skew estimate, and is jitter-proof by construction: it cannot move faster than
 * its own rate, so it cannot reproduce the step it is being fed.
 */

import { PeerInk, readWet, type PeerWetRun } from "@/render/presence/wetpeer";
import { criticallyDamped } from "@/state/remote";

/**
 * The colour a peer gets when it did not send a usable one.
 *
 * A warm mid-grey: visible on cork and on paper, and not one of the six in
 * `lib/palette.ts`, so an unidentified peer never wears somebody's identity.
 */
export const UNKNOWN_COLOR = "#8a8378";

/** What a peer is called when it did not say. */
const UNKNOWN_NAME = "peer";

/**
 * Longest name drawn.
 *
 * The label is measured and painted every frame a cursor moves, and a name is
 * an arbitrary string from another machine. Twenty-four characters is more than
 * any real one and short enough that the pill cannot span the viewport.
 */
const MAX_NAME = 24;

/** `#rrggbb`, which is what `identityFor` emits and all the canvas needs. */
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * How fast the drawn cursor closes on the published one, per second.
 *
 * Faster than `state/remote.ts`'s pose spring, and on purpose. That one is a
 * fallback for a connection that has stopped delivering and can afford to lag;
 * this one is on every peer all of the time, and a pointer that trails the hand
 * is the single most legible kind of wrong on a shared board. Twenty-six is a
 * 38 ms time constant — just inside the 33 ms between two published samples, so
 * it swallows the step without inventing a delay of its own.
 */
const CURSOR_RATE = 26;

/**
 * Board units. Below this the spring has arrived and is snapped to the target.
 *
 * A spring is asymptotic and never *equals* anything, so without this the
 * version below ticks forever and an idle board with one idle peer restrokes a
 * full-viewport canvas sixty times a second to move a cursor by a millionth of
 * a unit. A thirty-second of a board unit is a quarter of a screen pixel at
 * 800% zoom.
 */
const SETTLED = 1 / 32;

/** Where a peer's pointer is, in board coordinates. */
export interface PeerPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A segment somebody else is in the middle of splitting — DATA-MODEL section
 * 5.4, and `state/presence.ts`'s `PresenceLock` for why it is named by its two
 * pins rather than by the node it starts at.
 *
 * A hint, and nothing on this side may treat it as more than one: it is drawn,
 * and it is read by nothing that decides whether this client's own split may go
 * ahead. Two people splitting the same segment is a case 5.4 accepts.
 */
export interface PeerLock {
  readonly string: string;
  readonly a: string;
  readonly b: string;
}

/**
 * One peer, ready to draw.
 *
 * The three selection arrays are by kind, matching `PresenceSelection` — a peer
 * can select pins and strings as well as items (T-119, T-121), and each gets
 * different chrome.
 */
export interface DrawnPeer {
  readonly id: string;
  readonly name: string;
  /** A CSS colour the canvas will certainly accept — see the header. */
  readonly color: string;
  /** Smoothed, and null when their pointer is off their board. */
  readonly cursor: PeerPoint | null;
  readonly items: readonly string[];
  readonly strings: readonly string[];
  readonly pins: readonly string[];
  /** The segments they have hold of. Empty for everyone who is not, which is
   *  everyone, nearly always. */
  readonly locks: readonly PeerLock[];
  /**
   * The stroke under their pen, spliced together out of the windows seen so far
   * — DATA-MODEL section 9.1, and `render/presence/wetpeer.ts` for how.
   *
   * An object rather than an array, and the one field here that is *not* what
   * the last message said: a sliding window only makes sense against what came
   * before, so this accumulates across messages while everything above it is
   * replaced by each one. That is also why it is absent from [`ReadPeer`].
   */
  readonly ink: PeerInk;
}

/**
 * What one awareness message said, before any of it is merged with what came
 * before.
 *
 * Distinct from [`DrawnPeer`] because two of the fields are not the same kind
 * of thing. A name, a colour and a selection are *stated* by each message and
 * the newest statement is the whole truth. A cursor is smoothed towards what
 * was stated, and wet ink is spliced into what was already held — neither can
 * be read out of one message, so neither is here.
 */
export interface ReadPeer {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly cursor: PeerPoint | null;
  readonly items: readonly string[];
  readonly strings: readonly string[];
  readonly pins: readonly string[];
  readonly locks: readonly PeerLock[];
  /** The windows this message carried, validated. Spliced by [`Peers.observe`]
   *  into the accumulator on [`DrawnPeer.ink`]. */
  readonly wet: readonly PeerWetRun[];
}

/**
 * The half of [`Peers`] the overlay needs.
 *
 * Structural, like `RopeGeometry` next door, so `render/overlay.ts` depends on
 * the shape it walks rather than on the store that fills it — and so its tests
 * can hand it two frozen objects instead of an awareness channel.
 */
export interface PeerSource {
  /** Bumped whenever the picture these peers make would be different. */
  readonly version: number;
  /** Whether any peer has anything selected, so the chrome pass can be skipped. */
  readonly chromed: boolean;
  /** Whether any peer has a stroke in the air, so the ink pass can be skipped —
   *  which on a board where nobody is drawing is every frame. */
  readonly inked: boolean;
  peers(): Iterable<DrawnPeer>;
}

/** What one peer's last state said, before any smoothing. */
interface Live {
  id: string;
  name: string;
  color: string;
  /** Where the peer says the pointer is. Null when it is off their board. */
  target: PeerPoint | null;
  /**
   * Where it is drawn — the spring's output, and the field [`DrawnPeer`] means.
   * Null until the first target, and cleared with it.
   */
  cursor: { x: number; y: number } | null;
  vx: number;
  vy: number;
  items: readonly string[];
  strings: readonly string[];
  pins: readonly string[];
  /** The segments they have hold of — DATA-MODEL section 5.4. */
  locks: readonly PeerLock[];
  /** Their wet ink, accumulated across messages rather than replaced by them. */
  ink: PeerInk;
}

function text(value: unknown, fallback: string, cap: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > cap ? trimmed.slice(0, cap) : trimmed;
}

/** Ids only, and only the ones that are strings. A malformed entry is dropped
 *  rather than taking the whole list with it: a peer whose selection is half
 *  readable has still selected those things. */
function ids(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return EMPTY;
  const out: string[] = [];
  for (const entry of value) if (typeof entry === "string" && entry.length > 0) out.push(entry);
  return out.length === 0 ? EMPTY : out;
}

/** The same array for every empty list, since most peers select nothing. */
const EMPTY: readonly string[] = Object.freeze([]);

/** Likewise, and more so: claiming a segment is a gesture, so this is the
 *  answer for every peer on almost every frame. */
const NO_LOCKS: readonly PeerLock[] = Object.freeze([]);

/**
 * The claimed segments, validated down to three ids each.
 *
 * A malformed entry is dropped and the rest kept, like `ids` above: a peer whose
 * claim is half readable has still taken hold of the others, and there is no
 * version of this worth refusing a whole peer over — it is a hint.
 */
function locks(value: unknown): readonly PeerLock[] {
  const list = (value as { segments?: unknown } | null | undefined)?.segments;
  if (!Array.isArray(list)) return NO_LOCKS;
  const out: PeerLock[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const { string, a, b } = entry as Record<string, unknown>;
    if (typeof string !== "string" || string.length === 0) continue;
    if (typeof a !== "string" || a.length === 0) continue;
    if (typeof b !== "string" || b.length === 0) continue;
    out.push({ string, a, b });
  }
  return out.length === 0 ? NO_LOCKS : out;
}

function point(value: unknown): PeerPoint | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y } = value as Record<string, unknown>;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * A remote awareness state, validated down to what is drawn.
 *
 * Null only when there is no `user` to attribute anything to — everything else
 * degrades to a default, because a peer missing a field is still a peer and the
 * alternative is a collaborator who intermittently does not exist.
 *
 * Exported because it is the boundary, and a boundary is worth testing without
 * a store, a channel or a canvas around it.
 */
export function readPeer(state: unknown): ReadPeer | null {
  if (typeof state !== "object" || state === null) return null;
  const user = (state as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return null;
  const { id, name, color } = user as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0) return null;

  const selection = (state as { selection?: unknown }).selection;
  const bag = (typeof selection === "object" && selection !== null
    ? selection
    : {}) as Record<string, unknown>;

  return {
    id,
    name: text(name, UNKNOWN_NAME, MAX_NAME),
    color: typeof color === "string" && HEX.test(color) ? color : UNKNOWN_COLOR,
    cursor: point((state as { cursor?: unknown }).cursor),
    items: ids(bag.items),
    strings: ids(bag.strings),
    pins: ids(bag.pins),
    locks: locks((state as { locks?: unknown }).locks),
    wet: readWet((state as { wet?: unknown }).wet),
  };
}

/** Claims are three ids each and there is never more than a handful, so this is
 *  a walk rather than a version counter. */
function sameLocks(a: readonly PeerLock[], b: readonly PeerLock[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const one = a[i]!;
    const other = b[i]!;
    if (one.string !== other.string || one.a !== other.a || one.b !== other.b) return false;
  }
  return true;
}

function same(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Every peer on this board, keyed by Yjs client id — which is what awareness
 * keys states by, and the only identifier that is agreed without asking anybody.
 *
 * Nothing here imports Yjs: `observe` takes a plain state object, for the reason
 * `state/remote.ts` does. The two are fed from the same subscription in
 * `app/main.ts` and split the payload between them.
 */
export class Peers implements PeerSource {
  private readonly live = new Map<number, Live>();
  private self: number | null = null;
  private ver = 0;

  /**
   * Bumped whenever the drawn picture would differ, and *only* then.
   *
   * The overlay redraws on a change of this number, so a peer sitting still —
   * the common case on a board where one person is working — costs a comparison
   * and no canvas work at all. Which is why setting a cursor target does not
   * bump it: the target is not what is drawn, and [`step`] bumps when the drawn
   * position actually moves.
   */
  get version(): number {
    return this.ver;
  }

  /** Whether the chrome pass has anything to do. Walks a map of a handful. */
  get chromed(): boolean {
    for (const peer of this.live.values()) {
      if (peer.items.length > 0 || peer.strings.length > 0 || peer.pins.length > 0) return true;
      // A claimed segment is chrome like the rest of it, and it hangs off a
      // rope that sags and settles — so a board where the only peer activity is
      // somebody holding a gap still has a canvas that goes stale every frame
      // the rope moves.
      if (peer.locks.length > 0) return true;
    }
    return false;
  }

  /**
   * Whether anybody is mid-stroke, so the ink pass can be skipped entirely.
   *
   * Separate from [`chromed`] rather than folded into it, because the two gate
   * different passes and a peer who is drawing usually has nothing selected —
   * one board in a hundred has both true at once, and a single flag would make
   * every frame of a remote stroke walk the chrome pass for nothing.
   */
  get inked(): boolean {
    for (const peer of this.live.values()) {
      if (peer.ink.any) return true;
    }
    return false;
  }

  get size(): number {
    return this.live.size;
  }

  /**
   * This client's own id, to be dropped on arrival.
   *
   * Our own state is in `getStates()` like everybody else's, and drawing it
   * would put a second cursor a frame behind the real one — which reads as the
   * pointer smearing rather than as a peer.
   */
  ignore(clientId: number): void {
    this.self = clientId;
    if (this.live.delete(clientId)) this.ver += 1;
  }

  /** A peer's awareness state arrived. */
  observe(clientId: number, state: unknown): void {
    if (clientId === this.self) return;
    const read = readPeer(state);
    if (read === null) {
      // Not a peer this board can draw — no user, so nothing to attribute a
      // cursor or an outline to. Forgotten rather than kept stale, because a
      // state that stopped being readable is not evidence of where they were.
      this.forget(clientId);
      return;
    }

    const existing = this.live.get(clientId);
    if (existing === undefined) {
      this.live.set(clientId, {
        id: read.id,
        name: read.name,
        color: read.color,
        target: read.cursor,
        // Snapped, not sprung. A cursor that appears has no previous position
        // to travel from, and a spring seeded at the origin would fly it in
        // across the board on the frame somebody joins.
        cursor: read.cursor === null ? null : { x: read.cursor.x, y: read.cursor.y },
        vx: 0,
        vy: 0,
        items: read.items,
        strings: read.strings,
        pins: read.pins,
        locks: read.locks,
        ink: new PeerInk(),
      });
      // Spliced after the record exists, because the first window of a run is
      // the same code path as the hundredth — there is no separate case for a
      // stroke that starts while somebody is joining.
      this.live.get(clientId)!.ink.splice(read.wet);
      this.ver += 1;
      return;
    }

    let changed =
      existing.name !== read.name ||
      existing.color !== read.color ||
      !same(existing.items, read.items) ||
      !same(existing.strings, read.strings) ||
      !same(existing.pins, read.pins) ||
      !sameLocks(existing.locks, read.locks);

    existing.id = read.id;
    existing.name = read.name;
    existing.color = read.color;
    existing.locks = read.locks;
    existing.items = read.items;
    existing.strings = read.strings;
    existing.pins = read.pins;
    existing.target = read.cursor;
    // Not a comparison like the fields above: a splice already knows whether it
    // changed the picture, and asking it is cheaper than walking the samples.
    if (existing.ink.splice(read.wet)) changed = true;

    if (read.cursor === null) {
      // The pointer left their board, and a peer who is no longer pointing at
      // anything must stop being drawn at once rather than gliding to a halt at
      // the last place they were.
      if (existing.cursor !== null) changed = true;
      existing.cursor = null;
      existing.vx = 0;
      existing.vy = 0;
    } else if (existing.cursor === null) {
      existing.cursor = { x: read.cursor.x, y: read.cursor.y };
      existing.vx = 0;
      existing.vy = 0;
      changed = true;
    }

    if (changed) this.ver += 1;
  }

  /** A peer disconnected. Awareness drops its state, so nothing else will say so. */
  forget(clientId: number): void {
    if (this.live.delete(clientId)) this.ver += 1;
  }

  /**
   * Advance every cursor towards where its peer last said it was.
   *
   * Called once a frame from the overlay phase, before the canvas is drawn, so
   * that a spring which moved this frame has already bumped [`version`] by the
   * time the overlay asks whether it is stale.
   */
  step(dtMs: number): void {
    const dtSec = Math.max(0, dtMs) / 1000;
    if (dtSec === 0) return;
    let moved = false;

    for (const peer of this.live.values()) {
      const at = peer.cursor;
      const target = peer.target;
      if (at === null || target === null) continue;

      const dx = target.x - at.x;
      const dy = target.y - at.y;
      if (Math.abs(dx) < SETTLED && Math.abs(dy) < SETTLED) {
        // Arrived. Snapped rather than left a fraction short, so the next frame
        // finds nothing to do — see [`SETTLED`].
        if (dx !== 0 || dy !== 0) {
          at.x = target.x;
          at.y = target.y;
          moved = true;
        }
        peer.vx = 0;
        peer.vy = 0;
        continue;
      }

      const x = criticallyDamped(at.x, peer.vx, target.x, dtSec, CURSOR_RATE);
      const y = criticallyDamped(at.y, peer.vy, target.y, dtSec, CURSOR_RATE);
      at.x = x.x;
      at.y = y.x;
      peer.vx = x.v;
      peer.vy = y.v;
      moved = true;
    }

    if (moved) this.ver += 1;
  }

  /**
   * Everybody, in no particular order.
   *
   * A fresh object per peer per call would allocate inside the frame loop, so
   * these are the store's own records read through a narrower type. The overlay
   * reads them and lets them go, like `Scene.pinsOf`.
   */
  *peers(): Iterable<DrawnPeer> {
    for (const peer of this.live.values()) yield peer;
  }
}
