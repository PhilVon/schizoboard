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
 * `grab`, `wet`, `impulse` and `locks` from section 9 are absent because the
 * work that produces them has not happened: remote drag poses are T-72, wet ink
 * is T-73, segment locks are T-130. Each adds its own field and its own test.
 */

import type { Camera } from "@/state/camera";
import type { Selection } from "@/state/selection";

/** Who this is. The only field a peer shows a human directly. */
export interface PresenceUser {
  id: string;
  name: string;
  /** CSS colour. One per peer, so cursors and chrome can be told apart. */
  color: string;
}

/**
 * Where they are looking.
 *
 * > `cam` earns its place — it lets a seeding peer push assets a collaborator
 * > is about to look at, before they ask. — section 9
 */
export interface PresenceCam {
  x: number;
  y: number;
  zoom: number;
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

export interface PresenceState {
  user: PresenceUser;
  cam: PresenceCam | null;
  cursor: PresenceCursor | null;
  selection: PresenceSelection;
}

/** The narrow slice of `Awareness` this needs. Keeps the tests free of Yjs. */
export interface PresenceChannel {
  setLocalState(state: Record<string, unknown> | null): void;
}

export interface PresenceOptions {
  /**
   * Publish on every nth frame. Two is section 9's "at most every other frame";
   * a slower peer or a busier board can be given a larger number without
   * anything else changing.
   */
  everyNthFrame?: number;
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

/** Zoom is a multiplier, so it needs its own precision. */
function roundZoom(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export class Presence {
  private readonly channel: PresenceChannel;
  private readonly camera: Camera;
  private readonly selection: Selection;
  private readonly user: PresenceUser;
  private readonly everyNthFrame: number;

  /** Last published, so an unchanged frame costs a comparison and no message. */
  private cam: PresenceCam | null = null;
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

  constructor(
    channel: PresenceChannel,
    camera: Camera,
    selection: Selection,
    user: PresenceUser,
    options: PresenceOptions = {},
  ) {
    this.channel = channel;
    this.camera = camera;
    this.selection = selection;
    this.user = user;
    this.everyNthFrame = Math.max(1, Math.floor(options.everyNthFrame ?? 2));
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
   * Publish, if this is a publishing frame and anything is different.
   *
   * Takes the frame index rather than the frame, so that nothing in `state/`
   * has to know what a frame is.
   */
  flush(frameIndex: number): void {
    if (this.stopped) return;
    if (frameIndex % this.everyNthFrame !== 0) return;

    const cam = this.readCamera();
    const cursor = this.pointer;
    if (this.published && !this.changed(cam, cursor)) return;

    this.cam = cam;
    this.cursor = cursor;
    this.selected = this.selection.snapshot();
    this.selectionVersion = this.selection.version;
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
      cam: this.cam === null ? null : { x: this.cam.x, y: this.cam.y, zoom: this.cam.zoom },
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
    };
    this.channel.setLocalState(state as unknown as Record<string, unknown>);
  }

  private readCamera(): PresenceCam {
    return {
      x: round(this.camera.x),
      y: round(this.camera.y),
      zoom: roundZoom(this.camera.zoom),
    };
  }

  private changed(cam: PresenceCam, cursor: PresenceCursor | null): boolean {
    if (this.cam === null) return true;
    if (cam.x !== this.cam.x || cam.y !== this.cam.y || cam.zoom !== this.cam.zoom) return true;

    if ((cursor === null) !== (this.cursor === null)) return true;
    if (cursor !== null && this.cursor !== null) {
      if (cursor.x !== this.cursor.x || cursor.y !== this.cursor.y) return true;
      if (cursor.tool !== this.cursor.tool) return true;
    }

    return this.selection.version !== this.selectionVersion;
  }
}
