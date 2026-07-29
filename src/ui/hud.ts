/**
 * The dev HUD.
 *
 * docs/DESIGN.md section 9.5: per-phase frame timings, awake particle count,
 * DOM node count and document size, "with a hard alert if the document passes
 * 25 MB. Performance problems that aren't measured become 'it feels slow
 * lately', which is unfixable."
 *
 * It ships from phase 0 precisely so that a regression shows up as a number
 * rather than as a feeling. Two rules keep it from becoming the thing it
 * measures:
 *
 *   - it writes DOM at 5 Hz, not 60 — the numbers are unreadable faster anyway;
 *   - it reads nothing from the DOM except a node count, and that only on the
 *     same 5 Hz tick, never inside the loop's read phases.
 */

import type { Tier } from "@/render/lod";
import { PHASES, type FrameLoop } from "@/render/loop";

const REFRESH_MS = 200;
/** DESIGN section 9.5 — hard alert past this document size. */
const DOC_SIZE_ALERT_BYTES = 25 * 1024 * 1024;

/** Numbers the HUD cannot compute for itself. */
export interface HudStats {
  zoom: number;
  /**
   * How much of an item is being drawn — `render/lod.ts`, DESIGN section 6.6.
   *
   * Beside the zoom rather than derived from it, and that is the point: the
   * tier has hysteresis and only moves at gesture end, so a board at 36% may
   * legitimately be in either tier and the zoom alone cannot say which. It is
   * also the only way to tell a tier that did not switch from one that switched
   * and drew the same thing anyway.
   */
  lodTier: Tier;
  cameraX: number;
  cameraY: number;
  /** Rope particles currently being stepped (DESIGN section 5.3). */
  awakeParticles: number;
  /** Encoded document size in bytes. */
  docBytes: number;
  /** Items in the scene mirror. */
  items: number;
  /** Items the renderer is actually presenting — the gap is culling. */
  mounted: number;
  /**
   * Ink canvases that exist, and the device pixels they hold between them.
   *
   * The count is the only place off-screen eviction is observable: pan an
   * annotated photograph away and it falls, pan back and it returns (DESIGN
   * section 9.3). The pixels are the memory that sizing a canvas in
   * power-of-two steps can run up — a 300-unit stroke at four times zoom rounds
   * to a 2048-square backing store — and they are here so that a decision to
   * deviate from that sizing can be made off a number rather than off a hunch.
   */
  inked: number;
  inkPixels: number;
  /**
   * Records the janitor is holding on the clock, and how many it has collected
   * this session — `crdt/janitor.ts`.
   *
   * Here for the reason the ink numbers are: it makes something otherwise
   * invisible watchable. A janitor that never runs and a board with nothing to
   * collect look identical from outside, and so do a janitor working correctly
   * and one that has quietly stopped. `pending` moving off zero and back is the
   * whole mechanism happening in front of you.
   */
  janitorPending: number;
  janitorSwept: number;

  /**
   * Assets this board refers to and has no bytes for, how many are being
   * fetched from a peer right now, and how far through those are —
   * `crdt/sync/exchange.ts`.
   *
   * Here for the janitor's reason. An asset that is still arriving, one whose
   * holder has gone quiet, and one nobody on the board has, are the same
   * picture from outside: an empty frame. `wanted` falling to zero is the
   * transfer finishing; `wanted` sitting still with nothing in flight is it
   * having failed, and there is no other way to tell those apart.
   */
  assetsWanted: number;
  assetsInFlight: number;
  assetsPercent: number;
  /**
   * Hashes this board refers to that nobody on it has — `state/assets.ts`.
   *
   * Not derivable from the three above, and that is the point: the exchange
   * drops a hash from `wanted` at the instant it gives up on it, so a
   * photograph nobody has and a photograph everybody has both read as zero
   * wanted. Giving up is the one asset outcome that leaves no trace anywhere
   * else, and until T-75 draws it there is nothing on screen to see either.
   */
  assetsUnavailable: number;
}

/**
 * Ink held, past which the sizing is worth revisiting. Four canvases at the
 * worst power-of-two rounding, which is the point at which "most items have no
 * ink" has stopped being true of what is on screen.
 */
const INK_ALERT_PIXELS = 64 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class Hud {
  visible = false;

  private readonly el: HTMLDivElement;
  private readonly loop: FrameLoop;
  private readonly stats: () => HudStats;
  private readonly smoothed = new Float32Array(PHASES.length);
  private lastPaint = 0;
  private domNodes = 0;
  private readonly disposers: (() => void)[] = [];

  constructor(host: HTMLElement, loop: FrameLoop, stats: () => HudStats) {
    this.loop = loop;
    this.stats = stats;

    this.el = document.createElement("div");
    this.el.className = "hud";
    this.el.hidden = true;
    host.append(this.el);

    const onKey = (e: KeyboardEvent): void => {
      // Backquote — F12 belongs to devtools and Escape belongs to the tools.
      if (e.code !== "Backquote" || e.ctrlKey || e.metaKey || e.altKey) return;
      this.toggle();
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    this.disposers.push(() => window.removeEventListener("keydown", onKey));
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.hidden = !this.visible;
    if (this.visible) this.lastPaint = 0;
  }

  /**
   * OVERLAY phase (8). Timings are smoothed every frame — sampling them at
   * 5 Hz would report whichever frame happened to land on the tick — but the
   * DOM is only written on the tick.
   */
  update(now: number): void {
    if (!this.visible) return;

    const timings = this.loop.timings;
    for (let i = 0; i < timings.length; i++) {
      this.smoothed[i] = this.smoothed[i]! * 0.9 + timings[i]! * 0.1;
    }

    if (now - this.lastPaint < REFRESH_MS) return;
    this.lastPaint = now;
    this.paint();
  }

  private paint(): void {
    const s = this.stats();
    // A live HTMLCollection's length forces no layout, and 5 Hz is cheap.
    this.domNodes = document.getElementsByTagName("*").length;

    const frameMs = this.loop.frameMs;
    const fps = frameMs > 0 ? Math.min(999, 1000 / Math.max(frameMs, 1000 / 240)) : 0;

    const rows: string[] = [];
    rows.push(
      `<div class="hud-head"><b>${frameMs.toFixed(2)}</b> ms &nbsp;<span>${fps.toFixed(0)} fps</span></div>`,
    );
    for (let i = 0; i < PHASES.length; i++) {
      const ms = this.smoothed[i]!;
      // 16.7 ms is the whole budget, so bar width is share-of-frame.
      const pct = Math.min(100, (ms / 16.7) * 100);
      rows.push(
        `<div class="hud-row"><span class="hud-k">${PHASES[i]}</span>` +
          `<span class="hud-bar"><i style="width:${pct.toFixed(1)}%"></i></span>` +
          `<span class="hud-v">${ms.toFixed(2)}</span></div>`,
      );
    }
    rows.push('<div class="hud-sep"></div>');
    rows.push(this.stat("zoom", `${(s.zoom * 100).toFixed(0)}% · ${s.lodTier}`));
    rows.push(this.stat("camera", `${Math.round(s.cameraX)}, ${Math.round(s.cameraY)}`));
    rows.push(this.stat("items", `${s.mounted} / ${s.items}`));
    rows.push(this.stat("awake", String(s.awakeParticles)));
    rows.push(
      this.stat(
        "ink",
        s.inked === 0 ? "0" : `${s.inked} · ${(s.inkPixels / 1e6).toFixed(1)} MP`,
        s.inkPixels > INK_ALERT_PIXELS,
      ),
    );
    rows.push(this.stat("dom", String(this.domNodes)));
    rows.push(
      this.stat("doc", formatBytes(s.docBytes), s.docBytes > DOC_SIZE_ALERT_BYTES),
    );
    // Silent on the overwhelmingly common case — nothing pending, nothing ever
    // collected — so the row appears exactly when there is something to say.
    if (s.janitorPending > 0 || s.janitorSwept > 0) {
      rows.push(this.stat("janitor", `${s.janitorPending} · ${s.janitorSwept} swept`));
    }
    // Same rule: a board whose photographs are all here has nothing to say.
    if (s.assetsWanted > 0 || s.assetsUnavailable > 0) {
      const gone = s.assetsUnavailable > 0 ? ` · ${s.assetsUnavailable} nobody has` : "";
      rows.push(
        this.stat(
          "assets",
          s.assetsInFlight === 0
            ? `${s.assetsWanted} missing${gone}`
            : `${s.assetsWanted} missing · ${s.assetsInFlight} in flight ${s.assetsPercent}%${gone}`,
          // Wanted, and nobody fetching them. Either no peer has advertised the
          // hash or every one that did has failed — and both are stuck. Given
          // up on is stuck too, and more finally.
          s.assetsInFlight === 0 || s.assetsUnavailable > 0,
        ),
      );
    }

    this.el.innerHTML = rows.join("");
  }

  private stat(key: string, value: string, alert = false): string {
    return (
      `<div class="hud-row"><span class="hud-k">${key}</span>` +
      `<span class="hud-v${alert ? " hud-alert" : ""}">${value}</span></div>`
    );
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.el.remove();
  }
}
