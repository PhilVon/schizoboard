/**
 * The janitor — who compacts, and when.
 *
 * > A pin whose parent has vanished renders as free-floating at its last known
 * > board position, computed locally with no write. A string node pointing at a
 * > missing pin is skipped at render time. A string with fewer than two valid
 * > nodes is hidden.
 * >
 * > Repairing on read causes write storms in a shared session — every client
 * > racing to fix the same inconsistency — and makes undo incoherent. Instead, a
 * > single elected client (lowest present client id) compacts a few seconds
 * > later under a maintenance origin that undo doesn't track.
 * > — docs/DATA-MODEL.md section 8.1
 *
 * That paragraph is the whole specification and every clause in it is load
 * bearing. This module is the election and the delay; `crdt/ops/janitor.ts` is
 * the transaction.
 *
 * ## What it collects, and why nothing else can
 *
 * Two shapes of the same decay, `crdt/invariants.ts`'s `compactableStrings`:
 *
 *   - **A string with fewer than two nodes resolving to a pin.** Nothing draws
 *     it at all, and it is deleted.
 *   - **A live string carrying a node that resolves to nothing.** It draws
 *     perfectly well — the run steps over the dead node and closes up around it
 *     (`sim/ropes.ts`) — and the dead reference is dropped.
 *
 * T-76's fuzz harness showed why no cascade will ever get to either: a guard
 * evaluated against one document cannot constrain the union of two. Two peers
 * each reduce a string to the legal minimum, both are right, and the merge
 * leaves it below. Or a string is tied to a pin somebody else is deleting, and
 * the pin cascade heals every string it can see — which cannot include one that
 * does not exist on that peer yet.
 *
 * Both leave a record that is invisible (nothing draws it) and permanent
 * (nothing removes it). The second kind is the one that *accumulates*: it costs
 * a pin deletion that raced a concurrent edit, and the string goes on looking
 * and behaving exactly right while carrying the reference for the life of the
 * board.
 *
 * ## The delay is not politeness
 *
 * "A few seconds later" reads like a courtesy and is actually the correctness
 * argument. A string is judged against the pins *this client currently holds*,
 * and on a fresh connection that set is incomplete: updates arrive in whatever
 * order the relay sends them, and a peer routinely receives a string before the
 * pins it names. For that window **every string on the board is unrepairable**.
 * A janitor that acted on one observation would empty a board on connect.
 *
 * So a string is compacted only if it has been decayed *continuously* across
 * [`SETTLE_MS`], re-examined every [`CHECK_MS`]. Anything that flickers — which
 * is exactly what an out-of-order arrival looks like — is dropped from the list
 * and starts again from nothing if it ever comes back.
 *
 * ## The one thing it cannot protect
 *
 * Undo restores a deleted pin, and a pin coming back can make a collected string
 * repairable again — but the collection happened under `Origin.JANITOR`, which
 * `TRACKED_ORIGINS` deliberately excludes, so undo will not bring the string
 * with it. The pin returns and the string does not. The same is true one node at
 * a time: undo the deletion and the pin comes back with no string through it,
 * because the node that named it has been dropped.
 *
 * That is inherent to section 8.1 rather than a bug in this file: a maintenance
 * write that undo *did* track is exactly the "makes undo incoherent" the section
 * rules out, and it would put a compaction nobody performed into a user's undo
 * stack. What bounds the damage is the delay — the record has to have been
 * invisible for [`SETTLE_MS`] before it is eligible at all, so what is lost is
 * never something anyone could still see. A pruned node in particular drew
 * nothing before and the string draws exactly the same thing after; the loss is
 * entirely in a future the user has [`SETTLE_MS`] to ask for.
 */

import type { BoardDoc } from "@/crdt/doc";
import { compactableStrings } from "@/crdt/invariants";
import { compactStrings } from "@/crdt/ops/janitor";

/**
 * How long a string must be beyond repair, continuously, before it is collected.
 *
 * Five seconds, and the floor is set by resync rather than by taste: it has to
 * comfortably outlast a peer receiving a board's strings before its pins, which
 * on loopback and on a LAN is well under a second and on a bad connection is
 * still a small multiple of that. The ceiling is only that a board should not
 * carry invisible records around all afternoon.
 *
 * Erring long is free and erring short is not — see `crdt/ops/janitor.ts`.
 */
export const SETTLE_MS = 5000;

/**
 * How often the document is examined at all.
 *
 * `compactableStrings` reads every string on the board, which is tens to
 * hundreds of `readString` calls — nothing, once a second, and not something to
 * do in a frame. The tick is driven from the frame loop because that is the
 * clock the application already has, so this is the rate limit that keeps it off
 * the hot path.
 */
export const CHECK_MS = 1000;

export interface JanitorOptions {
  settleMs?: number;
  checkMs?: number;
}

/**
 * Whether a peer has hold of this string right now — DATA-MODEL section 5.4's
 * advisory lock, as `render/presence/peers.ts` reads it.
 *
 * A predicate rather than a set, and asked rather than given, because it is
 * consulted only for a string that is *ripe*, which is almost never. A set
 * built every frame to answer a question posed once a second at most, about
 * nothing, would be the whole cost of this feature.
 *
 * The lock arrives here as a parameter for the same reason `present` does: who
 * is holding what is an awareness question and awareness is not the document.
 */
export type Held = (stringId: string) => boolean;

const NOBODY: Held = () => false;

/**
 * Whether this client is the one that compacts.
 *
 * > a single elected client (lowest present client id) — section 8.1
 *
 * Lowest wins, and `present` must include this client. An empty `present` means
 * the caller has no idea who is on the board — a provider that has not connected
 * — which is emphatically not the same as being alone, so nobody is elected and
 * nothing is collected. A board with genuinely no wire passes its own id and is
 * elected trivially.
 *
 * Exported because "who compacts" is a claim worth testing without a document.
 */
export function elected(self: number, present: Iterable<number>): boolean {
  let lowest: number | null = null;
  let sawSelf = false;
  for (const id of present) {
    if (id === self) sawSelf = true;
    if (lowest === null || id < lowest) lowest = id;
  }
  return sawSelf && lowest === self;
}

export class Janitor {
  private readonly board: BoardDoc;
  private readonly settleMs: number;
  private readonly checkMs: number;

  /**
   * When each string was *first* seen beyond repair, on the caller's clock.
   *
   * The map is the continuity requirement: an entry that disappears from the
   * current reading is deleted rather than remembered, so a string that was
   * briefly unrepairable because its pin had not arrived yet starts from zero if
   * it is ever seen that way again.
   */
  private readonly since = new Map<string, number>();
  private lastCheck: number | null = null;

  constructor(board: BoardDoc, options: JanitorOptions = {}) {
    this.board = board;
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.checkMs = options.checkMs ?? CHECK_MS;
  }

  /** How many strings are on the clock but not yet ripe. For the HUD, and tests. */
  get pending(): number {
    return this.since.size;
  }

  /**
   * One examination, rate-limited internally so the caller can tick every frame.
   *
   * `present` is every client id on the board including this one — from
   * `Awareness.getStates()` plus our own, which is the only place that answer
   * exists. Returns the strings it changed, deleted or merely tidied alike,
   * which is almost always none.
   *
   * ## Why a held string is left alone
   *
   * `held` is section 5.4's advisory lock, and reading one at all wanted
   * deciding rather than assuming: a claim is explicitly a hint that nothing may
   * treat as correctness, and code that skips work because of one is treating it
   * as something. The line is what happens when the hint is wrong. A split that
   * consulted a lock and refused would be enforcing it — two people splitting
   * the same segment is a case 5.4 accepts and must go on accepting. This
   * refuses nothing: it *waits*, and a maintenance pass with a five second
   * settle period behind it can afford to wait a tick. A stale lock costs a
   * second of tidying; a missing one costs nothing at all, because the string
   * stays on the clock either way and the transaction re-checks regardless.
   */
  tick(now: number, present: Iterable<number>, held: Held = NOBODY): readonly string[] {
    if (this.lastCheck !== null && now - this.lastCheck < this.checkMs) return EMPTY;
    this.lastCheck = now;

    if (!elected(this.board.doc.clientID, present)) {
      // Not our job. The clock is thrown away rather than paused: if the elected
      // client leaves and this one takes over, it should serve its own settle
      // period rather than act on observations made while somebody else was
      // responsible for them — that peer may have been about to collect, or may
      // have known something this one did not.
      this.since.clear();
      return EMPTY;
    }

    const decayed = compactableStrings(this.board);
    if (decayed.length === 0) {
      this.since.clear();
      return EMPTY;
    }

    const current = new Set(decayed);
    for (const id of this.since.keys()) if (!current.has(id)) this.since.delete(id);

    const ripe: string[] = [];
    for (const id of current) {
      const first = this.since.get(id);
      if (first === undefined) {
        this.since.set(id, now);
        continue;
      }
      if (now - first < this.settleMs) continue;
      // Ripe, but somebody is in it. Left on the clock rather than dropped from
      // it: it has been decayed continuously all the same, and the hint says
      // nothing about that — only that this second is a discourteous one.
      if (held(id)) continue;
      ripe.push(id);
    }
    if (ripe.length === 0) return EMPTY;

    // The op re-checks each one inside its transaction, so a string saved
    // between here and there survives — and comes back on the next tick's
    // reading as repaired, which drops it from the clock.
    const swept = compactStrings(this.board, ripe);
    const touched = [...swept.collected, ...swept.pruned];
    for (const id of touched) this.since.delete(id);
    return touched;
  }
}

/** The same array every tick that collects nothing, which is almost all of them. */
const EMPTY: readonly string[] = Object.freeze([]);
