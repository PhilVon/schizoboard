/**
 * Somebody else's drag, made smooth.
 *
 * > Buffer `(pose, remoteTime, localReceiveTime)` samples and render at
 * > `now − 100 ms`, interpolating between the two straddling samples.
 * > Extrapolate at most 80 ms across a gap, then freeze. This turns a 20 Hz
 * > update stream into 60 fps motion.
 * >
 * > **The interpolated pose — not the raw sample — drives the rope anchor.**
 * > — docs/DATA-MODEL.md section 9.3
 *
 * A peer publishes a `grab` at most every other frame and only when it moved
 * (`state/presence.ts`), so what arrives is an irregular trickle of positions.
 * Written straight into the scene, that trickle is what an item's motion *is* —
 * a step every second or third frame, which reads as a stutter, and worse:
 * every pin on that item is a rope anchor, so each step cracks the string it
 * hangs from at the update rate. That is the bug this module exists to prevent,
 * and it is why AC-84 is phrased as a claim about the anchor rather than about
 * the item.
 *
 * ## Where the interpolated pose is written
 *
 * Into `scene.x/y/rot`, exactly where a local drag writes. The scene therefore
 * disagrees with the document for the length of the gesture — which is not new:
 * a local drag does the same thing, and only throttles a `live` write to the
 * document every so often for crash safety (DESIGN section 7.3). The scene
 * leading the document is the normal state of affairs while anything is moving.
 *
 * It also means `sim/ropes.ts` needs no change at all to satisfy AC-84. It
 * reads its anchors through `scene.layoutPin`, in phase 3, from whatever phase 2
 * left in the scene — so writing the interpolated pose here *is* driving the
 * anchor with it. Nothing else has to know.
 *
 * ## Which is why it has to notice the document
 *
 * Overwriting the mirror means the mirror is no longer the answer to "where does
 * the document think this is?", and section 9.2's handoff rule needs that answer:
 *
 * > The same rule applies to drags: hold the awareness pose until the document
 * > position matches within epsilon, or a 250 ms grace period expires.
 *
 * So this remembers what it last wrote. When the scene no longer holds that, the
 * only thing that can have changed it is `crdt/binding.ts` — the document has
 * spoken, and that value is kept as `doc`. On release, the item is held at the
 * awareness pose until `doc` agrees with it or the grace runs out, and then the
 * scene is put back onto `doc`, so the mirror ends the gesture as a mirror
 * again. Without that last write an item would sit at an awareness pose the
 * document never confirmed, forever, and nobody would find out until a reload
 * moved it.
 *
 * ## Two clocks
 *
 * A sample's `t` is the sender's `performance.now()`, whose epoch means nothing
 * here, and `receivedAt` is ours. Neither alone is enough: `t` cannot be
 * compared to our clock, and arrival times have the network's jitter baked into
 * them — a sample held up 40 ms would be replayed as a pause the peer never
 * made. What is wanted is the sender's *spacing* on our timeline, so the
 * timeline is mapped by one number, `skew`, and a sample's local time is always
 * derived (`t + skew`) rather than stored. A skew that moves therefore shifts
 * every buffered sample together, and can never reorder them.
 */

import type { DirtySets } from "@/state/dirty";
import type { PresenceGrab, PresenceGrabPose } from "@/state/presence";
import type { Scene } from "@/state/scene";

/**
 * How far in the past a remote peer is drawn.
 *
 * The buffer this buys is the whole mechanism: interpolation needs a sample on
 * *both* sides of the moment being drawn, and 100 ms is enough to still have one
 * ahead when a peer publishing every 33 ms drops two in a row. Less and the
 * buffer runs dry on ordinary jitter; more and a collaborator's hand visibly
 * lags their cursor.
 */
export const REMOTE_DELAY_MS = 100;

/**
 * How far past the newest sample a pose may be carried before it freezes.
 *
 * > Extrapolate at most 80 ms across a gap, then freeze. — section 9.3
 *
 * Extrapolation is a guess, and past about this long a wrong guess has to be
 * taken back — which is a snap, and a snap is worse than the stall it was
 * covering for. Freezing is at least honest.
 */
const MAX_EXTRAPOLATE_MS = 80;

/**
 * How long a released item is held at its awareness pose while waiting for the
 * document to agree. Section 9.2's number.
 */
const HANDOFF_GRACE_MS = 250;

/**
 * How much history is worth keeping behind the newest sample.
 *
 * Enough to always straddle `REMOTE_DELAY_MS` with room over, and no more: the
 * only reads are the two samples either side of the playhead and the last two
 * for a velocity, so anything older is dead weight in a per-frame loop.
 */
const BUFFER_MS = 600;

/** Never trim below this, however old the samples are. A lerp needs two. */
const MIN_SAMPLES = 2;

/**
 * The widest gap between two samples that a velocity may be measured across.
 *
 * A peer publishes at most every other frame, so 200 ms is six slots — wide
 * enough for a slow drag that only crosses a board unit now and then, and narrow
 * enough that the pair either side of a *pause* is rejected. Without this the
 * velocity across two samples two seconds apart reads as the peer's current
 * speed, and 80 ms of it is invented motion in whatever direction the drag last
 * happened to be going. A stale velocity is worse than no velocity: freezing is
 * at least where the peer actually was.
 */
const MAX_VELOCITY_SPAN_MS = 200;

/**
 * Below this, a write is not worth a frame.
 *
 * Board units. An item is a few hundred across and a pin's world position is
 * derived from its pose, so a sixty-fourth of a unit cannot move anything
 * anybody can see — but it *can* mark the item dirty, and a dirty item wakes
 * every rope hanging off it (`sim/ropes.ts`, `ANCHOR_EPSILON`). The write is
 * skipped entirely rather than made silently, so the scene and the DOM never
 * disagree about a fraction nobody wrote.
 */
const MOVE_EPSILON = 1 / 64;

/** Same idea for the angle: below a thousandth of a radian nothing turns. */
const TURN_EPSILON = 1e-3;

/** "The document matches" — section 9.2's epsilon, in board units and radians. */
const HANDOFF_EPSILON = 0.5;
const HANDOFF_TURN_EPSILON = 5e-3;

/**
 * Below this a frozen pose is not a guess, it is the answer.
 *
 * Board units per second. A peer publishes only when something changed, so an
 * item held still produces no samples at all — the buffer starves, and freezing
 * on the last pose is then *exactly* right rather than a fallback. The frozen
 * test below is what really keeps a pause out of the jitter score; this is the
 * cheaper half of the same argument, and it catches the pause that begins
 * between two samples rather than after them.
 */
const STILL_SPEED = 4;

/**
 * The jitter score, and the two thresholds it crosses.
 *
 * One integer per peer: up on a frame that had to guess, down on a frame that
 * interpolated. Twenty at 60 Hz is a third of a second of guessing, which is
 * past what a hiccup looks like and into what a connection that cannot hold the
 * buffer looks like. Coming back needs the score all the way to zero, so the
 * two thresholds are a hysteresis band and not one line to oscillate across.
 */
const JITTER_TRIP = 20;
const JITTER_MAX = 40;

/**
 * The fallback anchor's rate, per second.
 *
 * > A guaranteed fallback of critically-damped spring anchors, which are
 * > jitter-proof if slightly less responsive. — DESIGN section 11.1, risk 2
 *
 * Critically damped means no overshoot at all, whatever the input does — which
 * is the property being bought: a spring chasing the newest raw sample cannot
 * reproduce that sample's jitter, because it has no way to move faster than
 * this. Eighteen is a 55 ms time constant, so it covers most of a lost frame
 * within one frame and all of it within three. Slower reads as lag; faster and
 * it starts passing the jitter through again.
 */
const SPRING_RATE = 18;

/**
 * How fast the skew estimate is allowed to grow, as a fraction of the error per
 * sample.
 *
 * It shrinks the instant a lower-latency sample proves it should, because a
 * sample that arrived sooner is better evidence and there is nothing to weigh
 * against it. Growing is the other case — the sender's clock stepped, or the
 * route got longer — and there it must be slow, because the alternative is
 * letting one arbitrarily-delayed packet push the whole timeline back and stall
 * every peer behind it. At 30 samples a second this closes about a quarter of
 * the error per second.
 */
const SKEW_RELAX = 0.01;

/**
 * Past this the estimate is not stale, it is wrong.
 *
 * A sender whose clock jumped backwards a minute would otherwise be crawled
 * back to at `SKEW_RELAX`, and be a frozen item for all of it. Two seconds is
 * far outside any latency this is meant to absorb.
 */
const SKEW_RESET_MS = 2000;

/** One buffered sample. `t` is the sender's clock; the local time is derived. */
interface Sample {
  t: number;
  seq: number;
  /** The gesture's last sample. Nothing is extrapolated past it. */
  final: boolean;
  poses: Map<string, PresenceGrabPose>;
}

/** One item this peer is moving, and what has been done about it. */
interface Held {
  /**
   * The last pose written into the scene, rounded the way the scene rounds it.
   *
   * `Math.fround` because the scene's hot fields are `Float32Array`: comparing a
   * double against what came back out of one would report a change every frame
   * and take the document detection below with it.
   */
  mine: PresenceGrabPose | null;
  /** Where the document says the item is, as last seen. */
  doc: PresenceGrabPose;
  /** Spring velocity, in board units and radians per second. */
  vx: number;
  vy: number;
  vr: number;
  /** When the peer let go, on our clock. Null while the gesture is live. */
  freedAt: number | null;
}

interface Peer {
  samples: Sample[];
  /**
   * What the last `sampleAt` was — the three fields of `Sampled` that are not
   * the poses, kept because the debug overlay (T-235) has no other way to ask.
   *
   * Everything else it draws is state this object already holds for its own
   * reasons; these three are computed once a frame and thrown away, and they are
   * the ones that say *why* the two poses on screen differ. Three numbers on an
   * object there is one of per peer, written in `score` where they are already
   * in hand.
   */
  guessed: boolean;
  frozen: boolean;
  speed: number;
  /** The highest sequence number seen. The duplicate and out-of-order filter. */
  seq: number;
  /** `local = t + skew`. Null until the first sample sets it. */
  skew: number | null;
  held: Map<string, Held>;
  jitter: number;
  spring: boolean;
  /** The gesture is over: a `final` arrived, or the grab went away. */
  ended: boolean;
}

/**
 * Every number this module is tuned by, in one place, for the debug overlay's
 * legend (T-235).
 *
 * A live reading of `jitter` or `spring` says nothing on its own — 14 is only
 * meaningful beside the 20 it is climbing towards. One export rather than five,
 * and built from the constants above rather than repeating their values, so a
 * legend cannot drift from what the code actually does.
 */
export const REMOTE_NUMBERS = {
  delayMs: REMOTE_DELAY_MS,
  bufferMs: BUFFER_MS,
  maxExtrapolateMs: MAX_EXTRAPOLATE_MS,
  handoffGraceMs: HANDOFF_GRACE_MS,
  springRate: SPRING_RATE,
  jitterTrip: JITTER_TRIP,
  jitterMax: JITTER_MAX,
  stillSpeed: STILL_SPEED,
} as const;

/**
 * One remotely-held item, as the two poses that exist for it — what arrived,
 * and what was written into the scene. Either can be null: `raw` before the
 * first sample of a gesture that is being handed back, `shown` on the frame an
 * item was picked up and nothing has been written for it yet.
 */
export interface RemoteDebugItem {
  readonly id: string;
  readonly raw: PresenceGrabPose | null;
  readonly shown: PresenceGrabPose | null;
}

/** One peer, for the debug overlay — see `RemoteMotion.debug`. */
export interface RemoteDebug {
  readonly clientId: number;
  readonly items: readonly RemoteDebugItem[];
  readonly jitter: number;
  readonly spring: boolean;
  readonly skew: number | null;
  readonly buffered: number;
  readonly guessed: boolean;
  readonly frozen: boolean;
  readonly speed: number;
}

/** What `sampleAt` found at the playhead. */
interface Sampled {
  poses: Map<string, PresenceGrabPose>;
  /** The playhead is past the newest sample, so this pose is a guess. */
  guessed: boolean;
  /**
   * And past the cap, so it is no longer even a guess — it is the last known
   * pose, held.
   *
   * The jitter score distinguishes the two, and it has to. Jitter is a run of
   * short gaps: extrapolate, arrive, extrapolate, arrive. A peer who picked
   * something up and paused to think produces one gap that never ends, and
   * scoring that as jitter would put every thoughtful collaborator on the
   * fallback within a third of a second.
   */
  frozen: boolean;
  /** Fastest item in the set, board units per second. Only set when guessing. */
  speed: number;
}

/**
 * The one thing worth reading off a remote awareness state, validated.
 *
 * Everything here arrived as JSON from another machine, and the fields are
 * written straight into the scene, so this is the boundary: a malformed grab is
 * dropped whole rather than partially trusted. A `NaN` that got through would
 * put an item at an unreachable coordinate and take every rope on it along.
 */
export function readGrab(state: unknown): PresenceGrab | null {
  if (typeof state !== "object" || state === null) return null;
  const grab = (state as { grab?: unknown }).grab;
  if (typeof grab !== "object" || grab === null) return null;
  const g = grab as Record<string, unknown>;
  if (g.kind !== "items") return null;
  if (g.phase !== "live" && g.phase !== "final") return null;
  if (typeof g.seq !== "number" || !Number.isFinite(g.seq)) return null;
  if (typeof g.t !== "number" || !Number.isFinite(g.t)) return null;
  if (!Array.isArray(g.ids) || !Array.isArray(g.poses)) return null;
  // The parallel arrays are an invariant of the sender, which is exactly why the
  // receiver checks it rather than assuming it.
  if (g.ids.length !== g.poses.length) return null;

  const ids: string[] = [];
  const poses: PresenceGrabPose[] = [];
  for (let i = 0; i < g.ids.length; i += 1) {
    const id = g.ids[i];
    const pose = g.poses[i] as Record<string, unknown> | null | undefined;
    if (typeof id !== "string" || id.length === 0) return null;
    if (typeof pose !== "object" || pose === null) return null;
    const { x, y, rot } = pose;
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    if (typeof y !== "number" || !Number.isFinite(y)) return null;
    if (typeof rot !== "number" || !Number.isFinite(rot)) return null;
    ids.push(id);
    poses.push({ x, y, rot });
  }
  return { kind: "items", ids, poses, seq: g.seq, t: g.t, phase: g.phase };
}

/**
 * One step of a critically-damped spring, analytically.
 *
 * `x(t) = target + (A + Bt)e^(-wt)` with `A = x - target` and `B = v + wA` is
 * the exact solution at `zeta = 1`, so this is stable at any timestep — which a
 * semi-implicit integrator at a stiff rate is not, and a dropped frame is
 * exactly when a fallback for a bad connection must not explode.
 *
 * Critical damping is the absence of *oscillation*, not of overshoot: enough
 * velocity going in and it passes the target once, on the way to settling. What
 * it cannot do is come back a second time.
 *
 * Exported because that is a claim worth testing on its own, rather than through
 * a jitter score and a sample buffer.
 */
export function criticallyDamped(
  x: number,
  v: number,
  target: number,
  dtSec: number,
  rate: number = SPRING_RATE,
): { x: number; v: number } {
  const a = x - target;
  const b = v + rate * a;
  const decayed = a + b * dtSec;
  const e = Math.exp(-rate * dtSec);
  return { x: target + decayed * e, v: (b - rate * decayed) * e };
}

/**
 * Every peer's in-flight drag, applied in phase 2 of the frame.
 *
 * Keyed by Yjs client id, which is what awareness keys states by. Nothing here
 * imports Yjs: `observe` takes a plain state object and the time it arrived,
 * because the arrival time is half the input and only the caller knows it.
 */
export class RemoteMotion {
  private readonly peers = new Map<number, Peer>();
  private self: number | null = null;

  /**
   * This client's own id, to be dropped on arrival.
   *
   * Our own state is in `getStates()` like everybody else's, and interpolating
   * our own drag would put a pose from 100 ms ago on top of the gesture that is
   * making it — the item would trail the cursor by exactly the buffer. Told to
   * this object rather than filtered by the caller because "whose samples are
   * these" is a question about the receive path.
   */
  ignore(clientId: number): void {
    this.self = clientId;
    this.peers.delete(clientId);
  }

  /**
   * A peer's awareness state arrived. `receivedAt` is on the same clock as the
   * `now` handed to `apply` — `performance.now()`, which is the frame's clock.
   */
  observe(clientId: number, state: unknown, receivedAt: number): void {
    if (clientId === this.self) return;
    const grab = readGrab(state);
    const peer = this.peers.get(clientId);

    if (grab === null) {
      // No grab, or one that would not validate. Either way there is nothing
      // more coming for whatever this peer was holding, so the handoff starts —
      // the same path a `final` takes, because a peer that vanished mid-drag
      // must not leave an item stranded at a pose it invented.
      if (peer !== undefined) this.end(peer, receivedAt);
      return;
    }

    const fresh: Peer = peer ?? {
      samples: [],
      seq: -1,
      skew: null,
      held: new Map(),
      jitter: 0,
      spring: false,
      ended: false,
      guessed: false,
      frozen: false,
      speed: 0,
    };
    if (peer === undefined) this.peers.set(clientId, fresh);

    // Awareness is last-write-wins and clock-ordered per client, so in practice
    // this is a duplicate filter: the same state is re-delivered on a resync, or
    // on the query a joining peer answers. A reload does not need handling here —
    // a fresh `Y.Doc` draws a fresh client id, so it arrives as a different peer.
    if (grab.seq <= fresh.seq) return;
    fresh.seq = grab.seq;

    const measured = receivedAt - grab.t;
    if (fresh.skew === null || measured < fresh.skew || measured - fresh.skew > SKEW_RESET_MS) {
      fresh.skew = measured;
    } else {
      fresh.skew += (measured - fresh.skew) * SKEW_RELAX;
    }

    const poses = new Map<string, PresenceGrabPose>();
    for (let i = 0; i < grab.ids.length; i += 1) poses.set(grab.ids[i]!, grab.poses[i]!);
    fresh.samples.push({ t: grab.t, seq: grab.seq, final: grab.phase === "final", poses });
    fresh.ended = grab.phase === "final";
    this.trim(fresh);
    if (grab.phase === "final") {
      for (const held of fresh.held.values()) held.freedAt ??= receivedAt;
    }
  }

  /** A peer disconnected. Awareness drops its state, so nothing else will say so. */
  forget(clientId: number): void {
    this.peers.delete(clientId);
  }

  /** Whether a peer is on the spring fallback rather than interpolating. AC-85. */
  fallback(clientId: number): boolean {
    return this.peers.get(clientId)?.spring ?? false;
  }

  /** The items any peer is currently moving. For the overlay, and for tests. */
  heldBy(clientId: number): ReadonlySet<string> {
    return new Set(this.peers.get(clientId)?.held.keys() ?? []);
  }

  /**
   * Both poses for every remotely-held item, and the peer state that explains
   * the gap between them — the readout the debug overlay draws (T-235).
   *
   * > The interpolated pose drives the anchor, never the raw sample; **a debug
   * > overlay drawing both**; and a guaranteed fallback of critically-damped
   * > spring anchors. — DESIGN section 11.1, risk 2
   *
   * The third of that sentence's three mitigations, and the only one that was
   * not already built: the first is AC-84 and the second AC-85. It is the one
   * that makes the other two checkable, because "the anchor followed the
   * interpolated pose" and "the spring absorbed the jitter" are both claims
   * about the *difference* between two numbers, and until now only one of them
   * was anywhere a person could see.
   *
   * A method that walks and allocates rather than fields the painter reads,
   * because it is asked once a frame by a thing that only exists in a dev build
   * and never at all otherwise — and because `samples` and `held` are private
   * for good reason. Nothing here is stored for this; it is what the object
   * already holds, arranged.
   *
   * `raw` is what the peer actually sent, which the sender rounds to whole board
   * units and 1e-4 radians (`state/presence.ts`) — that rounding *is* the jitter
   * the overlay exists to show, and it is why the two poses differ visibly even
   * on an item nobody is moving.
   */
  debug(): RemoteDebug[] {
    const out: RemoteDebug[] = [];
    for (const [clientId, peer] of this.peers) {
      const newest = peer.samples[peer.samples.length - 1] ?? null;
      const items: RemoteDebugItem[] = [];
      for (const [id, held] of peer.held) {
        items.push({ id, raw: newest?.poses.get(id) ?? null, shown: held.mine });
      }
      out.push({
        clientId,
        items,
        jitter: peer.jitter,
        spring: peer.spring,
        skew: peer.skew,
        buffered: peer.samples.length,
        guessed: peer.guessed,
        frozen: peer.frozen,
        speed: peer.speed,
      });
    }
    return out;
  }

  /**
   * Phase 2. Put every remotely-held item where its peer had it 100 ms ago.
   *
   * Before phase 3 and therefore before `sim/ropes.ts` reads its anchors, which
   * is the whole of AC-84 (see the header). `dtMs` is the frame's, for the
   * spring; `now` is the frame's timestamp, for the playhead.
   */
  apply(now: number, dtMs: number, scene: Scene, dirty: DirtySets): void {
    // Every peer is read before any peer is written, so that one peer's write can
    // never be mistaken for the document by the next peer's check.
    for (const peer of this.peers.values()) this.readDocument(peer, scene, dirty);
    for (const peer of this.peers.values()) this.applyPeer(peer, now, dtMs, scene, dirty);
  }

  /**
   * What the document has said about a held item since the last frame.
   *
   * The mirror is being written over, so the question "where does the document
   * think this is?" has no answer left in the scene — and section 9.2's handoff
   * needs one. The dirty set is the answer. `crdt/binding.ts` marks every item it
   * moves (it must: phase 5 writes only dirty items, so an unmarked write would
   * not reach the DOM either), the frame clears the set in phase 9, and this runs
   * in phase 2 — so an item in the set now was moved by something that is not the
   * write below, which for a remotely-held item means the document.
   *
   * A value comparison is *also* done, and is not sufficient on its own: the
   * awareness pose is rounded to whole board units and the document's is not, so
   * the two usually differ — but not always, and where they coincide the
   * comparison sees a document that never spoke, waits out the whole grace
   * period, and then snaps the item back to where the drag started.
   */
  private readDocument(peer: Peer, scene: Scene, dirty: DirtySets): void {
    for (const [id, held] of peer.held) {
      const mine = held.mine;
      const pose = scene.poseOf(id);
      if (pose === null) continue;
      const moved =
        mine === null ||
        dirty.all ||
        dirty.items.has(id) ||
        pose.x !== mine.x ||
        pose.y !== mine.y ||
        pose.rot !== mine.rot;
      // All three fields, not only the one that differs: a document write moves
      // an item's position and angle together, and taking one field from the
      // document would pair it with two interpolated ones.
      if (moved) held.doc = { x: pose.x, y: pose.y, rot: pose.rot };
    }
  }

  private applyPeer(peer: Peer, now: number, dtMs: number, scene: Scene, dirty: DirtySets): void {
    if (peer.samples.length > 0) {
      const sampled = this.sampleAt(peer, now - REMOTE_DELAY_MS);
      this.score(peer, sampled);

      const newest = peer.samples[peer.samples.length - 1]!;
      const dtSec = Math.max(0, dtMs) / 1000;

      for (const [id, pose] of sampled.poses) {
        const held = this.hold(peer, id, scene, now);
        if (held === null) continue;
        const want = peer.spring ? this.springTo(held, newest.poses.get(id) ?? pose, dtSec) : pose;
        this.write(scene, dirty, id, held, want, false);
      }
    }

    // Anything released: hold it, then hand it over. Done after the writes above
    // so that a `final` sample is applied on the same frame it is handed off on,
    // rather than a frame later.
    for (const [id, held] of peer.held) {
      if (held.freedAt === null) continue;
      const mine = held.mine;
      const agreed =
        mine === null ||
        (Math.abs(held.doc.x - mine.x) <= HANDOFF_EPSILON &&
          Math.abs(held.doc.y - mine.y) <= HANDOFF_EPSILON &&
          Math.abs(held.doc.rot - mine.rot) <= HANDOFF_TURN_EPSILON);
      if (!agreed && now - held.freedAt < HANDOFF_GRACE_MS) continue;
      // The document is the truth and the mirror goes back to mirroring it,
      // whether it caught up or the grace expired. Within epsilon nothing moves
      // visibly; past the grace something does, and it should — an awareness
      // pose the document never confirmed is not where the item is.
      //
      // Forced, because this is the write that ends the divergence: skipping it
      // for being a sixty-fourth of a unit would leave the scene holding an
      // interpolated coordinate as the item's stored position for as long as the
      // board is open.
      this.write(scene, dirty, id, held, held.doc, true);
      peer.held.delete(id);
    }

    if (peer.ended && peer.held.size === 0) {
      // The gesture is finished and handed over. The samples go, and the skew
      // estimate stays: it took a second of traffic to converge and the next
      // gesture from this peer would otherwise start by guessing again.
      peer.samples.length = 0;
      peer.jitter = 0;
      peer.spring = false;
    }
  }

  /** Start driving an item, or keep driving one. Null if the scene has no such item. */
  private hold(peer: Peer, id: string, scene: Scene, now: number): Held | null {
    const existing = peer.held.get(id);
    if (existing !== undefined) return existing;
    const pose = scene.poseOf(id);
    // An item this client has not seen yet — a photograph created and dragged in
    // one gesture, whose document update has not arrived. There is nothing to
    // move; the next frame will find it.
    if (pose === null) return null;
    const held: Held = {
      mine: null,
      doc: { x: pose.x, y: pose.y, rot: pose.rot },
      vx: 0,
      vy: 0,
      vr: 0,
      // First seen already released: a peer whose only surviving message is the
      // `final` one, or a late joiner reading a grab left in awareness by a
      // gesture that ended. It hands off on this same frame.
      freedAt: peer.ended ? now : null,
    };
    peer.held.set(id, held);
    return held;
  }

  /** Chase the newest raw sample, jitter-proof. AC-85. */
  private springTo(held: Held, target: PresenceGrabPose, dtSec: number): PresenceGrabPose {
    const from = held.mine ?? held.doc;
    const x = criticallyDamped(from.x, held.vx, target.x, dtSec);
    const y = criticallyDamped(from.y, held.vy, target.y, dtSec);
    const rot = criticallyDamped(from.rot, held.vr, target.rot, dtSec);
    held.vx = x.v;
    held.vy = y.v;
    held.vr = rot.v;
    return { x: x.x, y: y.x, rot: rot.x };
  }

  private write(
    scene: Scene,
    dirty: DirtySets,
    id: string,
    held: Held,
    want: PresenceGrabPose,
    force: boolean,
  ): void {
    const mine = held.mine;
    if (
      !force &&
      mine !== null &&
      Math.abs(want.x - mine.x) < MOVE_EPSILON &&
      Math.abs(want.y - mine.y) < MOVE_EPSILON &&
      Math.abs(want.rot - mine.rot) < TURN_EPSILON
    ) {
      return;
    }
    if (!scene.setPose(id, { x: want.x, y: want.y, rot: want.rot })) return;
    dirty.item(id);
    held.mine = { x: Math.fround(want.x), y: Math.fround(want.y), rot: Math.fround(want.rot) };
  }

  private score(peer: Peer, sampled: Sampled): void {
    peer.guessed = sampled.guessed;
    peer.frozen = sampled.frozen;
    peer.speed = sampled.speed;
    const guessing = sampled.guessed && !sampled.frozen && sampled.speed > STILL_SPEED;
    peer.jitter = guessing
      ? Math.min(JITTER_MAX, peer.jitter + 1)
      : Math.max(0, peer.jitter - 1);
    if (!peer.spring && peer.jitter >= JITTER_TRIP) peer.spring = true;
    else if (peer.spring && peer.jitter === 0) peer.spring = false;
  }

  /**
   * The pose set at a moment on our clock, from the two samples either side.
   *
   * Three cases, and the one in the middle is the one that matters:
   * behind the buffer (a peer just joined, or a gesture just started) the oldest
   * sample is all there is; straddled, the answer is a lerp; ahead of the newest
   * it is a capped guess, and then a freeze.
   */
  private sampleAt(peer: Peer, target: number): Sampled {
    const samples = peer.samples;
    const skew = peer.skew ?? 0;
    const oldest = samples[0]!;
    const newest = samples[samples.length - 1]!;

    if (target <= oldest.t + skew) {
      // Not a guess: there is simply nothing older to blend with, and the oldest
      // pose is a position the peer really was in.
      return { poses: oldest.poses, guessed: false, frozen: false, speed: 0 };
    }

    if (target >= newest.t + skew) {
      const gap = target - (newest.t + skew);
      const frozen = gap >= MAX_EXTRAPOLATE_MS;
      // Nothing is extrapolated past a `final`. The gesture is over, the pose is
      // the one the document is about to confirm, and guessing further would
      // only have to be taken back — the handoff is waiting on this value.
      if (newest.final || samples.length < 2) {
        return { poses: newest.poses, guessed: false, frozen: true, speed: 0 };
      }
      const prev = samples[samples.length - 2]!;
      const span = newest.t - prev.t;
      if (span <= 0 || span > MAX_VELOCITY_SPAN_MS) {
        return { poses: newest.poses, guessed: false, frozen: true, speed: 0 };
      }
      const ahead = Math.min(gap, MAX_EXTRAPOLATE_MS);
      const poses = new Map<string, PresenceGrabPose>();
      let fastest = 0;
      for (const [id, pose] of newest.poses) {
        const was = prev.poses.get(id);
        if (was === undefined) {
          poses.set(id, pose);
          continue;
        }
        const vx = (pose.x - was.x) / span;
        const vy = (pose.y - was.y) / span;
        const vr = (pose.rot - was.rot) / span;
        fastest = Math.max(fastest, Math.hypot(vx, vy) * 1000);
        poses.set(id, {
          x: pose.x + vx * ahead,
          y: pose.y + vy * ahead,
          rot: pose.rot + vr * ahead,
        });
      }
      return { poses, guessed: true, frozen, speed: fastest };
    }

    let i = samples.length - 2;
    while (i > 0 && samples[i]!.t + skew > target) i -= 1;
    const a = samples[i]!;
    const b = samples[i + 1]!;
    const span = b.t - a.t;
    const u = span <= 0 ? 1 : (target - (a.t + skew)) / span;
    const poses = new Map<string, PresenceGrabPose>();
    for (const [id, pose] of b.poses) {
      const was = a.poses.get(id);
      // Absent from the older sample: the peer added it to the gesture between
      // the two, so there is no segment to blend along and its own pose is right.
      if (was === undefined) {
        poses.set(id, pose);
        continue;
      }
      poses.set(id, {
        x: was.x + (pose.x - was.x) * u,
        y: was.y + (pose.y - was.y) * u,
        // Linear, not shortest-arc. Both samples come from one continuous
        // gesture on the sender and carry the scene's unbounded `rot`, so there
        // is no wrap to take the short way round — and an item turned three full
        // times has a `rot` past 6pi that a normalising blend would quietly lose.
        rot: was.rot + (pose.rot - was.rot) * u,
      });
    }
    return { poses, guessed: false, frozen: false, speed: 0 };
  }

  /** The handoff begins: a `final` arrived, or the grab went away. */
  private end(peer: Peer, at: number): void {
    if (peer.samples.length > 0) peer.samples[peer.samples.length - 1]!.final = true;
    peer.ended = true;
    for (const held of peer.held.values()) held.freedAt ??= at;
  }

  private trim(peer: Peer): void {
    const samples = peer.samples;
    const cutoff = samples[samples.length - 1]!.t - BUFFER_MS;
    let drop = 0;
    while (samples.length - drop > MIN_SAMPLES && samples[drop]!.t < cutoff) drop += 1;
    if (drop > 0) samples.splice(0, drop);
  }
}
