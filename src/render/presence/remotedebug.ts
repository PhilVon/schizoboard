/**
 * The remote-drag debug overlay — the raw sample drawn beside the interpolated
 * pose (T-235).
 *
 * > The interpolated pose drives the anchor, never the raw sample; **a debug
 * > overlay drawing both**; and a guaranteed fallback of critically-damped
 * > spring anchors. — DESIGN section 11.1, risk 2
 *
 * The last of that sentence's three mitigations to be built, and the one that
 * makes the other two checkable. Both of the others are claims about the
 * *difference* between two numbers — "the anchor followed the interpolated pose,
 * not the raw one", "the spring absorbed the jitter" — and until this there was
 * exactly one of those numbers anywhere a person could see. A screenshot of a
 * remote drag looked identical whether the interpolation was working perfectly
 * or not running at all.
 *
 * ## Why it has its own canvas
 *
 * `render/presence/draw.ts` argues at length that a presence painter must share
 * the overlay's canvas, and it is right: the overlay owns a deferred clear and a
 * staleness test that only work if every transient on the board goes through
 * them, and a second full-viewport clear per frame is a real cost for something
 * the board draws all the time.
 *
 * None of that applies here. This is not on the board all the time — it is not
 * in a production build at all, and in a dev build it is off until somebody
 * presses `Alt`+backquote (Q-185). While it is off there is no canvas, no
 * listener on the frame doing any work, and no term added to a staleness chain
 * that every other transient has to keep passing through. That is the whole
 * argument for Q-184's own-painter shape: a debug visual that cannot be
 * *implicated* in a rendering bug is worth more than one that saves a clear.
 *
 * ## What is drawn
 *
 * Per held item, three marks: a hollow square where the peer last said the item
 * was, a filled dot where this client actually put it, and a line joining them
 * whose length is the error. The two are the same point only when nothing is
 * moving and nothing has been rounded — and the sender rounds every pose to
 * whole board units and 1e-4 radians (`state/presence.ts`), so in practice the
 * square twitches around a dot that does not, which is the picture.
 *
 * A legend carries the numbers, because a live `jitter` of 14 says nothing
 * without the 20 it is climbing towards.
 */

import type { RemoteDebug } from "@/state/remote";
import { REMOTE_NUMBERS } from "@/state/remote";
import type { Camera } from "@/state/camera";

/** The raw sample: what arrived on the wire. */
const RAW = "#ff3ea5";
/** The interpolated pose: what was written into the scene, and what the ropes
 *  hang off. */
const SHOWN = "#2ee6d6";
/** The error between them, drawn faint so the two ends stay the subject. */
const LINK = "rgba(255, 255, 255, 0.55)";
const PANEL = "rgba(12, 10, 9, 0.82)";

/** Half-width of the raw sample's square, in screen pixels. Big enough to sit
 *  visibly *around* the dot rather than on it at any zoom. */
const RAW_HALF = 7;
const SHOWN_RADIUS = 3;
/** How long the angle tick is. Rotation is the field a person is least likely
 *  to notice going wrong, and two poses that agree on position can still be a
 *  quarter turn apart. */
const TICK = 18;

const FONT = "11px ui-monospace, SFMono-Regular, Menlo, monospace";

export class RemoteDebugPainter {
  private readonly host: HTMLElement;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private shown = false;
  private readonly disposers: (() => void)[] = [];

  constructor(host: HTMLElement) {
    this.host = host;

    const onKey = (e: KeyboardEvent): void => {
      // `Alt`+backquote (Q-185), beside the HUD's bare backquote and the physics
      // panel's shifted one. Three debug visuals on one physical key, which is
      // how the second and third are ever found.
      if (e.code !== "Backquote" || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      this.toggle();
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    this.disposers.push(() => window.removeEventListener("keydown", onKey));
  }

  get visible(): boolean {
    return this.shown;
  }

  toggle(): void {
    this.shown = !this.shown;
    // The canvas exists only while it is up. Off is not "drawn empty" — it is
    // nothing in the tree at all, so this cannot be a suspect in a paint bug
    // that happens while it is closed.
    if (!this.shown) this.teardown();
  }

  /**
   * One frame. Cheap and total: the canvas is cleared and redrawn every time,
   * because it is a readout of live state and there is no frame on which last
   * frame's marks are still true.
   */
  draw(camera: Camera, peers: readonly RemoteDebug[]): void {
    if (!this.shown) return;
    const ctx = this.surface();
    if (ctx === null) return;
    const canvas = this.canvas!;
    const dpr = devicePixelRatio;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    ctx.clearRect(0, 0, width, height);

    for (const peer of peers) {
      for (const item of peer.items) this.drawItem(ctx, camera, item);
    }
    this.drawLegend(ctx, peers);
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    // Not visible any more, and it has to *say* so: the key listener is gone, so
    // a `shown` left true is a flag nothing can ever put back down, and `draw`
    // would go on building a canvas into a host the board has finished with.
    this.shown = false;
    this.teardown();
  }

  private teardown(): void {
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
  }

  /** The canvas, made on the first frame after it was switched on and resized
   *  whenever the window is a different shape from the one it was made for. */
  private surface(): CanvasRenderingContext2D | null {
    const dpr = devicePixelRatio;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width === 0 || height === 0) return null;

    if (this.canvas === null) {
      const canvas = document.createElement("canvas");
      canvas.className = "remote-debug";
      this.host.append(canvas);
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
    }
    const canvas = this.canvas;
    const want = Math.round(width * dpr);
    const wantH = Math.round(height * dpr);
    if (canvas.width !== want || canvas.height !== wantH) {
      canvas.width = want;
      canvas.height = wantH;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      // Draw commands in CSS pixels, as every other canvas on this board does.
      this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return this.ctx;
  }

  private drawItem(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    item: RemoteDebug["items"][number],
  ): void {
    const raw = item.raw === null ? null : camera.boardToScreen(item.raw.x, item.raw.y);
    const shown = item.shown === null ? null : camera.boardToScreen(item.shown.x, item.shown.y);

    if (raw !== null && shown !== null) {
      ctx.strokeStyle = LINK;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(raw.x, raw.y);
      ctx.lineTo(shown.x, shown.y);
      ctx.stroke();
    }

    if (raw !== null) {
      ctx.strokeStyle = RAW;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(raw.x - RAW_HALF, raw.y - RAW_HALF, RAW_HALF * 2, RAW_HALF * 2);
      this.tick(ctx, raw.x, raw.y, item.raw!.rot, RAW);
    }

    if (shown !== null) {
      ctx.fillStyle = SHOWN;
      ctx.beginPath();
      ctx.arc(shown.x, shown.y, SHOWN_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      this.tick(ctx, shown.x, shown.y, item.shown!.rot, SHOWN);
    }

    // The error in board units, beside the pair. The number is the point: a
    // reader can tell 0.4 units of rounding from 40 units of a spring that has
    // been left behind, and the two look the same on a zoomed-out board.
    if (raw !== null && shown !== null && item.raw !== null && item.shown !== null) {
      const dx = item.raw.x - item.shown.x;
      const dy = item.raw.y - item.shown.y;
      const drot = item.raw.rot - item.shown.rot;
      ctx.fillStyle = LINK;
      ctx.font = FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(
        `${Math.hypot(dx, dy).toFixed(1)}u  ${(drot * (180 / Math.PI)).toFixed(2)}°`,
        raw.x + RAW_HALF + 4,
        raw.y - RAW_HALF - 4,
      );
    }
  }

  private tick(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    rot: number,
    colour: string,
  ): void {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(rot) * TICK, y + Math.sin(rot) * TICK);
    ctx.stroke();
  }

  private drawLegend(ctx: CanvasRenderingContext2D, peers: readonly RemoteDebug[]): void {
    const n = REMOTE_NUMBERS;
    const lines = [
      "remote motion — Alt+`",
      `delay ${n.delayMs}ms  buffer ${n.bufferMs}ms  cap ${n.maxExtrapolateMs}ms`,
      `spring ${n.springRate}/s  jitter trip ${n.jitterTrip}/${n.jitterMax}`,
      "",
    ];
    if (peers.length === 0) {
      lines.push("no peer is holding anything");
    }
    for (const peer of peers) {
      const state = peer.frozen ? "frozen" : peer.guessed ? "guessing" : "interpolating";
      lines.push(
        `#${peer.clientId}  ${state}${peer.spring ? " · SPRUNG" : ""}`,
        `  jitter ${peer.jitter}  buffered ${peer.buffered}  ` +
          `skew ${peer.skew === null ? "—" : `${peer.skew.toFixed(0)}ms`}  ` +
          `speed ${peer.speed.toFixed(0)}u/s`,
        `  holding ${peer.items.length}`,
      );
    }
    // The key, last, because it is the one part a reader only needs once.
    lines.push("", "□ raw sample (the wire)", "● interpolated (what the ropes hang off)");

    ctx.font = FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
    const height = lines.length * 15 + 16;
    ctx.fillStyle = PANEL;
    ctx.fillRect(10, 10, width, height);

    let y = 18;
    for (const line of lines) {
      ctx.fillStyle = line.includes("raw sample")
        ? RAW
        : line.includes("interpolated (")
          ? SHOWN
          : "#e8e2d8";
      ctx.fillText(line, 20, y);
      y += 15;
    }
  }
}
