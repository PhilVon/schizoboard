/**
 * Every rope on the board: what exists, what is awake, and where it all is.
 *
 * `catenary.ts` knows the shape of one segment at rest and `verlet.ts` knows
 * how to move one for a frame. Neither has ever heard of a string. This is the
 * module that does: it turns a string's run of pins into segments, finds them
 * somewhere to keep their particles, decides which ones are worth stepping,
 * and keeps a bounding box on each so the renderer and the draping pass can
 * ask what is near without walking the board.
 *
 * ## Segments, not strings
 *
 * > Each segment simulates as an independent rope pinned at both ends. That
 * > gives multi-pin runs for free, keeps the solver simple, and means moving
 * > one pin only wakes the two segments adjacent to it. — DESIGN section 2.3
 *
 * So a run of five pins is four ropes that happen to share endpoints, and a
 * closed loop is five. Nothing here special-cases hub pins or multi-pin runs
 * because there is nothing to special-case: a pin is a coordinate that two
 * segments happen to both read.
 *
 * ## Sleep is the whole scalability story
 *
 * > A board with 500 strings has, in normal use, between zero and four awake
 * > at any moment. — DESIGN section 5.3
 *
 * Which only pays off if a sleeping rope costs *nothing*, and "nothing" has to
 * include not being asked whether it should wake up. So waking is driven from
 * the dirty sets rather than by polling: a pin moves, and the reverse index
 * below turns that into the one or two segments that care. A frame in which
 * nothing moved does not touch a single rope, however many there are.
 *
 * That is AC-65's half of the bargain. The other half is that a sleeping
 * rope's string is never marked dirty, so `render/ropes/` keeps the `Path2D`
 * it already baked.
 *
 * ## Physics is never written down
 *
 * > Physics never writes to the document. Not particle positions, not swing
 * > angles, not settled rotations, not sleep flags. — DESIGN section 5.1
 *
 * Everything in here is transient and derived. Topology arrives from
 * `crdt/binding.ts` through `setString`; particle positions, bounds, sleep
 * state and the particle pool are local, rebuilt from scratch on load, and go
 * out with the tab. D-4 is why that is what makes multiplayer string scale.
 */

import { DEFAULT_STRING_MATERIAL, fibre, sagFor, sagWith } from "@/lib/material";
import { sampleChain, solveCatenary } from "@/sim/catenary";
import {
  MATERIAL_EASE,
  PLUCK_REACH,
  PLUCK_SPEED,
  ROPE_SLEEP_MOVE,
  ROPE_SLEEP_STEPS,
  ROPE_SPACING,
  SIM_STEP_MS,
} from "@/sim/tuning";
import { FixedStep, nudge, stepRope } from "@/sim/verlet";
import type { DirtySets } from "@/state/dirty";
import type { Bounds, Scene } from "@/state/scene";

/**
 * How far a pin must move before it is worth waking the ropes on it.
 *
 * The dirty sets narrow the question to pins that plausibly moved; this
 * settles it. Without it, a collaborator's pose update arriving every frame
 * for an item that is not actually moving would hold every string on that
 * item awake forever. Same reasoning, and the same order of magnitude, as the
 * guard in `torsion.ts`.
 */
const ANCHOR_EPSILON = 1e-3;

/** Particle pool growth. Starts at a few hundred ropes' worth of nothing and
 *  doubles; a board that never makes a string never allocates. */
const INITIAL_POOL = 0;

/** Where a board point lands on a rope — see `RopeSet.nearest`. */
export interface RopeHit {
  readonly string: string;
  /** Index of the node the segment starts at; an insert goes at `node + 1`. */
  readonly node: number;
  /** Arc-length fraction along that segment, 0 at `node` and 1 at `node + 1`. */
  readonly t: number;
  /** The point itself, board space. */
  readonly x: number;
  readonly y: number;
  readonly distance: number;
}

/**
 * One pin-to-pin rope.
 *
 * Cold in the sense `state/scene.ts` means it: created when the topology
 * changes, never per frame. The hot data — the particles — is in the shared
 * pool, addressed by `at` and `count`.
 */
interface Segment {
  /** The string this belongs to; what gets marked dirty when it moves. */
  readonly string: string;
  readonly a: string;
  readonly b: string;
  /** Slack ratio for this gap, from the node the segment starts at. */
  slack: number;
  /**
   * What the string is made of, which is the second half of how much it sags —
   * `lib/material.ts`. Held per segment rather than per string because that is
   * where `slack` is and the two are only ever read together; a string's
   * segments always agree on it.
   */
  material: string;
  /**
   * The sag multiplier the solver is *currently* using, easing toward the one
   * `material` asks for at `MATERIAL_EASE` per second.
   *
   * The two are equal except during a transition, and the transition is the
   * whole of AC-269 — see the constant. Transient, like everything else in this
   * file: a reload puts a string straight onto its material's number, because
   * a board opening is not somebody changing their mind about wire.
   */
  sag: number;
  /** Offset into the particle pool, in coordinates rather than particles. */
  at: number;
  count: number;
  asleep: boolean;
  /** Consecutive frames spent under `ROPE_SLEEP_MOVE`. */
  still: number;
  /** Where the two pins were when this last stepped, so a pin that has not
   *  really moved does not wake it. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class RopeSet {
  private readonly clock = new FixedStep();

  /** Segments in creation order. Holes are compacted away on removal. */
  private readonly segments: Segment[] = [];
  /** Which segments a string owns, so `setString` can replace them. */
  private readonly byString = new Map<string, Segment[]>();
  /**
   * Which segments hang off each pin — the reverse index that makes waking
   * proportional to what moved rather than to what exists.
   *
   * > moving one pin only wakes the two segments adjacent to it
   * > — DESIGN section 2.3
   *
   * "Two" is the usual case rather than the rule: a hub pin with six strings
   * through it has twelve, and they all wake, which is correct and is why
   * this is a set rather than a pair.
   */
  private readonly byPin = new Map<string, Set<Segment>>();
  /**
   * The run each string's segments were built from, so `sync` can tell a
   * topology change from a slack change without diffing the segments
   * themselves.
   */
  private readonly runs = new Map<string, string>();

  private pos = new Float64Array(INITIAL_POOL);
  private prev = new Float64Array(INITIAL_POOL);
  private top = 0;
  /** Freed ranges, keyed by particle count — ropes are re-made at the same
   *  sizes over and over, so exact-fit reuse keeps the pool from creeping. */
  private readonly free = new Map<number, number[]>();

  /** How many ropes are being stepped. The dev HUD's cheapest assertion that
   *  an idle board is idle. */
  get awake(): number {
    let n = 0;
    for (const s of this.segments) if (!s.asleep) n++;
    return n;
  }

  get size(): number {
    return this.segments.length;
  }

  /**
   * Install or replace a string's topology.
   *
   * `pins` is the ordered run and `slack` the per-node ratios; for an open
   * string the last entry is unused, and for a closed one it is the
   * wrap-around segment (DATA-MODEL section 5.2). The segments are built and
   * seeded at rest, so this is a *topology* change: `sync` calls it when the
   * run of pins is genuinely different and handles a slack-only or
   * material-only edit without coming here, because re-seeding is the wrong
   * answer to either.
   *
   * Fewer than two nodes is not an error, it is a string that has nothing to
   * draw yet; the document layer deletes it (DATA-MODEL section 5.3) and this
   * simply holds no segments for it in the meantime.
   */
  setString(
    scene: Scene,
    dirty: DirtySets,
    id: string,
    pins: readonly string[],
    slack: readonly number[],
    closed = false,
    material: string = DEFAULT_STRING_MATERIAL,
  ): void {
    this.removeString(dirty, id);
    const spans = closed ? pins.length : pins.length - 1;
    if (pins.length < 2 || spans < 1) return;

    const owned: Segment[] = [];
    for (let i = 0; i < spans; i++) {
      const a = pins[i]!;
      const b = pins[(i + 1) % pins.length]!;
      const segment: Segment = {
        string: id,
        a,
        b,
        slack: Math.max(slack[i] ?? 0, 0),
        material,
        // A rope being built is a rope arriving, not one changing material, so
        // it starts on its own number rather than easing onto it.
        sag: fibre(material).sag,
        at: 0,
        count: 0,
        asleep: true,
        still: ROPE_SLEEP_STEPS,
        ax: Number.NaN,
        ay: Number.NaN,
        bx: Number.NaN,
        by: Number.NaN,
        minX: 0,
        minY: 0,
        maxX: 0,
        maxY: 0,
      };
      this.segments.push(segment);
      owned.push(segment);
      this.index(a, segment);
      this.index(b, segment);
      this.seed(scene, segment);
    }
    this.byString.set(id, owned);
    this.runs.set(id, runSignature(pins, closed));
    dirty.rope(id);
  }

  removeString(dirty: DirtySets, id: string): void {
    const owned = this.byString.get(id);
    if (owned === undefined) return;
    for (const segment of owned) {
      this.unindex(segment.a, segment);
      this.unindex(segment.b, segment);
      this.release(segment);
      const i = this.segments.indexOf(segment);
      if (i >= 0) this.segments.splice(i, 1);
    }
    this.byString.delete(id);
    this.runs.delete(id);
    dirty.rope(id);
  }

  /** Everything goes. For teardown and for a document swapped out underneath
   *  the scene — none of this is derived from the new one. */
  clear(): void {
    this.segments.length = 0;
    this.byString.clear();
    this.byPin.clear();
    this.runs.clear();
    this.free.clear();
    this.top = 0;
    this.clock.reset();
  }

  /**
   * SIM phase (3).
   *
   * Wakes what the frame disturbed, steps what is awake, and sleeps what has
   * stopped. A frame on which nothing moved does none of the three.
   */
  step(scene: Scene, dirty: DirtySets, dtMs: number): void {
    if (dirty.all) {
      // The mirror was rebuilt from scratch, so the rope set is too: strings
      // that are gone go, and the rest are re-read before anything is seeded.
      for (const id of [...this.byString.keys()]) {
        if (!scene.strings.has(id)) this.sync(scene, dirty, id);
      }
      for (const id of scene.strings.keys()) this.sync(scene, dirty, id);
    } else {
      for (const id of dirty.strings) this.sync(scene, dirty, id);
    }

    if (dirty.all) {
      // A load or an undo is a state restore rather than an event. Every rope
      // goes back to its analytic rest pose, asleep — which is AC-62, and the
      // same argument `torsion.ts` makes for settling swings on the same flag.
      for (const segment of this.segments) this.seed(scene, segment);
      for (const id of this.byString.keys()) dirty.rope(id);
    } else {
      this.wakeDisturbed(scene, dirty);
    }

    const steps = this.clock.advance(dtMs);
    if (steps === 0) return;

    for (const segment of this.segments) {
      if (segment.asleep) continue;
      const a = scene.pins.get(segment.a);
      const b = scene.pins.get(segment.b);
      if (a === undefined || b === undefined) {
        // A node pointing at a pin that is not there is skipped (DATA-MODEL
        // section 8.1). Transient by construction — the pin cascade removes
        // the node — so it sleeps rather than being torn down here.
        segment.asleep = true;
        continue;
      }
      scene.layoutPin(a);
      scene.layoutPin(b);

      const easing = this.ease(segment, steps);
      const chord = Math.hypot(b.wx - a.wx, b.wy - a.wy);
      const rest = chord * (1 + sagWith(segment.slack, segment.sag));
      const travelled = stepRope(
        this.pos,
        this.prev,
        segment.at,
        segment.count,
        rest / (segment.count - 1),
        a.wx,
        a.wy,
        b.wx,
        b.wy,
        steps,
      );

      segment.ax = a.wx;
      segment.ay = a.wy;
      segment.bx = b.wx;
      segment.by = b.wy;
      this.bound(segment);
      dirty.rope(segment.string);

      // > Sleep when the largest particle movement stays under about 0.05 px
      // > for 12 consecutive frames. — DESIGN section 5.3
      //
      // Unless it is still becoming a different material. A rope near the end
      // of a slow transition moves less per frame than the sleep threshold, and
      // without this it would drop off part-way and freeze between two
      // materials — a wire hanging like something that is not quite either.
      segment.still = travelled < ROPE_SLEEP_MOVE && !easing ? segment.still + 1 : 0;
      if (segment.still >= ROPE_SLEEP_STEPS) segment.asleep = true;
    }
  }

  /**
   * Bring one string's ropes into line with what the scene mirror says.
   *
   * Called for everything in `dirty.strings`, which the binding writes — this
   * is the whole of the document's route into the simulation, and it goes
   * through the mirror rather than through `crdt/` because `sim/` may not
   * import the document (ARCHITECTURE rule 2, and the lint rule says so).
   *
   * The distinction it draws is worth the code. Rebuilding a string's segments
   * throws away their particles and re-seeds them at rest, which is right when
   * the *run* changed — a pin inserted mid-string is a different set of ropes —
   * and quite wrong when only the slack did:
   *
   * > **Wake** on: an endpoint moving more than a hair this frame; a topology
   * > change; a slack change; a pluck; or an explicit impulse.
   * > — DESIGN section 5.3
   *
   * A slack change *wakes* a rope, it does not teleport one. Rolling the wheel
   * over a segment should let the sag out in front of you; re-seeding on every
   * wheel tick would snap it through a series of rest poses instead. So an
   * unchanged run keeps its particles and just gets the new numbers and a
   * shove.
   *
   * **Material is the same kind of edit and takes the same route**, which is
   * AC-269. It is not obvious: unlike a wheel tick, picking *Wire* off a menu
   * is a single discrete event with no gesture around it, and re-seeding it
   * would give the analytic rest pose immediately and correctly. It would also
   * be a teleport — the rope would be in a different place on the next frame
   * than it was on this one, with nothing in between, which is precisely the
   * jump AC-269 forbids. Waking instead lets the solver haul the belly up over
   * a few dozen substeps, and the string is seen to *tighten*. The same
   * argument as the mid-string split in `lib/slack.ts`, and the same failure it
   * is guarding against.
   */
  private sync(scene: Scene, dirty: DirtySets, id: string): void {
    const mirror = scene.strings.get(id);
    if (mirror === undefined) {
      this.removeString(dirty, id);
      return;
    }

    const signature = runSignature(mirror.nodes, mirror.closed);
    if (this.runs.get(id) === signature) {
      const owned = this.byString.get(id);
      if (owned === undefined) return;
      let moved = false;
      for (let i = 0; i < owned.length; i++) {
        const slack = Math.max(mirror.nodes[i]?.slackAfter ?? 0, 0);
        if (owned[i]!.slack !== slack) {
          owned[i]!.slack = slack;
          moved = true;
        }
        if (owned[i]!.material !== mirror.material) {
          owned[i]!.material = mirror.material;
          moved = true;
        }
      }
      // The style edits that are only style — a colour, a thickness, a
      // tuck-behind — change no geometry, so they wake nothing. The renderer is
      // told by `dirty.strings` directly and reads them off the mirror.
      if (moved) for (const segment of owned) this.rouse(segment);
      return;
    }

    this.setString(
      scene,
      dirty,
      id,
      mirror.nodes.map((node) => node.pin),
      mirror.nodes.map((node) => node.slackAfter),
      mirror.closed,
      mirror.material,
    );
  }

  /** Wake every segment of a string — an impulse, or a slack nudge that did not
   *  go through the document. */
  wake(id: string): void {
    for (const segment of this.byString.get(id) ?? []) this.rouse(segment);
  }

  /**
   * Pluck the string nearest this board point.
   *
   * > | Pluck | Click and release without dragging, on a taut string | A
   * > travelling wave runs down it and damps out. Purely for joy
   * > — DESIGN section 3.4
   *
   * Whether the string is taut enough to be worth plucking is not asked here.
   * That is `lib/slack.ts`'s `isTaut`, and it is asked by the gesture, because
   * it is the same question the taut *toggle* asks of the same segment and two
   * answers would be two different ideas of taut.
   *
   * ## Sideways, and into one segment
   *
   * The kick is perpendicular to the rope where it was grabbed, because a
   * transverse wave is the only kind this solver can carry — the links resist
   * stretching almost completely, so a kick along the rope is absorbed by the
   * first projection pass and nothing moves.
   *
   * And it stays in the segment it was given to. A pin is a fixed anchor, so a
   * wave physically cannot cross one; on a two-pin string — which is nearly all
   * of them — that is the whole string, and on a longer run it is the stretch
   * you actually plucked. Waking the neighbours instead would show a wave
   * appearing on the far side of a pin that never moved.
   *
   * Returns whether anything was plucked, so the caller can tell a hit from a
   * string with nothing to shake: a two-particle segment is all anchor and has
   * no interior to move.
   */
  pluck(id: string, bx: number, by: number): boolean {
    const owned = this.byString.get(id);
    if (owned === undefined) return false;

    // The nearest *interior* particle. The endpoints are pins and are seated
    // every micro-step (`sim/verlet.ts`), so a kick there is overwritten before
    // it is integrated once.
    let target: Segment | null = null;
    let index = -1;
    let nearest = Infinity;
    for (const segment of owned) {
      for (let i = 1; i < segment.count - 1; i++) {
        const j = segment.at + i * 2;
        const dx = this.pos[j]! - bx;
        const dy = this.pos[j + 1]! - by;
        const d = dx * dx + dy * dy;
        if (d >= nearest) continue;
        nearest = d;
        target = segment;
        index = i;
      }
    }
    if (target === null) return false;

    const j = target.at + index * 2;
    // The tangent from the two neighbours rather than one, so the direction is
    // the rope's rather than one link's.
    let tx = this.pos[j + 2]! - this.pos[j - 2]!;
    let ty = this.pos[j + 3]! - this.pos[j - 1]!;
    const length = Math.hypot(tx, ty);
    if (length > 0) {
      tx /= length;
      ty /= length;
    } else {
      tx = 1;
      ty = 0;
    }
    // Downward of the two perpendiculars — a real pluck is released and falls
    // through, and picking a side by the geometry rather than by the cursor
    // means a click exactly *on* the string still has a direction. A vertical
    // rope has no downward perpendicular, so it goes to the right instead.
    let nx = -ty;
    let ny = tx;
    if (ny < 0 || (ny === 0 && nx < 0)) {
      nx = -nx;
      ny = -ny * 1;
    }

    for (let k = -PLUCK_REACH; k <= PLUCK_REACH; k++) {
      const i = index + k;
      if (i < 1 || i > target.count - 2) continue;
      // Linear falloff to zero just past the reach, which is the bump that
      // makes this a wave rather than a kink the solver flattens in one pass.
      const share = 1 - Math.abs(k) / (PLUCK_REACH + 1);
      const speed = PLUCK_SPEED * share;
      nudge(this.prev, target.at + i * 2, nx * speed, ny * speed);
    }

    this.rouse(target);
    return true;
  }

  /**
   * Read a segment's particles. `at` and `count` address `positions`, which
   * is the shared pool and is handed out live rather than copied — the
   * renderer walks it to build a `Path2D` and must not pay for a slice per
   * rope per frame.
   */
  get positions(): Float64Array {
    return this.pos;
  }

  /**
   * Every segment of a string, in run order. The renderer draws a string as
   * its segments end to end; `visit` exists so it can do that without this
   * module minting an array per string per frame.
   */
  visit(
    id: string,
    fn: (at: number, count: number, asleep: boolean) => void,
  ): void {
    for (const segment of this.byString.get(id) ?? []) {
      if (segment.count > 0) fn(segment.at, segment.count, segment.asleep);
    }
  }

  /**
   * The board-space box a string occupies, sag included, or `null` if it has
   * no drawable segments.
   *
   * This is the bounds index: culling asks it whether a string is worth
   * drawing, and the draping pass (T-64) will ask it which items a rope could
   * possibly be lying on. Kept per segment and unioned on request rather than
   * cached per string, because a string's segments move independently and the
   * union is a handful of comparisons.
   */
  boundsOf(id: string, out: Bounds): Bounds | null {
    const owned = this.byString.get(id);
    if (owned === undefined || owned.length === 0) return null;
    let found = false;
    for (const segment of owned) {
      if (segment.count === 0) continue;
      if (!found) {
        out.minX = segment.minX;
        out.minY = segment.minY;
        out.maxX = segment.maxX;
        out.maxY = segment.maxY;
        found = true;
        continue;
      }
      if (segment.minX < out.minX) out.minX = segment.minX;
      if (segment.minY < out.minY) out.minY = segment.minY;
      if (segment.maxX > out.maxX) out.maxX = segment.maxX;
      if (segment.maxY > out.maxY) out.maxY = segment.maxY;
    }
    return found ? out : null;
  }

/**
   * The nearest point on any rope to a board point, within `reach`.
   *
   * > Hover a string. The nearest point on the rope highlights, tracking your
   * > cursor along the curve. — DESIGN section 3.4
   *
   * Against the **particles**, not against the chord between the pins — the
   * whole gesture is grabbing the string where it actually hangs, and a
   * catenary with any drape in it is nowhere near its own chord in the middle.
   *
   * `t` is the arc-length fraction along the segment, which is what
   * `lib/slack.ts` needs to split the slack without the sag jumping. Arc
   * length rather than distance along the chord, and it comes out for free:
   * the particles are equally spaced by rest length (D-16), so walking them is
   * already walking the string at constant speed.
   *
   * `node` is the index of the string node the segment *starts* at, so
   * inserting goes at `node + 1`.
   */
  nearest(bx: number, by: number, reach: number): RopeHit | null {
    let best: RopeHit | null = null;
    let bestDistance = reach;

    for (const [id, owned] of this.byString) {
      for (let k = 0; k < owned.length; k++) {
        const segment = owned[k]!;
        if (segment.count < 2) continue;
        // The bounding box is the cheap rejection, and on a board of five
        // hundred strings it is almost all of them.
        if (
          bx < segment.minX - reach ||
          bx > segment.maxX + reach ||
          by < segment.minY - reach ||
          by > segment.maxY + reach
        ) {
          continue;
        }

        const links = segment.count - 1;
        for (let i = 0; i < links; i++) {
          const at = segment.at + i * 2;
          const ax = this.pos[at]!;
          const ay = this.pos[at + 1]!;
          const dx = this.pos[at + 2]! - ax;
          const dy = this.pos[at + 3]! - ay;
          const span = dx * dx + dy * dy;
          // Where along this link the point falls, clamped to its ends so a
          // point beyond the link belongs to its neighbour instead.
          const u = span > 0 ? Math.min(1, Math.max(0, ((bx - ax) * dx + (by - ay) * dy) / span)) : 0;
          const px = ax + dx * u;
          const py = ay + dy * u;
          const distance = Math.hypot(bx - px, by - py);
          if (distance >= bestDistance) continue;
          bestDistance = distance;
          best = { string: id, node: k, t: (i + u) / links, x: px, y: py, distance };
        }
      }
    }
    return best;
  }

  /** Strings whose bounds meet `rect`, appended to `into`. */
  stringsIn(rect: Bounds, into: string[]): string[] {
    for (const [id, owned] of this.byString) {
      for (const segment of owned) {
        if (segment.count === 0) continue;
        if (
          segment.maxX >= rect.minX &&
          segment.minX <= rect.maxX &&
          segment.maxY >= rect.minY &&
          segment.minY <= rect.maxY
        ) {
          into.push(id);
          break;
        }
      }
    }
    return into;
  }

  /**
   * Which segments the frame disturbed.
   *
   * A parented pin moves when its item does, and a free pin moves on its own,
   * so both dirty sets feed this. The cost is proportional to what changed —
   * a board of five hundred sleeping strings with one photograph being dragged
   * looks at the two or three segments tied to that photograph and nothing
   * else.
   */
  private wakeDisturbed(scene: Scene, dirty: DirtySets): void {
    if (this.segments.length === 0) return;
    for (const pinId of dirty.pins) this.rousePin(scene, dirty, pinId);
    for (const itemId of dirty.items) {
      for (const pinId of scene.pinsOf(itemId)) this.rousePin(scene, dirty, pinId);
    }
  }

  private rousePin(scene: Scene, dirty: DirtySets, pinId: string): void {
    const hanging = this.byPin.get(pinId);
    if (hanging === undefined) return;
    const pin = scene.pins.get(pinId);
    if (pin === undefined) return;
    scene.layoutPin(pin);
    for (const segment of hanging) {
      // A segment that holds no particles was built while one of its pins did
      // not exist — a node that arrived before the pin it names, which is
      // ordinary under concurrent edits. The pin turning up is the event that
      // gives it a shape, and it gets the same analytic rest pose and the same
      // sleep as one created in order.
      if (segment.count === 0) {
        this.seed(scene, segment);
        if (segment.count > 0) dirty.rope(segment.string);
        continue;
      }
      if (!segment.asleep) continue;
      const moved =
        segment.a === pinId
          ? Math.abs(pin.wx - segment.ax) + Math.abs(pin.wy - segment.ay)
          : Math.abs(pin.wx - segment.bx) + Math.abs(pin.wy - segment.by);
      if (moved > ANCHOR_EPSILON) this.rouse(segment);
    }
  }

  private rouse(segment: Segment): void {
    segment.asleep = false;
    segment.still = 0;
  }

  /**
   * Walk a segment's sag multiplier toward the one its material asks for, and
   * say whether it is still on the way.
   *
   * Linear and clamped, so it lands exactly rather than approaching — see
   * `MATERIAL_EASE` for why that matters more than it sounds. Called only for
   * awake segments, which is safe because the thing that changes `material` in
   * the first place is `sync`, and `sync` wakes what it changed.
   */
  private ease(segment: Segment, steps: number): boolean {
    const target = fibre(segment.material).sag;
    if (segment.sag === target) return false;
    const step = (MATERIAL_EASE * steps * SIM_STEP_MS) / 1000;
    segment.sag =
      segment.sag < target
        ? Math.min(target, segment.sag + step)
        : Math.max(target, segment.sag - step);
    return segment.sag !== target;
  }

  /**
   * Put a segment at its analytic rest pose, asleep.
   *
   * The particle count comes from the rest length *as it is now*, and is then
   * held for the life of the segment: slack is a ratio, so dragging the pins
   * apart lengthens the rope, and re-counting every frame would mean
   * reallocating and re-seeding mid-drag — which is a visible pop in exchange
   * for particles that are already the right density either side of it. Drag
   * two pins three times further apart and the particles get three times
   * sparser until the next topology or slack edit re-seeds them.
   */
  private seed(scene: Scene, segment: Segment): void {
    const a = scene.pins.get(segment.a);
    const b = scene.pins.get(segment.b);
    if (a === undefined || b === undefined) {
      this.release(segment);
      segment.asleep = true;
      return;
    }
    scene.layoutPin(a);
    scene.layoutPin(b);

    // A seed is a rest pose, so any transition in flight is over: an undo or a
    // reload puts the rope on its material's own number rather than resuming an
    // ease nobody is watching any more.
    segment.sag = fibre(segment.material).sag;
    const chord = Math.hypot(b.wx - a.wx, b.wy - a.wy);
    const cat = solveCatenary(
      a.wx,
      a.wy,
      b.wx,
      b.wy,
      chord * (1 + sagFor(segment.slack, segment.material)),
    );
    const count = Math.max(2, Math.round(cat.length / ROPE_SPACING) + 1);
    if (count !== segment.count) {
      this.release(segment);
      segment.at = this.alloc(count);
      segment.count = count;
    }

    sampleChain(cat, this.pos, count, segment.at);
    // Seeded, therefore at rest: no velocity, and asleep on the frame it is
    // created. This is AC-62 — "a board opens perfectly still".
    this.prev.set(this.pos.subarray(segment.at, segment.at + count * 2), segment.at);
    segment.ax = a.wx;
    segment.ay = a.wy;
    segment.bx = b.wx;
    segment.by = b.wy;
    segment.asleep = true;
    segment.still = ROPE_SLEEP_STEPS;
    this.bound(segment);
  }

  private bound(segment: Segment): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const end = segment.at + segment.count * 2;
    for (let i = segment.at; i < end; i += 2) {
      const x = this.pos[i]!;
      const y = this.pos[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    segment.minX = minX;
    segment.minY = minY;
    segment.maxX = maxX;
    segment.maxY = maxY;
  }

  private index(pinId: string, segment: Segment): void {
    let hanging = this.byPin.get(pinId);
    if (hanging === undefined) {
      hanging = new Set<Segment>();
      this.byPin.set(pinId, hanging);
    }
    hanging.add(segment);
  }

  private unindex(pinId: string, segment: Segment): void {
    const hanging = this.byPin.get(pinId);
    if (hanging === undefined) return;
    hanging.delete(segment);
    if (hanging.size === 0) this.byPin.delete(pinId);
  }

  private alloc(count: number): number {
    const reusable = this.free.get(count);
    const recycled = reusable?.pop();
    if (recycled !== undefined) return recycled;

    const need = count * 2;
    if (this.top + need > this.pos.length) {
      // Round up to a power of two so a board that grows a rope at a time
      // does not reallocate on every one of them.
      const size = Math.pow(2, Math.ceil(Math.log2(Math.max(this.top + need, 256))));
      const pos = new Float64Array(size);
      const prev = new Float64Array(size);
      pos.set(this.pos);
      prev.set(this.prev);
      this.pos = pos;
      this.prev = prev;
    }
    const at = this.top;
    this.top += need;
    return at;
  }

  private release(segment: Segment): void {
    if (segment.count === 0) return;
    let reusable = this.free.get(segment.count);
    if (reusable === undefined) {
      reusable = [];
      this.free.set(segment.count, reusable);
    }
    reusable.push(segment.at);
    segment.count = 0;
  }
}

/**
 * A run of pins, as one comparable value. The separator is a character no id
 * contains, so two different runs cannot collide into the same signature by
 * concatenation — `["ab", "c"]` and `["a", "bc"]` are famously the same string
 * once you join them with nothing.
 */
function runSignature(
  nodes: readonly string[] | readonly { pin: string }[],
  closed: boolean,
): string {
  const pins =
    typeof nodes[0] === "string"
      ? (nodes as readonly string[])
      : (nodes as readonly { pin: string }[]).map((node) => node.pin);
  return `${pins.join(" ")}|${closed ? "c" : "o"}`;
}

/** How long a rope takes to fall asleep once it stops moving, in
 *  milliseconds — for tests and for the dev HUD to label a countdown. */
export const ROPE_SLEEP_MS = ROPE_SLEEP_STEPS * SIM_STEP_MS;
