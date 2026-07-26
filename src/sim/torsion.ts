/**
 * The item swing — phase 3, and the thing that makes pin count feel like
 * something.
 *
 * > An item with **exactly one pin** hangs from it. Its rendered rotation is
 * > `authoredRotation + θ`, where `θ` is a torsion spring: it accelerates
 * > toward the hanging equilibrium given the offset between the pin and the
 * > item's centre of mass, damps, and decays to rest. Drop the item and it
 * > swings, twice or three times, and settles.
 * >
 * > An item with **two or more pins** is rigid — no `θ`, no swing.
 * > An item with **zero pins** lies flat and doesn't move.
 * >
 * > `θ` is never stored and never synced. It is a local visual offset,
 * > recomputed from scratch, and the equilibrium rotation is a pure function of
 * > pin geometry — so no client ever needs to write it down.
 * > — DESIGN section 5.5
 *
 * That last paragraph is AC-60 and it is also why this module exists at all
 * rather than a `swing` field in the schema. It reads `state/scene.ts` and
 * writes exactly one thing: `scene.swing`, the transient array the renderer
 * already adds to `rot` (ARCHITECTURE rule 2 — `sim/` never touches the
 * document, and the lint rules say so).
 *
 * ## Hanging plumb
 *
 * "The equilibrium rotation is a pure function of pin geometry" is meant
 * literally: the item turns until its centre of mass is directly below its pin,
 * and the authored rotation has no say in where it comes to rest. So a pin at
 * an item's top centre hangs it perfectly straight, and the way to tilt a
 * hanging photograph is to move its pin off centre — which is how it works on a
 * wall. Q-9 confirmed that reading over the alternative, where a pin has enough
 * friction to hold whatever angle you left it at.
 *
 * One consequence is worth stating because it is not obvious: **`rot` is
 * invisible on a single-pinned item.** Rendered rotation is `rot + θ`, and at
 * rest `θ` is `equilibrium - rot`, so the two cancel exactly. Turning such an
 * item with the rotation handle turns it while you hold it and then lets it
 * swing back — which is what a photograph on one pin does, and which is a real
 * change to what T-92's handle means.
 *
 * ## It turns about the pin, not about its own centre
 *
 * A pin is stuck in the cork. It does not move, and an item hanging from one
 * turns about *it*. But a parented pin's world position is derived from the
 * item's pose, so a rotation about the item's centre drags the pin across the
 * board — which is visible on the first swing, and which during a pin drag is a
 * feedback loop: move the pin, the equilibrium changes, the item swings, the
 * item carries the pin out from under the cursor.
 *
 * So the swing is a rotation about the pin, written as the rotation about the
 * centre that `rot + θ` already is, plus the translation that puts the pivot
 * back — `scene.driftX/driftY`. Both halves are transient, and the pin's world
 * position is then unchanged by θ by construction rather than by luck.
 *
 * ## Everything sleeps
 *
 * > A board at rest costs nothing. Simulation is a transient response to
 * > disturbance, not a continuous background process. — DESIGN section 5.1
 *
 * So this holds state only for the items actually moving, wakes on a
 * disturbance, and drops them again once they are within a fraction of a degree
 * of equilibrium. A board of five hundred hanging photographs steps nothing.
 */

import type { DirtySets } from "@/state/dirty";
import type { Scene } from "@/state/scene";
import {
  GRAVITY,
  SIM_MAX_SUBSTEPS,
  SIM_STEP_MS,
  SWING_DAMPING,
  SWING_MAX_RATE,
  SWING_SLEEP_ANGLE,
  SWING_SLEEP_RATE,
  SWING_SLEEP_STEPS,
} from "@/sim/tuning";

const TWO_PI = Math.PI * 2;

/** Into (-pi, pi], so an item always turns the short way to plumb. */
function shortest(angle: number): number {
  const wrapped = ((angle + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  return wrapped;
}

/**
 * The swing offset at which the item hangs plumb, given where its pin is in
 * the item's local un-rotated frame.
 *
 * The pivot is the pin and the weight is at the item's centre, so the vector
 * from one to the other is `(-lx, -ly)`. At rest that vector points straight
 * down, which in a y-down board space is `+y`, or an angle of `pi/2`. The
 * rendered rotation that achieves it is therefore `pi/2 - atan2(-ly, -lx)`, and
 * what this returns is the offset from `rot` that gets there.
 *
 * A pin at the exact centre has no direction to hang in and no restoring torque
 * either — `naturalRate` returns zero for it, so the number here is never used.
 */
export function equilibriumSwing(lx: number, ly: number, rot: number): number {
  return shortest(Math.PI / 2 - Math.atan2(-ly, -lx) - rot);
}

/**
 * The natural angular frequency of the swing, radians per second — a compound
 * pendulum pivoted at the pin.
 *
 * `omega = sqrt(g d / (I/m))` with `I/m = (w^2 + h^2)/12 + d^2`, where `d` is
 * the distance from the pin to the centre. This is what DESIGN means by "given
 * the offset between the pin and the item's centre of mass": a pin near the
 * centre is a long, lazy pendulum with almost no restoring torque, and a pin at
 * a corner is a short brisk one. At `d` of exactly zero it returns zero, which
 * is the physical answer — an item pinned through its own centre of mass has no
 * preferred way up and stays where it is put.
 */
export function naturalRate(lx: number, ly: number, w: number, h: number): number {
  const d = Math.hypot(lx, ly);
  if (d === 0) return 0;
  const inertia = (w * w + h * h) / 12 + d * d;
  return Math.min(SWING_MAX_RATE, Math.sqrt((GRAVITY * d) / inertia));
}

interface Rest {
  eq: number;
  omega: number;
  /** The pivot, in the item's local frame — needed to write the drift. */
  lx: number;
  ly: number;
}

interface Swinging extends Rest {
  theta: number;
  rate: number;
  /** Consecutive substeps spent within the sleep thresholds. */
  still: number;
}

export class Torsion {
  private readonly swinging = new Map<string, Swinging>();
  /**
   * Items a gesture is holding, and the swing each had when it took hold.
   *
   * A held item is the hand's, not gravity's: its swing is frozen at whatever
   * it was and the tool's carry lag is added on top. That is what lets the
   * rotation handle turn a hanging photograph at all — `rot` changes under a
   * frozen `θ`, so the item follows the cursor and then swings back when it is
   * let go, which is what a photograph on one pin does.
   */
  private readonly frozen = new Map<string, { theta: number; lx: number; ly: number }>();
  /** What `held` contained last step, so that letting go can be noticed at all
   *  — see the release loop in `applyHeld`. */
  private readonly wasHeld = new Set<string>();
  private accumulator = 0;

  /** How many items are mid-swing. The dev HUD's cheapest assertion that this
   *  module is asleep when it should be. */
  get awake(): number {
    return this.swinging.size;
  }

  /**
   * SIM phase (3).
   *
   * `held` is the set of items a gesture has hold of and `lag` the carry
   * rotation it has built up — both from `state/tools/select.ts`, which stops
   * writing `swing` itself for anything this module owns.
   */
  step(
    scene: Scene,
    dirty: DirtySets,
    dtMs: number,
    held: ReadonlySet<string> = EMPTY,
    lag = 0,
  ): void {
    this.applyHeld(scene, dirty, held, lag);

    if (dirty.all) {
      // A load or an undo is a state restore, not an event. Everything is put
      // at its equilibrium with no motion — the same reasoning DESIGN section
      // 5.3 gives for seeding ropes analytically: "a board opens perfectly
      // still", and simulating into place looks like a bug on every open.
      for (const id of scene.itemIds()) this.settle(scene, dirty, id, held);
    } else {
      for (const id of dirty.items) this.consider(scene, dirty, id, held);
    }

    this.integrate(scene, dirty, dtMs);
  }

  /** Everything stops and nothing is left mid-swing. For teardown and for a
   *  document being swapped out from under the scene. */
  reset(): void {
    this.swinging.clear();
    this.frozen.clear();
    this.wasHeld.clear();
    this.accumulator = 0;
  }

  private applyHeld(
    scene: Scene,
    dirty: DirtySets,
    held: ReadonlySet<string>,
    lag: number,
  ): void {
    // Let go of anything the gesture has. Waking it is `consider`'s job on the
    // same frame, from the swing this leaves behind — which is exactly the
    // angle the hand was holding it at, so the swing starts where the drag
    // ended rather than from nowhere.
    for (const id of this.frozen.keys()) {
      if (!held.has(id)) this.frozen.delete(id);
    }

    /**
     * Being let go of is an event, and this is the line that makes it one.
     *
     * `consider` runs over `dirty.items` and skips whatever is held, which
     * leaves a gap wide enough to lose an item in: something that changed
     * *while* it was held spent its dirty flag on a frame this module was
     * contractually ignoring, and a dirty set does not survive the frame it was
     * raised in. Nothing raises it again, so nothing ever tells the item its
     * physics changed, and it goes on being drawn with a swing it is no longer
     * entitled to until an unrelated disturbance finds it.
     *
     * `state/tools/pindrag.ts` is where that happens for real, and it cannot be
     * fixed from there: it names the item to dirty by reading the pin's parent,
     * and once the pin has been dragged off there is no parent left to name.
     * Nor is it that tool's alone — any gesture that changes an item's pin count
     * while holding it lands in the same gap. So the catch-up belongs here, in
     * the module that chose to stop listening, rather than in each tool that
     * has to remember it did.
     *
     * Cheap and idempotent: at most one call per item per release, and an item
     * whose physics did not change is left exactly where the hand put it.
     */
    for (const id of this.wasHeld) {
      if (!held.has(id)) this.consider(scene, dirty, id, held);
    }
    this.wasHeld.clear();
    for (const id of held) this.wasHeld.add(id);

    for (const id of held) {
      const slot = scene.slotOf(id);
      if (slot === undefined) continue;
      if (scene.pinCount(id) !== 1) {
        // Rigid or loose: the tool owns the carry rotation for these, as it did
        // before this module existed.
        this.frozen.delete(id);
        continue;
      }
      let base = this.frozen.get(id);
      if (base === undefined) {
        const rest = this.restOf(scene, slot, id);
        if (!rest) continue;
        base = { theta: scene.swing[slot]!, lx: rest.lx, ly: rest.ly };
        this.frozen.set(id, base);
        this.swinging.delete(id);
      }
      /**
       * The **pivot** is frozen as well as the angle, and that is what makes a
       * pin draggable at all: the gesture moves the pin, and re-deriving the
       * pivot from it would move the item under the cursor by the same amount
       * the pin had just travelled. Frozen, the item does not budge and the pin
       * goes exactly where it is put.
       *
       * The drift is still recomputed each frame, because `rot` can change
       * under a frozen angle — that is the rotation handle turning a hanging
       * item, and the drift is what keeps the pin still while it does.
       */
      this.write(scene, dirty, id, slot, base.theta + lag, base);
    }
  }

  /** One item that changed this frame: wake it, silence it, or leave it be. */
  private consider(
    scene: Scene,
    dirty: DirtySets,
    id: string,
    held: ReadonlySet<string>,
  ): void {
    if (held.has(id)) return;
    const slot = scene.slotOf(id);
    if (slot === undefined) {
      this.swinging.delete(id);
      return;
    }
    if (scene.pinCount(id) !== 1) {
      this.swinging.delete(id);
      this.rigid(scene, dirty, id, slot);
      return;
    }
    if (this.swinging.has(id)) return;

    const rest = this.restOf(scene, slot, id);
    if (!rest) return;
    // Already hanging. This is the guard that keeps a board free while a
    // collaborator drags a photograph across it: moving an item does not change
    // where it hangs, so a remote pose arriving every frame wakes nothing.
    if (Math.abs(scene.swing[slot]! - rest.eq) <= SWING_SLEEP_ANGLE) return;

    this.swinging.set(id, { ...rest, theta: scene.swing[slot]!, rate: 0, still: 0 });
  }

  /** Put an item exactly where it belongs, with no motion. */
  private settle(
    scene: Scene,
    dirty: DirtySets,
    id: string,
    held: ReadonlySet<string>,
  ): void {
    if (held.has(id)) return;
    const slot = scene.slotOf(id);
    if (slot === undefined) return;
    this.swinging.delete(id);
    const rest = scene.pinCount(id) === 1 ? this.restOf(scene, slot, id) : null;
    if (rest) this.write(scene, dirty, id, slot, rest.eq, rest);
    else this.rigid(scene, dirty, id, slot);
  }

  /**
   * Where a single-pinned item hangs, how fast it swings getting there, and
   * where the pivot is.
   *
   * A pin at the exact centre of mass has no restoring torque and no preferred
   * way up, so its equilibrium is wherever the item already is — which makes
   * every "is it hanging yet?" comparison true and it never wakes.
   */
  private restOf(scene: Scene, slot: number, id: string): Rest | null {
    // The same question the rotation gesture asks, from the same place —
    // "which one pin holds this?" — so the two cannot end up disagreeing about
    // what an item is hanging from.
    const pin = scene.solePin(id);
    if (!pin) return null;
    const omega = naturalRate(pin.lx, pin.ly, scene.w[slot]!, scene.h[slot]!);
    const eq =
      omega === 0 ? scene.swing[slot]! : equilibriumSwing(pin.lx, pin.ly, scene.rot[slot]!);
    return { eq, omega, lx: pin.lx, ly: pin.ly };
  }

  /**
   * The rendered pose of a hanging item: the angle, and the translation that
   * keeps its pin still while it turns.
   *
   * `drift = rotate(pivot, rot) - rotate(pivot, rot + theta)`, which is exactly
   * "put the pivot back where it was". Falls out to zero when `theta` is zero
   * or the pin is at the centre, so nothing has to special-case either.
   */
  private write(
    scene: Scene,
    dirty: DirtySets,
    id: string,
    slot: number,
    theta: number,
    pivot: { lx: number; ly: number },
  ): void {
    const rot = scene.rot[slot]!;
    const c0 = Math.cos(rot);
    const s0 = Math.sin(rot);
    const c1 = Math.cos(rot + theta);
    const s1 = Math.sin(rot + theta);
    const dx = pivot.lx * (c0 - c1) - pivot.ly * (s0 - s1);
    const dy = pivot.lx * (s0 - s1) + pivot.ly * (c0 - c1);
    if (
      scene.swing[slot] === theta &&
      scene.driftX[slot] === dx &&
      scene.driftY[slot] === dy
    ) {
      return;
    }
    scene.swing[slot] = theta;
    scene.driftX[slot] = dx;
    scene.driftY[slot] = dy;
    dirty.item(id);
  }

  /** Two pins or none: no angle, no translation, exactly where it is stored. */
  private rigid(scene: Scene, dirty: DirtySets, id: string, slot: number): void {
    if (scene.swing[slot] === 0 && scene.driftX[slot] === 0 && scene.driftY[slot] === 0) {
      return;
    }
    scene.swing[slot] = 0;
    scene.driftX[slot] = 0;
    scene.driftY[slot] = 0;
    dirty.item(id);
  }

  private integrate(scene: Scene, dirty: DirtySets, dtMs: number): void {
    if (this.swinging.size === 0) {
      this.accumulator = 0;
      return;
    }

    // Refresh what the substeps will aim at. Pin geometry cannot change between
    // substeps of one frame, so this is once per frame rather than once per
    // step — and it is where a pin dragged across a photograph mid-swing takes
    // effect, which is the item re-hanging under your cursor.
    for (const [id, s] of this.swinging) {
      const slot = scene.slotOf(id);
      if (slot === undefined) {
        this.swinging.delete(id);
        continue;
      }
      const rest = this.restOf(scene, slot, id);
      if (!rest) {
        this.swinging.delete(id);
        continue;
      }
      s.eq = rest.eq;
      s.omega = rest.omega;
      s.lx = rest.lx;
      s.ly = rest.ly;
    }

    this.accumulator = Math.min(
      this.accumulator + dtMs,
      SIM_STEP_MS * SIM_MAX_SUBSTEPS,
    );
    const h = SIM_STEP_MS / 1000;
    while (this.accumulator >= SIM_STEP_MS) {
      this.accumulator -= SIM_STEP_MS;
      for (const s of this.swinging.values()) {
        // Semi-implicit Euler on a damped torsion spring. At 120 Hz and the
        // capped natural frequency this is `omega * h` of 0.12 at the very
        // worst, which is comfortably inside where it stays stable.
        const accel =
          -s.omega * s.omega * (s.theta - s.eq) - 2 * SWING_DAMPING * s.omega * s.rate;
        s.rate += accel * h;
        s.theta += s.rate * h;
        const settled =
          Math.abs(s.theta - s.eq) < SWING_SLEEP_ANGLE &&
          Math.abs(s.rate) < SWING_SLEEP_RATE;
        s.still = settled ? s.still + 1 : 0;
      }
    }

    for (const [id, s] of this.swinging) {
      const slot = scene.slotOf(id)!;
      const asleep = s.still >= SWING_SLEEP_STEPS;
      if (asleep) this.swinging.delete(id);
      this.write(scene, dirty, id, slot, asleep ? s.eq : s.theta, s);
    }
  }
}

const EMPTY: ReadonlySet<string> = new Set<string>();
