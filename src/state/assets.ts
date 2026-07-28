/**
 * What this machine can show of each photograph.
 *
 * > Local per-asset state, **never** in the document:
 * >
 * > ```
 * > unknown → requesting → transferring(pct) → ready | unavailable
 * > ```
 * > — docs/DATA-MODEL.md section 10
 *
 * The document says an item wears a 4032×3024 JPEG with a given hash. Whether
 * *this* machine has the bytes is a fact about this disk and this session, and
 * two windows on the same board legitimately disagree about it — which is
 * exactly why it is stated as local state rather than written down. This module
 * is that state, and `app/main.ts` is the only thing that drives it.
 *
 * It replaces a `Set<string>` of hashes that were showable. The set answered the
 * one question a single machine can ask — are the bytes here? — and the reason
 * it could not answer more is that the other four states are all things a *peer*
 * does: asking, receiving, and running out of people to ask. `crdt/sync/`
 * (T-74) is what made them observable, and its `onProgress`/`onUnavailable`
 * hooks were written for this and until now went nowhere.
 *
 * ## Keyed by hash, not by item
 *
 * Several items can wear one photograph, and duplicate paste is the ordinary way
 * that happens — the store is content-addressed, so pasting the same picture
 * twice is two items and one asset. A state per item would be several copies of
 * one truth, and the copies would be wrong at different times.
 *
 * ## The transitions are guarded, and the guards are the design
 *
 * Nothing here is a plain assignment, because the callers are event handlers
 * that fire at rates and in orders they do not control:
 *
 * - **`ready` absorbs.** The bytes are on this disk and verified. Nothing that
 *   arrives afterwards — a late progress callback, a re-request from a rebind —
 *   may take a photograph off the screen once it is on it.
 * - **`requesting` only leaves `unknown`.** `assetUrl` asks the exchange for
 *   every missing asset on *every* rebind, so this is called many times a second
 *   during a transfer. If it could overwrite `transferring` the progress would
 *   be reset by the very act of drawing the frame that shows it.
 * - **`unavailable` is sticky against `requesting`, and only against that.** A
 *   re-request does not make an asset available: `crdt/sync/exchange.ts` gives
 *   up only after asking every peer that claimed to hold the hash, and wanting
 *   it again finds the same empty room. What clears it is bytes actually moving
 *   — `transferring` or `ready` — which is what happens the moment a peer that
 *   holds it joins. Without this the torn photograph would flicker back to
 *   "waiting" on every frame and never settle into anything a person could read.
 *
 * ## What it does not know
 *
 * A transfer that is abandoned mid-flight — the holder went quiet, or the socket
 * closed — is not reported, so an asset can sit at `transferring` at a stale
 * percentage until a retry lands and resets it. That is deliberate: the exchange
 * treats a silent peer as slow rather than gone for fifteen seconds before it
 * moves on, and a state that dropped back to `requesting` on every hiccup would
 * be noisier than the thing it describes. The HUD's in-flight count is where a
 * stalled transfer shows.
 */

/** The five states of docs/DATA-MODEL.md section 10. */
export type AssetPhase = "unknown" | "requesting" | "transferring" | "ready" | "unavailable";

/** Told which hash changed. Never told what it changed to — ask. */
export type AssetListener = (sha256: string) => void;

interface Entry {
  phase: AssetPhase;
  /** 0…1, and only meaningful while `transferring`. */
  fraction: number;
  /**
   * The whole percent this last notified at.
   *
   * A transfer is one callback per chunk, and a listener's job is to dirty every
   * item wearing the hash — which walks the scene. Ninety walks for a photograph
   * that redraws identically ninety times is work for nothing, so a progress
   * move is only announced when it would round to a different number.
   */
  announced: number;
}

export class AssetStates {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<AssetListener>();

  /** What this machine can currently do about this hash. */
  phase(sha256: string): AssetPhase {
    return this.entries.get(sha256)?.phase ?? "unknown";
  }

  /**
   * Whether an `<img>` may be pointed at it.
   *
   * The whole reason the state exists: bytes that are half-arrived are a 404,
   * and a 404 is a broken-image icon on a corkboard.
   */
  isReady(sha256: string): boolean {
    return this.entries.get(sha256)?.phase === "ready";
  }

  /** How far through, 0…1. Zero for anything that is not mid-transfer. */
  fraction(sha256: string): number {
    const entry = this.entries.get(sha256);
    return entry !== undefined && entry.phase === "transferring" ? entry.fraction : 0;
  }

  /**
   * How many hashes nobody on this board has.
   *
   * For the dev HUD, and it is the one number the exchange cannot supply: it
   * drops a hash from `wanted` at the moment it gives up on it, so from over
   * there a photograph nobody has and a photograph everybody has look the same.
   */
  countUnavailable(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.phase === "unavailable") count += 1;
    return count;
  }

  /** Asked for, from somebody who claims to have it. */
  requesting(sha256: string): void {
    if (this.entries.has(sha256)) return;
    this.set(sha256, "requesting", 0);
  }

  /** Chunks are arriving. `total` is chunks, not bytes — the exchange counts in chunks. */
  transferring(sha256: string, received: number, total: number): void {
    const entry = this.entries.get(sha256);
    if (entry?.phase === "ready") return;
    this.set(sha256, "transferring", total > 0 ? Math.min(1, received / total) : 0);
  }

  /** The bytes are on this disk, verified, with their variants built. */
  ready(sha256: string): void {
    this.set(sha256, "ready", 0);
  }

  /** Every peer that claimed to hold it has been asked and could not produce it. */
  unavailable(sha256: string): void {
    if (this.entries.get(sha256)?.phase === "ready") return;
    this.set(sha256, "unavailable", 0);
  }

  /** Told whenever a hash's state changes enough to redraw. Returns the unsubscribe. */
  onChange(listener: AssetListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(sha256: string, phase: AssetPhase, fraction: number): void {
    const entry = this.entries.get(sha256);
    const announced = Math.round(fraction * 100);
    if (entry === undefined) {
      this.entries.set(sha256, { phase, fraction, announced });
      this.notify(sha256);
      return;
    }
    const moved = entry.phase !== phase || announced !== entry.announced;
    entry.phase = phase;
    entry.fraction = fraction;
    if (!moved) return;
    entry.announced = announced;
    this.notify(sha256);
  }

  private notify(sha256: string): void {
    for (const listener of this.listeners) listener(sha256);
  }
}
