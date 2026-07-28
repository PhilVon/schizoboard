/**
 * Drawing somebody else — phase 8, on the overlay canvas.
 *
 * > 8. OVERLAY   remote cursors, ghosts, wet ink, selection chrome
 * > — docs/ARCHITECTURE.md section 3
 *
 * Cursors are named first in that list and were the last thing to exist: the
 * publish half has worked since T-71 and nothing read it. This is the read half,
 * and it draws two things — where a peer is pointing, and what they have hold of.
 *
 * ## Why it is a separate module and still on the overlay's canvas
 *
 * It has to be the *same* canvas. `render/overlay.ts` owns a deferred clear and
 * a staleness test that only work if every transient on the board goes through
 * them — a second canvas for presence would be a second full-viewport clear on
 * every frame a cursor twitched, and a second set of z-order arguments. So the
 * overlay keeps the bookkeeping and this keeps the drawing, which is the same
 * split `render/ink/wet.ts` already has.
 *
 * That is why every entry point here takes a `clear` callback rather than
 * clearing for itself. The overlay's rule is that a frame which turns out to
 * draw nothing must not touch the canvas at all, and whether a peer's cursor is
 * on screen is not known until it has been through the camera. So the caller
 * hands over the one thing it cannot delegate: *call this before you put the
 * first mark down*, and not before.
 *
 * ## Colour is the identity, so colour is what is different about it
 *
 * Our own chrome is a warm near-black (`SELECT_STROKE`) and a peer's is their
 * own colour from `lib/palette.ts` — the six that were chosen to be told apart
 * on cork, which is exactly the requirement — drawn a few pixels further out.
 * Two people selecting the same photograph therefore produce two concentric
 * outlines rather than one ambiguous one, and the outline further out is the one
 * that matches the cursor moving it.
 */

import { carryScale } from "@/lib/carry";
import type { RopeGeometry } from "@/render/overlay";
import type { DrawnPeer, PeerSource } from "@/render/presence/peers";
import { pinHitRadius } from "@/render/pins/dom";
import { bodyWidth } from "@/render/ropes/paint";
import type { Camera, Vec2 } from "@/state/camera";
import { SELECT_PAD } from "@/state/handles";
import type { Scene } from "@/state/scene";

/**
 * How far outside our own chrome a peer's sits.
 *
 * Enough to read as two lines rather than one thick one at every zoom, since
 * both are in screen pixels. Our outline is 1.5 px at `SELECT_PAD`; four more
 * leaves a clear gap of cork or paper between them.
 */
const PEER_PAD = 4;

/**
 * A shade heavier than our own 1.5 px outline.
 *
 * Not for emphasis — for legibility. Ours is near-black and reads against
 * anything; a peer's is a mid-value colour that has to hold its own against a
 * photograph of similar value, and two pixels is what stops a green outline
 * disappearing into a lawn.
 */
const PEER_WIDTH = 2;

/**
 * The fringe left either side of a peer's selected string.
 *
 * The same trick `Overlay.drawStrings` uses and for the same reason: a wide
 * coloured stroke laid over a string makes it read as *tinted* rather than as
 * marked, so the band over the cotton itself is taken back out with
 * `destination-out` and only the outline survives. Wider than our own halo, so
 * that on a string both of us have selected the two are still two.
 */
const PEER_STRING_WIDEN = 11;
const PEER_STRING_CLEAR = 7;

/** The arrow, tip at the origin, in CSS pixels. The classic pointer. */
const ARROW: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 17],
  [4.1, 13.1],
  [6.9, 18.7],
  [9.4, 17.5],
  [6.6, 12.1],
  [11.5, 11.6],
];

/** Widest and tallest the arrow gets, for the viewport reject. */
const ARROW_REACH = 20;

/**
 * A pale outline round the arrow rather than a dark one.
 *
 * Every colour in the palette is mid-to-dark by construction — DESIGN section
 * 4.6 pulls all six toward the middle so they lie on the cork instead of
 * separating from it — so a dark outline round a dark arrow is no outline at
 * all. Pale is the value none of them is, which makes it the only one that
 * works for all six on cork, on a photograph and on a note.
 */
const ARROW_RING = "rgba(255, 246, 222, 0.92)";
const ARROW_RING_WIDTH = 1.5;

/**
 * The name, in the warm off-white the rest of the board's light is, outlined in
 * the warm near-black its shadows are.
 *
 * Pale-on-dark rather than in the peer's own colour, because a name is *read*
 * and the palette contains a very dark warm grey and a mid yellow — no single
 * treatment makes both of those legible as small text. The colour identity is
 * carried by the arrow immediately above it, which is a shape rather than a
 * glyph and can afford to be any value at all.
 */
const LABEL_FILL = "#f4ead6";
const LABEL_RING = "rgba(28, 18, 10, 0.85)";
const LABEL_RING_WIDTH = 3;
/** Matches `--ui-font` in `styles/base.css`: this is chrome, not handwriting. */
const LABEL_FONT = '500 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
/** From the arrow's tip to the label's baseline start — clear of the tail. */
const LABEL_DX = 13;
const LABEL_DY = 27;

export class PeerPainter {
  /** Reused; `boardToScreen` allocates otherwise, and this runs per frame. */
  private readonly a: Vec2 = { x: 0, y: 0 };

  /**
   * A coloured outline along every string a peer has selected.
   *
   * **Must be drawn before any other chrome on this canvas.** It composites with
   * `destination-out`, which erases whatever is already underneath it and does
   * not care that the thing underneath was ours.
   *
   * Walked from the rope particles rather than from the pins, like our own halo:
   * a string with any drape in it is nowhere near the chord between its pins,
   * and an outline along the chord would sit in mid-air over the string it
   * claims to be marking.
   */
  strings(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    scene: Scene,
    ropes: RopeGeometry,
    peers: PeerSource,
    clear: () => void,
  ): boolean {
    const pool = ropes.positions;
    const zoom = camera.zoom;
    const camX = camera.x;
    const camY = camera.y;
    let drew = false;

    for (const peer of peers.peers()) {
      for (const id of peer.strings) {
        const style = scene.strings.get(id);
        // A peer can name a string somebody else has just deleted. Their
        // awareness state is not pruned by anything on this machine, so unlike
        // our own selection there is no `prune` to have tidied it up — this
        // check is the whole of it.
        if (style === undefined) continue;

        let any = false;
        ctx.beginPath();
        ropes.visit(id, (at, count) => {
          ctx.moveTo((pool[at]! - camX) * zoom, (pool[at + 1]! - camY) * zoom);
          for (let i = 1; i < count; i++) {
            const j = at + i * 2;
            ctx.lineTo((pool[j]! - camX) * zoom, (pool[j + 1]! - camY) * zoom);
          }
          any = true;
        });
        if (!any) continue;

        clear();
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        // Off the *drawn* width, not the authored thickness: a yarn draws half
        // again as wide as it is stored, and a fringe sized off the number in
        // the document would be hidden under the strand.
        const drawn = bodyWidth(style.thickness, style.material);
        ctx.lineWidth = drawn + PEER_STRING_WIDEN;
        ctx.strokeStyle = peer.color;
        ctx.stroke();
        ctx.globalCompositeOperation = "destination-out";
        ctx.lineWidth = drawn + PEER_STRING_CLEAR;
        ctx.stroke();
        ctx.restore();
        drew = true;
      }
    }
    return drew;
  }

  /**
   * The boxes and rings: a peer's selected items and pins.
   *
   * Drawn after our own chrome rather than before it, so that on something both
   * of us have hold of ours is the one on top — the board is ours, and the
   * question "have I got this?" should never be answered by a collaborator's
   * outline being in front.
   */
  chrome(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    scene: Scene,
    peers: PeerSource,
    clear: () => void,
  ): boolean {
    let drew = false;
    for (const peer of peers.peers()) {
      if (this.items(ctx, camera, scene, peer, clear)) drew = true;
      if (this.pins(ctx, camera, scene, peer, clear)) drew = true;
    }
    return drew;
  }

  /**
   * The same geometry `Overlay.drawSelection` uses — the item's own box, carried
   * at the 2% a lifted item is drawn at, turned by `rot + swing` so the chrome
   * rides a photograph that is still settling on its pin — a few pixels further
   * out and in the peer's colour.
   */
  private items(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    scene: Scene,
    peer: DrawnPeer,
    clear: () => void,
  ): boolean {
    let drew = false;
    for (const id of peer.items) {
      const slot = scene.slotOf(id);
      if (slot === undefined) continue;

      const scale = carryScale(scene.lift[slot]!);
      const hw = (scene.w[slot]! * camera.zoom * scale) / 2 + SELECT_PAD + PEER_PAD;
      const hh = (scene.h[slot]! * camera.zoom * scale) / 2 + SELECT_PAD + PEER_PAD;
      const centre = camera.boardToScreen(scene.renderX(slot), scene.renderY(slot), this.a);
      const cx = centre.x;
      const cy = centre.y;

      // Circle-against-viewport reject, like our own chrome: a peer who selected
      // the whole board is a few multiplications per item, not a DOM node.
      const reach = Math.hypot(hw, hh);
      if (cx + reach < 0 || cx - reach > camera.width) continue;
      if (cy + reach < 0 || cy - reach > camera.height) continue;

      clear();
      if (!drew) {
        // Set once per peer, not per item — one peer is one colour.
        ctx.strokeStyle = peer.color;
        ctx.lineWidth = PEER_WIDTH;
        drew = true;
      }
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(scene.rot[slot]! + scene.swing[slot]!);
      ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
      ctx.restore();
    }
    return drew;
  }

  /**
   * A ring round each pin a peer holds, outside the one we would draw.
   *
   * Sized from `pinHitRadius` for the reason our own ring is: what you can see
   * somebody has hold of is what they can grab.
   */
  private pins(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    scene: Scene,
    peer: DrawnPeer,
    clear: () => void,
  ): boolean {
    if (peer.pins.length === 0) return false;
    const radius = pinHitRadius(camera.zoom) + PEER_PAD * 2;
    let drew = false;

    for (const id of peer.pins) {
      const pin = scene.pins.get(id);
      if (pin === undefined) continue;
      const at = camera.boardToScreen(pin.wx, pin.wy, this.a);
      if (at.x + radius < 0 || at.x - radius > camera.width) continue;
      if (at.y + radius < 0 || at.y - radius > camera.height) continue;

      clear();
      if (!drew) {
        ctx.strokeStyle = peer.color;
        ctx.lineWidth = PEER_WIDTH;
        drew = true;
      }
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    return drew;
  }

  /**
   * The cursors, and they go last — over every other transient on this canvas,
   * including the wet ink.
   *
   * A pointer is not part of the picture the board is making; it is the thing
   * pointing at it, and one that can be hidden behind a mark somebody is
   * drawing is a pointer you lose exactly when two people are working in the
   * same place.
   */
  cursors(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    peers: PeerSource,
    clear: () => void,
  ): boolean {
    let drew = false;
    for (const peer of peers.peers()) {
      const cursor = peer.cursor;
      if (cursor === null) continue;
      const at = camera.boardToScreen(cursor.x, cursor.y, this.a);
      // The tip is the anchor and the arrow hangs down and to the right of it,
      // so the reject is asymmetric — a cursor just off the left edge has
      // nothing on screen, one just off the right has its whole body off it.
      if (at.x + ARROW_REACH < 0 || at.x > camera.width) continue;
      if (at.y + ARROW_REACH < 0 || at.y > camera.height) continue;

      clear();
      drew = true;
      ctx.save();
      ctx.translate(at.x, at.y);

      ctx.beginPath();
      ctx.moveTo(ARROW[0]![0], ARROW[0]![1]);
      for (let i = 1; i < ARROW.length; i += 1) ctx.lineTo(ARROW[i]![0], ARROW[i]![1]);
      ctx.closePath();
      // Stroked first and filled over, so the ring sits half under the arrow
      // and the silhouette stays the size it was drawn at rather than growing
      // by half a line width all round.
      ctx.lineJoin = "round";
      ctx.lineWidth = ARROW_RING_WIDTH * 2;
      ctx.strokeStyle = ARROW_RING;
      ctx.stroke();
      ctx.fillStyle = peer.color;
      ctx.fill();

      ctx.font = LABEL_FONT;
      ctx.textBaseline = "alphabetic";
      ctx.lineWidth = LABEL_RING_WIDTH;
      ctx.lineJoin = "round";
      ctx.strokeStyle = LABEL_RING;
      ctx.strokeText(peer.name, LABEL_DX, LABEL_DY);
      ctx.fillStyle = LABEL_FILL;
      ctx.fillText(peer.name, LABEL_DX, LABEL_DY);
      ctx.restore();
    }
    return drew;
  }
}
