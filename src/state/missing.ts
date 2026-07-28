/**
 * Who to ask about photographs nobody here has.
 *
 * > A photo that no connected peer holds gets a torn-photograph treatment and a
 * > retry, plus a board-level notice naming who to ask. — docs/DESIGN.md 7.5
 *
 * The tear (T-75, `render/items/film.ts`) says *this* photograph is not coming.
 * It cannot say why, and "why" is the only part a person can act on: the bytes
 * are on somebody's laptop, and the useful sentence names whose.
 *
 * ## Names outlive their peers, on purpose
 *
 * A peer who is still here and still cannot produce a photograph is the rare
 * case — the exchange asks everyone who claims to hold a hash before it gives
 * up, so by the time anything is unavailable the holder has almost always gone.
 * Awareness drops a peer's state on disconnect by design (`state/presence.ts`),
 * so reading the name at the moment we need it would find nothing exactly when
 * it matters. This keeps every name it has been told, and marks whether that
 * peer is still in the room.
 *
 * That is a deliberate exception to "nothing durable goes on awareness" rather
 * than a violation of it: nothing here is written down, and it dies with the
 * session, which is the same lifetime as the missing state it annotates.
 *
 * ## What it is not
 *
 * Not a second copy of `state/assets.ts`. That module owns which of the five
 * states a hash is in and is the thing the renderer reads. This owns only the
 * attribution — which peers claimed a hash we then failed to get — and exists
 * because the exchange knows it at the moment it gives up and nothing else ever
 * will.
 */

/** A peer that claimed to hold something we could not get. */
export interface Holder {
  readonly clientId: number;
  readonly name: string;
  readonly color: string;
  /** Still in the room. False is the ordinary case, and the interesting one. */
  readonly present: boolean;
}

/** What the board should say, or null when it should say nothing. */
export interface MissingNotice {
  /** Distinct photographs, not items — several items can wear one hash. */
  readonly count: number;
  /** Nearest thing to an answer, present peers first. Empty on a board with no wire. */
  readonly holders: readonly Holder[];
}

/** More than this many names is a list, not a sentence. */
const MAX_NAMES = 3;

interface Known {
  name: string;
  color: string;
}

export class MissingAssets {
  /** Every peer this session has been told about, including ones that left. */
  private readonly known = new Map<number, Known>();
  private readonly present = new Set<number>();
  /** hash → the peers that claimed it and could not produce it. */
  private readonly missing = new Map<string, Set<number>>();

  /** A peer is here, or has changed their name. */
  seen(clientId: number, name: string, color: string): void {
    this.known.set(clientId, { name, color });
    this.present.add(clientId);
  }

  /** A peer left. The name stays — it is the whole point of this module. */
  left(clientId: number): void {
    this.present.delete(clientId);
  }

  /**
   * The exchange gave up on a hash, having asked everyone who claimed it.
   *
   * `tried` is empty on a board with no wire, where nothing was asked because
   * there was nobody to ask. That is still worth a notice — it is just a notice
   * with no name in it.
   */
  unavailable(sha256: string, tried: readonly number[] = []): void {
    this.missing.set(sha256, new Set(tried));
  }

  /**
   * Bytes moved, so it is not missing any more.
   *
   * Called for `transferring` as well as `ready`, and for the same reason
   * `state/assets.ts` clears its own sticky `unavailable` on either: a peer that
   * holds it has turned up, and the notice should go the moment that is true
   * rather than when the last chunk lands.
   */
  arrived(sha256: string): void {
    this.missing.delete(sha256);
  }

  /**
   * Drop anything the board no longer wears.
   *
   * The item carrying a missing photograph can simply be deleted, and then the
   * notice is counting something that is not there. Phrased as "keep these"
   * rather than "forget that one" because nothing tells us an item went — the
   * caller has the live set of referenced hashes and this is the cheap way to
   * use it.
   */
  retain(referenced: ReadonlySet<string>): void {
    for (const sha256 of this.missing.keys()) {
      if (!referenced.has(sha256)) this.missing.delete(sha256);
    }
  }

  /** How many photographs nobody here has. */
  get count(): number {
    return this.missing.size;
  }

  /**
   * The notice, or null when there is nothing to say.
   *
   * Present peers first: somebody who is here can be asked, and somebody who is
   * not can only be waited for. Within each group, insertion order — which is
   * the order they were first seen, and as good as any other.
   */
  notice(): MissingNotice | null {
    if (this.missing.size === 0) return null;

    const claimed = new Set<number>();
    for (const peers of this.missing.values()) for (const peer of peers) claimed.add(peer);

    const holders: Holder[] = [];
    for (const clientId of claimed) {
      const known = this.known.get(clientId);
      // A peer we were never told the name of. Nothing to say about them, and
      // "someone" in a list of real names reads worse than a shorter list.
      if (known === undefined) continue;
      holders.push({
        clientId,
        name: known.name,
        color: known.color,
        present: this.present.has(clientId),
      });
    }
    holders.sort((a, b) => Number(b.present) - Number(a.present));

    return { count: this.missing.size, holders: holders.slice(0, MAX_NAMES) };
  }
}

/**
 * The notice as one line of English.
 *
 * Here rather than in the view because it is all cases and no DOM, and because
 * getting it wrong is a sentence a person reads rather than a pixel they do
 * not. Kept deliberately plain: this is a corkboard, and "⚠ 3 ASSETS
 * UNAVAILABLE" is the register the whole design is avoiding.
 */
export function noticeText(notice: MissingNotice): string {
  const what =
    notice.count === 1 ? "A photograph nobody here has" : `${notice.count} photographs nobody here has`;
  if (notice.holders.length === 0) return what;

  const names = joinNames(notice.holders.map((h) => h.name));
  // Split on presence rather than listing everyone the same way. Somebody in
  // the room can be asked; somebody who has gone can only be waited for, and
  // telling a person to ask an empty chair is worse than saying nothing.
  const here = notice.holders.filter((h) => h.present);
  if (here.length === notice.holders.length) return `${what} — ask ${names}`;
  if (here.length === 0) return `${what} — ${names} had them, and left`;
  return `${what} — ask ${joinNames(here.map((h) => h.name))}`;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
