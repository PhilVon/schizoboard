/**
 * The geometry of the selection chrome — where the handles are, and what is
 * under the pointer.
 *
 * Two modules need the same answer and neither may own it. `render/overlay.ts`
 * draws the chrome; `state/tools/select.ts` decides what a press on it means. If
 * each worked its own geometry out, the day one of them changed the padding
 * would be the day the rotation handle stopped being where it looks.
 *
 * ## Screen space, and nothing else
 *
 * Every value here is CSS pixels. That is the whole reason the chrome moved off
 * the item nodes in T-91: a handle measured in board units is a slab at 400% zoom
 * and gone by 15%, and one you cannot reliably hit is worse than one that is not
 * drawn. So the box is converted through the camera up front and the handles are
 * laid out on the result.
 *
 * ## One item, or none
 *
 * > Drag an item to move it. Drag **its** rotation handle, or hold `R` and drag,
 * > to rotate. There is no resize handle on a polaroid — a photograph is the size
 * > it is — but notes, cards and scraps resize from their edges.
 * > — DESIGN section 3.2
 *
 * Singular, both times. Handles belong to an item, so they appear when exactly
 * one thing is selected; rotating a group stays on `R`+drag, which DESIGN offers
 * in the same breath. The alternative is a group bounding box to hang a group
 * handle off, and DESIGN describes no such box — inventing one would be adding a
 * piece of UI vocabulary to a board whose whole argument is that it has none.
 *
 * ## Nothing is drawn for a resize
 *
 * "Notes, cards and scraps resize from their edges" — the edge *is* the handle,
 * and eight little squares round a note would read as a UI element on a surface
 * that is trying very hard not to be one. That makes the cursor the only
 * affordance, which is why [`handleCursor`] is part of this module's job rather
 * than an afterthought somewhere else.
 */

import { carryScale } from "@/lib/carry";
import { rotateIn, rotateOut, type Point } from "@/lib/rotate";
import type { Camera, Vec2 } from "@/state/camera";
import type { Scene } from "@/state/scene";
import type { Selection } from "@/state/selection";

/**
 * The eight compass points are resize handles; `rotate` is the knob on its stalk.
 * Compass directions are in the item's **own** frame, so `n` is the edge towards
 * the top of the paper however the paper is turned.
 */
export type HandleId = "rotate" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** The selection outline's width, in CSS pixels at every zoom. */
export const SELECT_WIDTH = 1.5;
/**
 * Gap between the paper's edge and the inside of the line, then half the line —
 * so this is the distance out to its centre, which is what a stroke is measured
 * from. Both halves are CSS pixels and stay CSS pixels at every zoom.
 */
export const SELECT_PAD = 2.5 + SELECT_WIDTH / 2;

/** Screen pixels from the top of the chrome box out to the knob's centre. */
export const HANDLE_STALK = 26;
/** The knob as drawn. */
export const HANDLE_RADIUS = 4.5;
/**
 * The knob as grabbed — twice what it looks, because a 4.5 px target is a target
 * you miss. It is out in open cork with nothing to be confused with, so being
 * generous costs nothing.
 */
export const HANDLE_GRAB = 9;

/**
 * The resize band, measured from **the paper's own edge** — not from the outline
 * drawn a couple of pixels outside it, which is chrome and moves if the chrome
 * changes. Forgiving outwards into the cork, mean inwards.
 *
 * Asymmetric on purpose. A symmetric band deep enough to hit reliably eats a
 * ring out of the item's own drag area, and "I tried to move my note and it got
 * taller instead" is a much worse failure than "I missed the edge". Outwards
 * there is nothing to take the grab away from.
 */
export const EDGE_GRAB_OUT = 8;
export const EDGE_GRAB_IN = 4;

export interface HandleFrame {
  /** Screen centre of the box the chrome is drawn around. */
  cx: number;
  cy: number;
  /** Screen half-extents, already carrying the chrome padding and the carry scale. */
  hw: number;
  hh: number;
  /** The item's rendered angle — authored rotation plus its swing transient. */
  angle: number;
  /** Paper resizes from its edges; a photograph is the size it is. */
  resizable: boolean;
}

export function emptyFrame(): HandleFrame {
  return { cx: 0, cy: 0, hw: 0, hh: 0, angle: 0, resizable: false };
}

/** `boardToScreen` allocates otherwise, and this runs every frame. */
const scratch: Vec2 = { x: 0, y: 0 };
/** The same, for `handleAt`, which is asked on every pointer move. */
const probe: Point = { x: 0, y: 0 };

/**
 * The box the handles hang off, or null when the selection is not exactly one
 * item that is still on the board.
 *
 * `out` is filled and returned, so the per-frame callers can keep one.
 */
export function chromeFrame(
  camera: Camera,
  scene: Scene,
  selection: Selection,
  out: HandleFrame,
): HandleFrame | null {
  if (selection.size !== 1) return null;
  let id: string | null = null;
  for (const only of selection.members) id = only;
  if (id === null) return null;

  // A selection can name an item a collaborator has just deleted. `prune` tidies
  // that up, but not before this frame asks.
  const slot = scene.slotOf(id);
  if (slot === undefined) return null;

  const scale = carryScale(scene.lift[slot]!);
  const centre = camera.boardToScreen(scene.renderX(slot), scene.renderY(slot), scratch);
  out.cx = centre.x;
  out.cy = centre.y;
  out.hw = (scene.w[slot]! * camera.zoom * scale) / 2 + SELECT_PAD;
  out.hh = (scene.h[slot]! * camera.zoom * scale) / 2 + SELECT_PAD;
  out.angle = scene.renderRot(slot);
  out.resizable = scene.coldAt(slot)?.type !== "polaroid";
  return out;
}

/** Screen position of the rotation knob's centre: straight up out of the paper. */
export function rotateHandle(frame: HandleFrame, out: Vec2): Vec2 {
  return rotateOut(
    0,
    -(frame.hh + HANDLE_STALK),
    frame.cx,
    frame.cy,
    Math.cos(frame.angle),
    Math.sin(frame.angle),
    out,
  );
}

/** Indexed `(v + 1) * 3 + (u + 1)`, where u and v are the edge signs. */
const COMPASS: readonly (HandleId | null)[] = [
  "nw", "n", "ne",
  "w", null, "e",
  "sw", "s", "se",
];

/**
 * Which handle is at this screen point, if any.
 *
 * The knob is tested first and unconditionally: it sits outside the box, usually
 * over bare cork, and a press that reaches it must never fall through to the
 * marquee that the same press would otherwise start.
 */
export function handleAt(frame: HandleFrame, sx: number, sy: number): HandleId | null {
  // Into the item's own frame, so "the top edge" means the top of the paper
  // rather than the top of the screen.
  const local = rotateIn(
    sx,
    sy,
    frame.cx,
    frame.cy,
    Math.cos(frame.angle),
    Math.sin(frame.angle),
    probe,
  );
  const lx = local.x;
  const ly = local.y;

  const ky = ly + frame.hh + HANDLE_STALK;
  if (lx * lx + ky * ky <= HANDLE_GRAB * HANDLE_GRAB) return "rotate";

  if (!frame.resizable) return null;

  // Signed distance out from each edge of the paper: positive outside it. The
  // frame's half-extents are the *outline's*, which stands `SELECT_PAD` further
  // out, so that comes back off before the band is measured.
  const ex = Math.abs(lx) - (frame.hw - SELECT_PAD);
  const ey = Math.abs(ly) - (frame.hh - SELECT_PAD);
  if (ex > EDGE_GRAB_OUT || ey > EDGE_GRAB_OUT) return null;

  const u = ex >= -EDGE_GRAB_IN ? (lx < 0 ? -1 : 1) : 0;
  const v = ey >= -EDGE_GRAB_IN ? (ly < 0 ? -1 : 1) : 0;
  return COMPASS[(v + 1) * 3 + (u + 1)] ?? null;
}

/**
 * Which way a resize handle pushes, in the item's own un-rotated frame: `+1`
 * grows that axis towards positive local coordinates, `-1` towards negative, `0`
 * leaves the axis alone.
 */
export function handleAxes(handle: HandleId): { u: number; v: number } {
  return AXES[handle];
}

const AXES: Record<HandleId, { u: number; v: number }> = {
  rotate: { u: 0, v: 0 },
  n: { u: 0, v: -1 },
  s: { u: 0, v: 1 },
  e: { u: 1, v: 0 },
  w: { u: -1, v: 0 },
  ne: { u: 1, v: -1 },
  nw: { u: -1, v: -1 },
  se: { u: 1, v: 1 },
  sw: { u: -1, v: 1 },
};

/**
 * Screen angle of each handle's outward normal, y-down, zero pointing right.
 * Only the four resize cursors exist and they repeat every 180 degrees, so this
 * is all the cursor picker needs.
 */
const NORMAL: Record<string, number> = {
  e: 0,
  se: Math.PI / 4,
  s: Math.PI / 2,
  sw: (3 * Math.PI) / 4,
  w: Math.PI,
  nw: (-3 * Math.PI) / 4,
  n: -Math.PI / 2,
  ne: -Math.PI / 4,
};

/** Indexed by eighth-turns of the normal's screen angle, and they repeat at 4. */
const RESIZE_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const;

/**
 * The CSS cursor for a handle on an item turned to `angle`.
 *
 * Rotated with the item, which is the point: the east edge of a note lying at 45°
 * points southeast, and a cursor claiming otherwise is worse than no cursor,
 * because it says the resize will go a way it will not.
 *
 * There is no rotate cursor in CSS. `grab` is the closest honest thing — it says
 * "this is a thing you take hold of", and the knob's shape says the rest.
 */
export function handleCursor(handle: HandleId, angle: number): string {
  if (handle === "rotate") return "grab";
  const eighths = Math.round((NORMAL[handle]! + angle) / (Math.PI / 4)) & 3;
  return RESIZE_CURSORS[eighths]!;
}
