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
  MAX_AWAKE_PARTICLES,
  ROPE_SLEEP_MOVE,
  ROPE_SLEEP_STEPS,
  ROPE_SPACING,
  SIM_STEP_MS,
} from "@/sim/tuning";
import { FixedStep, stepRope } from "@/sim/verlet";
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
  /**
   * Index, in the run, of the node this segment starts at.
   *
   * Not the segment's own position in the string's list, which is what
   * `nearest` used to report and which stopped being the same number the
   * moment a segment could span more than one node — see `setString`. An
   * insert goes at `node + 1`, so getting this wrong puts a pin in the wrong
   * gap.
   *
   * Refreshed by `sync` rather than fixed at build time, because the janitor
   * can shorten a run without changing anything drawable (`crdt/janitor.ts`).
   */
  node: number;
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
  /**
   * Asleep because it is off screen rather than because it stopped moving.
   *
   * The distinction is the whole of the viewport gate. A rope that settles
   * keeps a pose worth resuming from; a rope that was switched off mid-swing
   * with nobody watching keeps a pose that is merely where it happened to be,
   * and its pins may have moved a long way since. So this is what `admit`
   * reads to know the pose is not to be trusted when the rope comes back.
   */
  gated: boolean;
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

  /** What `admit` decided to step this frame. A field rather than a local so
   *  that the one allocation is made once and not sixty times a second. */
  private readonly running: Segment[] = [];

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

  /**
   * How many particles those ropes hold — the number DESIGN section 9.5 asks
   * the HUD for, and the one `MAX_AWAKE_PARTICLES` is spent in.
   *
   * Not the same question as `awake`. The solver's cost is linear in particles
   * and a rope's particle count is its length over `ROPE_SPACING`, so one long
   * string across the board can outweigh a dozen short ones and a rope count
   * would call them equal.
   */
  get awakeParticles(): number {
    let n = 0;
    for (const s of this.segments) if (!s.asleep) n += s.count;
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
   *
   * ## A node that resolves to nothing is stepped over, not stopped at
   *
   * > A string node pointing at a missing pin is skipped at render time.
   * > — DATA-MODEL section 8.1
   *
   * *Skipped*, which means the run reconnects around it: a segment goes from
   * each resolving node to the next resolving node, however many dead ones lie
   * between them. Building a segment per *adjacent* pair instead — which is
   * what this did — puts the missing pin at the end of two of them, and
   * `seed` then releases both. A three-node run that lost its middle pin drew
   * nothing at all: no particles, no bounds, nothing for `nearest` to find,
   * while sitting in the scene with all three nodes and satisfying invariant 3.
   *
   * Which is not the transient the sleep branch in `step` assumes. A pin
   * deletion that meets a concurrent edit to the same run leaves the node
   * behind on the merge (T-76), and no cascade will ever reach it — that state
   * is the reason `crdt/janitor.ts` exists, and it lasts until the janitor gets
   * to it, which on a client that is not elected means until somebody else's
   * write arrives.
   *
   * The gap inherits the slack of the node it starts at and nothing is merged
   * into it, so it hangs slightly tighter than the two gaps it replaces. That
   * is not a compromise, it is the only answer available: merging rest lengths
   * needs the chord either side of the vanished pin, and a pin that is gone has
   * no position — `healSlack` bails to the written value for the same reason.
   * It also makes this and the janitor's own compaction agree exactly, so
   * collecting the dead node later moves no rope.
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
    const run = resolving(scene, pins);
    const spans = closed ? run.length : run.length - 1;
    if (run.length < 2 || spans < 1) return;

    const owned: Segment[] = [];
    for (let i = 0; i < spans; i++) {
      const node = run[i]!;
      const a = pins[node]!;
      const b = pins[run[(i + 1) % run.length]!]!;
      const segment: Segment = {
        string: id,
        a,
        b,
        node,
        slack: Math.max(slack[node] ?? 0, 0),
        material,
        // A rope being built is a rope arriving, not one changing material, so
        // it starts on its own number rather than easing onto it.
        sag: fibre(material).sag,
        at: 0,
        count: 0,
        asleep: true,
        gated: false,
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
    this.runs.set(id, runSignature(run.map((node) => pins[node]!), closed));
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
   *
   * `view` is the board-space rectangle worth simulating — the viewport grown
   * by `SIM_MARGIN`, computed by the caller so that `sim/` never has to know
   * what a camera is. Passing `null` says *simulate everything*: there is no
   * camera to prioritise by, so there is no gate and no cap. That is what the
   * tests want, and it is the honest answer for any caller stepping the board
   * for a reason other than showing it to somebody.
   */
  step(scene: Scene, dirty: DirtySets, dtMs: number, view: Bounds | null = null): void {
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

    for (const segment of this.admit(scene, dirty, view)) {
      const a = scene.pins.get(segment.a);
      const b = scene.pins.get(segment.b);
      if (a === undefined || b === undefined) {
        // Belt and braces. `setString` only builds segments between nodes that
        // resolve, and a pin appearing or disappearing dirties every string
        // naming it (`crdt/binding.ts`), so the rebuild above has already run
        // by the time this loop does. What is left is the frame ordering going
        // wrong, and a sleeping rope is a better answer to that than a throw.
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
   * Which segments this frame actually steps: awake, near the camera, and
   * inside the particle budget.
   *
   * > A rope simulates only if its bounds, expanded by maximum sag, intersect
   * > the viewport margin; otherwise it force-sleeps at its cached pose.
   * > — DESIGN section 9.2
   *
   * "Expanded by maximum sag" is already true of the bounds themselves rather
   * than something to do here: `bound` walks the particles, so the box is the
   * shape the rope actually hangs in and not the chord between its pins.
   *
   * The gate is the cheap half and the one that matters. Without it, an
   * off-screen rope that something keeps disturbing — a peer dragging its
   * photograph, an undo far away — simulates at full cost forever, which is
   * the exposure DESIGN section 9.2 names and the one the sleep manager cannot
   * cover, because the whole point of a disturbance is that it wakes things up.
   * Gated, that rope costs four comparisons a frame.
   */
  private admit(scene: Scene, dirty: DirtySets, view: Bounds | null): Segment[] {
    const running = this.running;
    running.length = 0;
    let particles = 0;

    for (const segment of this.segments) {
      // A segment with no particles has no box to test — its bounds are the
      // ±Infinity seeds from `bound`. It is also doing nothing, so the ordinary
      // path below is already the right answer for it.
      if (view !== null && segment.count > 0) {
        if (!meets(segment, view)) {
          // Only a rope switched off *mid-motion* is flagged. One that had
          // already settled has nothing to resume and nothing to re-seed for:
          // its pose is the answer, and re-deriving it on the way back would
          // slide every particle along the curve to no visible end. So gating
          // an idle rope has to be exactly the no-op that not gating it was.
          if (!segment.asleep) {
            segment.asleep = true;
            segment.gated = true;
          }
          continue;
        }
        if (segment.gated) {
          /**
           * Back on screen, and the cached pose is not to be trusted.
           *
           * Whatever happened while it was gated, the honest answer is the
           * analytic rest pose under the pins as they stand now — because the
           * rope has *had* that time to settle and would have. Resuming from
           * the cached pose instead is what looks wrong: the pins can have
           * moved half a board since, and the solver hauling the particles
           * after them is a whip, not a string.
           *
           * It is also the rule two other places already use. A load and an
           * undo re-seed every rope (`dirty.all`, above); a swing that leaves
           * the margin is put straight at its equilibrium (`sim/torsion.ts`).
           * Same principle in all three: what nobody watched has settled.
           *
           * Never seen at the boundary, only at the margin — `SIM_MARGIN` puts
           * the gate a fifth of a screen outside the glass, so a rope crossing
           * it under a pan is off screen when this fires. A zoom-out is the one
           * gesture that un-gates and reveals in the same frame, and re-seeding
           * is exactly what a board arriving all at once should do anyway.
           */
          segment.gated = false;
          this.seed(scene, segment);
          dirty.rope(segment.string);
          continue;
        }
      }
      if (segment.asleep) continue;
      running.push(segment);
      particles += segment.count;
    }

    if (view === null || particles <= MAX_AWAKE_PARTICLES) return running;
    return this.cap(running, view);
  }

  /**
   * Spend the particle budget on what is most on screen.
   *
   * > A global cap on awake particles, prioritised by on-screen area, means a
   * > pathological board degrades gracefully instead of dropping frames.
   * > — DESIGN section 9.2
   *
   * A rope that loses is not slept and not re-seeded: it keeps its pose, keeps
   * its `still` count, and contends again next frame. So this is a deferral
   * rather than a decision, and it drains itself — the ropes that do get
   * stepped settle and drop out of the count, which is what frees the budget
   * for the ones that did not. Degrading means a few of the least visible
   * strings hold still for a moment, which is the trade section 9.2 is asking
   * for.
   *
   * The sort only ever runs on the frames the budget is actually exceeded,
   * which on a board obeying DESIGN section 5.3 is none of them.
   */
  private cap(running: Segment[], view: Bounds): Segment[] {
    running.sort((p, q) => overlap(q, view) - overlap(p, view));

    let particles = 0;
    let kept = 0;
    for (const segment of running) {
      // Stop at the first that does not fit rather than skipping it for a
      // smaller one behind it. Priority *is* the contract here, and a budget
      // spent more fully by inverting it would be a rope freezing while a less
      // visible one moves.
      if (particles + segment.count > MAX_AWAKE_PARTICLES) break;
      particles += segment.count;
      kept++;
    }
    // One rope longer than the entire budget still gets stepped. It is the only
    // way it ever moves again, and a permanently frozen string is a worse
    // failure than one slow frame.
    running.length = Math.max(1, kept);
    return running;
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
   * > change; or a slack change.
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

    const pins = mirror.nodes.map((node) => node.pin);
    const run = resolving(scene, pins);
    const signature = runSignature(run.map((node) => pins[node]!), mirror.closed);
    if (this.runs.get(id) === signature) {
      const owned = this.byString.get(id);
      if (owned === undefined) return;
      let moved = false;
      // Segment `k` starts at the `k`th *resolving* node, which is where its
      // slack comes from and which is not `k` on a run carrying a dead node.
      // Re-derived rather than trusted, because a run can lose a node without
      // changing anything drawable — the janitor collecting the dead one — and
      // that must not silently re-point a segment at the wrong slack.
      for (let k = 0; k < owned.length; k++) {
        const node = run[k]!;
        owned[k]!.node = node;
        const slack = Math.max(mirror.nodes[node]?.slackAfter ?? 0, 0);
        if (owned[k]!.slack !== slack) {
          owned[k]!.slack = slack;
          moved = true;
        }
        if (owned[k]!.material !== mirror.material) {
          owned[k]!.material = mirror.material;
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
      pins,
      mirror.nodes.map((node) => node.slackAfter),
      mirror.closed,
      mirror.material,
    );
  }

  /** Wake every segment of a string — a slack nudge that did not go through
   *  the document, or anything else that moved a rope behind the mirror's
   *  back. */
  wake(id: string): void {
    for (const segment of this.byString.get(id) ?? []) this.rouse(segment);
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
   *
   * `slack` comes along because the painter draws a taut segment thinner than a
   * slack one (DESIGN section 4.6) and that is a *per segment* number. It could
   * be read off the scene instead — it is the same value, mirrored — but only
   * by pairing this callback's arrival order with the run's node array, and the
   * two disagree the moment a segment has no particles to draw. Here it is
   * simply the field beside the ones already being handed over.
   *
   * The two **pin ids** come along for the same reason and a stronger one
   * (T-330). A segment that ends at a tape stuck to a page nobody is looking at
   * is drawn on the under canvas rather than the over one, and that is a fact
   * about *this gap* rather than about the string: pinning a thread halfway
   * across the board must not tuck the half that never went near the folder.
   * Counting callbacks against the run's node array is what this method already
   * exists to stop anybody doing, so the names travel with the geometry.
   *
   * Nothing here reads them. `layer` is not the simulation's business and this
   * is still the same walk it was — see `sync`, which wakes nothing for a style
   * edit.
   */
  visit(
    id: string,
    fn: (at: number, count: number, asleep: boolean, slack: number, a: string, b: string) => void,
  ): void {
    for (const segment of this.byString.get(id) ?? []) {
      if (segment.count > 0) {
        fn(segment.at, segment.count, segment.asleep, segment.slack, segment.a, segment.b);
      }
    }
  }

  /**
   * One segment, named by the two pins it runs between.
   *
   * For the advisory lock of DATA-MODEL section 5.4 (T-130): somebody else is
   * mid-split on a gap and their claim has to be drawn along the rope where it
   * actually hangs. [`visit`] cannot answer it — it hands over every segment in
   * run order and skips the ones with no particles, so counting callbacks
   * against the run's node array goes wrong at exactly the moment a segment is
   * undrawable, which is the note above.
   *
   * A walk of the string's own segment list, which is a handful, on the frames
   * somebody is holding one — a gesture, not a session. Calls `fn` once per
   * match rather than stopping at the first: a run that visits the same pair
   * twice has two gaps between them and both are claimed by the same name.
   */
  segment(id: string, a: string, b: string, fn: (at: number, count: number) => void): void {
    for (const segment of this.byString.get(id) ?? []) {
      if (segment.count > 0 && segment.a === a && segment.b === b) fn(segment.at, segment.count);
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
          best = { string: id, node: segment.node, t: (i + u) / links, x: px, y: py, distance };
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
        if (meets(segment, rect)) {
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
      const moved =
        segment.a === pinId
          ? Math.abs(pin.wx - segment.ax) + Math.abs(pin.wy - segment.ay)
          : Math.abs(pin.wx - segment.bx) + Math.abs(pin.wy - segment.by);
      if (moved <= ANCHOR_EPSILON) continue;
      // Before the sleep test, not after it, and that ordering is a bug that
      // was in here. A segment can end a frame awake — the write landed after
      // phase 3, or the cap deferred it — and on the next frame this would skip
      // it entirely as "already awake, it will sort itself out". It does not:
      // the *box* is what the gate judges, only a step refreshes it, and a
      // gated rope never takes one. So the pin moved, the box did not hear
      // about it, the gate re-slept it on the stale box, and the pin was clean
      // by the following frame — stranding the rope where it used to be for the
      // life of the session. Found by driving it, not by the tests.
      this.reach(segment, pin.wx, pin.wy);
      if (segment.asleep) this.rouse(segment);
    }
  }

  private rouse(segment: Segment): void {
    segment.asleep = false;
    segment.still = 0;
  }

  /**
   * Stretch a segment's box to reach a pin that has moved out from under it.
   *
   * The viewport gate's, and it is not optional. A gated rope is judged by its
   * *cached* box — the shape it was last stepped into — and its pins can walk
   * clean off the far side of that. Drag a photograph in from off screen and,
   * without this, its strings keep being tested against a box on the other side
   * of the board, keep failing, and never come back: you arrive at the item
   * with its strings still lying where they used to be.
   *
   * Growing rather than recomputing, because the particles have not moved and a
   * box that no longer contained them would be a lie to `nearest` and to the
   * painter's culling. Conservative in the only direction that is safe — too
   * big costs a rope being considered when it needn't be — and `bound` makes it
   * honest again on the first step it takes.
   *
   * Only the pin route needs it. A slack nudge or a `wake` moves no anchor, so
   * the box it had is still the box it has.
   */
  private reach(segment: Segment, wx: number, wy: number): void {
    if (wx < segment.minX) segment.minX = wx;
    if (wx > segment.maxX) segment.maxX = wx;
    if (wy < segment.minY) segment.minY = wy;
    if (wy > segment.maxY) segment.maxY = wy;
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

/** Whether a segment's box touches `rect` at all. Shared by the viewport gate
 *  and by the painter's culling, so the two can never disagree about what is
 *  near enough to matter. */
function meets(segment: Segment, rect: Bounds): boolean {
  return (
    segment.maxX >= rect.minX &&
    segment.minX <= rect.maxX &&
    segment.maxY >= rect.minY &&
    segment.minY <= rect.maxY
  );
}

/**
 * How much of a segment is on screen, as an area — what `cap` ranks by.
 *
 * Both extents are grown by `ROPE_SPACING` before multiplying, and that is
 * load-bearing rather than a fudge. A rope with no slack between two pins at
 * the same height is a horizontal *line*: its box is zero units tall, so a
 * plain intersection area makes it worth nothing, and every taut string on the
 * board would tie at zero and lose to any sagging one. A link's length is the
 * smallest thickness a rope can meaningfully have, and adding it means a long
 * straight string on screen outranks a short one — which is the right answer,
 * because it is the one you can see more of.
 */
function overlap(segment: Segment, rect: Bounds): number {
  const w = Math.min(segment.maxX, rect.maxX) - Math.max(segment.minX, rect.minX);
  const h = Math.min(segment.maxY, rect.maxY) - Math.max(segment.minY, rect.minY);
  if (w < 0 || h < 0) return 0;
  return (w + ROPE_SPACING) * (h + ROPE_SPACING);
}

/**
 * A run of pins, as one comparable value. The separator is a character no id
 * contains, so two different runs cannot collide into the same signature by
 * concatenation — `["ab", "c"]` and `["a", "bc"]` are famously the same string
 * once you join them with nothing.
 *
 * Written as the escape `\0` and never as the byte itself (T-156). One raw NUL
 * anywhere in a file makes ripgrep and grep classify the *whole file* as binary
 * and skip it, so a search for `pin` across the codebase silently misses every
 * line of this module and reports nothing rather than an error. It cost a
 * detour during T-76 before anybody worked out why the simulation was invisible.
 *
 * The *drawable* run, not the document's. Two runs that differ only in nodes
 * nothing draws produce the same segments over the same pins, and rebuilding
 * for that would throw the particles away mid-swing to arrive at the pose they
 * were already in — it is what lets the janitor collect a dead node without the
 * rope so much as twitching.
 */
function runSignature(pins: readonly string[], closed: boolean): string {
  return `${pins.join("\0")}|${closed ? "c" : "o"}`;
}

/**
 * Which nodes of a run have a pin to hang from, by index.
 *
 * The one place "skipped at render time" (DATA-MODEL section 8.1) is decided,
 * shared by `setString` and `sync` so the segments and the signature that
 * guards them can never disagree about what is drawable.
 */
function resolving(scene: Scene, pins: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pins.length; i++) if (scene.pins.has(pins[i]!)) out.push(i);
  return out;
}

/**
 * How long a rope takes to fall asleep once it stops moving, in milliseconds —
 * for tests and for the dev HUD to label a countdown.
 *
 * A function rather than a constant since T-232, and that is the whole of what
 * that change cost anywhere outside `tuning.ts`. Both of its terms are dials
 * the tuning panel can move, and a product taken once at module load is a
 * number that stops agreeing with its own source the first time somebody turns
 * one of them — the quietest possible way for a panel to lie.
 */
export function ropeSleepMs(): number {
  return ROPE_SLEEP_STEPS * SIM_STEP_MS;
}
