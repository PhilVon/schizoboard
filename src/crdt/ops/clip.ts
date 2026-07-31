/**
 * Taking a piece of the board away with you, and putting it down again.
 *
 * > Editing        Ctrl+V paste · Ctrl+C copy · Ctrl+X cut · Ctrl+Z undo
 * >                Delete remove · Ctrl+D duplicate — DESIGN section 3.9
 *
 * Copy, cut and duplicate are one operation read twice: **lift a subgraph out
 * as plain data, and build a fresh one from it somewhere else.** Cut is a copy
 * with the delete that already exists behind it; duplicate is a copy and a paste
 * with no clipboard in between. So this file has exactly two functions, and
 * everything else about the three shortcuts is a question of where the keystroke
 * arrives — `app/clipboard.ts`.
 *
 * ## Why plain data rather than document ids
 *
 * A clip is a snapshot, not a reference. What was copied can be deleted, moved,
 * restyled or taken away by a collaborator between the copy and the paste, and a
 * clipboard holding ids would then paste something that had changed since — or
 * nothing at all. It also has to survive being pasted *twice*, which a reference
 * to a thing that has since gone cannot.
 *
 * That is why the pin's `parent` becomes an **index into `items`** and a node's
 * pin becomes an **index into `pins`**: a clip is closed under its own
 * references, so nothing in it can dangle and nothing outside it is needed to
 * put it back.
 *
 * ## What comes with the selection, and what does not
 *
 * Items bring their pins (they are part of the paper), their text, their
 * overridden style and the ink drawn on them. Free pins come when
 * they were selected — the marquee and follow-the-thread both take them
 * (DESIGN section 3.8).
 *
 * **Strings are implied rather than selected.** A marquee deliberately leaves
 * the strings alone ("the strings ride along untouched" — `state/tools/select.ts`),
 * so copying only the *selected* strings would mean sweeping two strung notes
 * and pasting two notes with nothing between them, which is the one thing on
 * this board worth copying. The rule is instead structural: a string comes if
 * **every** pin it runs through is coming too. Anything else would paste a node
 * pointing at a pin that does not exist, which is precisely the dangling
 * reference `crdt/janitor.ts` exists to collect.
 *
 * The same rule, read the other way, is why a selected pin parented to an item
 * that is *not* in the selection is dropped: its frame is not coming, and the
 * alternatives are to invent a free pin at the world position — silently
 * changing what the user copied into a different kind of object — or to bring an
 * item they did not select.
 *
 * ## Poses are the document's, not the screen's
 *
 * An item hanging from a single pin is *drawn* at `rot + swing` about a shifted
 * centre (`sim/torsion.ts`), and neither number is in the document. A copy reads
 * the authored pose, so a duplicate of a swinging note appears at the angle the
 * note was authored at and starts swinging itself. That is the same choice
 * `createPin` documents for the same reason: the swing is local and transient,
 * and baking it in would mean two peers copying the same note got different
 * paper.
 */

import * as Y from "yjs";

import { freshId, mutate, type BoardDoc } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { pinsOfItems } from "@/crdt/ops/cascade";
import { registerAsset, type AssetInput } from "@/crdt/ops/items";
import { buildPin } from "@/crdt/ops/pins";
import { buildString } from "@/crdt/ops/strings";
import { highestZ } from "@/crdt/ops/z";
import {
  readAsset,
  readItem,
  readPin,
  readString,
  readStroke,
  type ItemType,
  type PinKind,
  type StringLayer,
  type StringMaterial,
  type StrokeTool,
  type YMap,
} from "@/crdt/schema";
import { keyAbove } from "@/crdt/zindex";
import type { ItemStyle } from "@/lib/style";

/** One committed stroke, carried by the bytes it is already stored as. */
export interface ClipStroke {
  readonly tool: StrokeTool;
  readonly color: string;
  readonly size: number;
  readonly opacity: number;
  readonly seed: number;
  readonly bbox: readonly [number, number, number, number];
  /** The packed points, copied — a clip never aliases the document it came
   *  from, or a paste would put the live bytes back in beside themselves. */
  readonly pts: Uint8Array;
}

export interface ClipItem {
  readonly type: ItemType;
  /** The item's centre, relative to the clip's anchor. */
  readonly dx: number;
  readonly dy: number;
  readonly w: number;
  readonly h: number;
  readonly rot: number;
  /**
   * Kept, not minted. The seed decides the paper stock, the ragged edge, the
   * grain and the scatter angle (`lib/seed.ts`), so a fresh one would make a
   * duplicate a *different sheet of paper* — which is not what either verb on
   * this file's first line means.
   */
  readonly seed: number;
  readonly assetId: string | null;
  /**
   * The asset's metadata, so a clip pasted into a board that has never seen
   * this photograph registers what it is. Bytes are content-addressed and
   * shared; within one board this is already there and the paste leaves it
   * alone.
   */
  readonly asset: AssetInput | null;
  readonly style: ItemStyle;
  readonly text: string;
  readonly strokes: readonly ClipStroke[];
}

export interface ClipPin {
  /** Index into the clip's `items`, or null for a pin free in the cork. */
  readonly parent: number | null;
  /** Item-local un-rotated when parented; relative to the anchor when free —
   *  the same two frames the document keeps a pin in (DATA-MODEL section 4). */
  readonly lx: number;
  readonly ly: number;
  readonly kind: PinKind;
  readonly color: string;
}

export interface ClipString {
  /** Indices into the clip's `pins`, in order. */
  readonly nodes: readonly number[];
  /** `slackAfter` per node, positionally. */
  readonly slack: readonly number[];
  readonly color: string;
  readonly thickness: number;
  readonly material: StringMaterial;
  readonly layer: StringLayer;
  readonly closed: boolean;
}

/** A piece of board, closed under its own references. */
export interface BoardClip {
  readonly items: readonly ClipItem[];
  readonly pins: readonly ClipPin[];
  readonly strings: readonly ClipString[];
  /**
   * Where the middle of this was when it was copied — everything above is
   * relative to it.
   *
   * Carried because `Ctrl+D` needs it: a duplicate goes down beside the
   * original rather than under the cursor, so the one thing it has to know is
   * where the original was. Nothing else reads it, and a paste that ignores it
   * is a paste that lands where the cursor is, which is the point.
   */
  readonly anchor: { readonly x: number; readonly y: number };
}

/**
 * What to copy. The item and pin halves of a selection — deliberately not
 * `SelectionSnapshot`, because `crdt/` does not import `state/`, and because
 * the string half is not an input: see the header.
 */
export interface ClipSelection {
  readonly items: readonly string[];
  readonly pins: readonly string[];
}

/** Where a paste put things. Every id is new. */
export interface PastedClip {
  readonly items: string[];
  /** Only the pins that landed in the cork — the parented ones travel inside
   *  their item and are not selectable members of anything (DESIGN 3.8). */
  readonly freePins: string[];
  readonly strings: string[];
}

/**
 * Lift a selection out of the document, or null if there was nothing in it this
 * board could carry.
 *
 * Reads and never writes, so it is safe from anywhere — including from a
 * `copy` event handler, which is not a frame and has no queue.
 */
export function copySubgraph(board: BoardDoc, selection: ClipSelection): BoardClip | null {
  const items = [];
  for (const id of selection.items) {
    const map = board.items.get(id);
    const fields = map ? readItem(id, map) : null;
    if (fields) items.push(fields);
  }
  // In stacking order, so that a paste rebuilds the pile the way it was found:
  // the ids arrive from a `Set` in selection order, which is the order things
  // were clicked.
  items.sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0));

  const itemAt = new Map(items.map((item, index) => [item.id, index]));

  // Every pin the copied paper owns, plus the free ones the user swept up. A
  // selected pin belonging to an item that is staying behind is dropped — see
  // the header.
  const pinIds = pinsOfItems(board, new Set(itemAt.keys()));
  const pins = [];
  for (const id of [...pinIds, ...selection.pins]) {
    const map = board.pins.get(id);
    const fields = map ? readPin(id, map) : null;
    if (!fields) continue;
    if (fields.parent !== null && !itemAt.has(fields.parent)) continue;
    pins.push(fields);
  }
  // `pinsOfItems` and the selection overlap on a followed thread, where the
  // selected pins *are* the items' pins.
  const pinAt = new Map<string, number>();
  const uniquePins = pins.filter((pin) => {
    if (pinAt.has(pin.id)) return false;
    pinAt.set(pin.id, pinAt.size);
    return true;
  });

  if (items.length === 0 && uniquePins.length === 0) return null;

  const anchor = anchorOf(items, uniquePins);

  const strings: ClipString[] = [];
  for (const [id, map] of board.strings) {
    const string = readString(id, map);
    // Invariant 3 at the other end: a run of one is not a string to copy, and
    // `buildString` would refuse it anyway.
    if (!string || string.nodes.length < 2) continue;
    const nodes = string.nodes.map((node) => pinAt.get(node.pin));
    if (nodes.some((index) => index === undefined)) continue;
    strings.push({
      nodes: nodes as number[],
      slack: string.nodes.map((node) => node.slackAfter),
      color: string.color,
      thickness: string.thickness,
      material: string.material,
      layer: string.layer,
      closed: string.closed,
    });
  }

  return {
    items: items.map((item) => ({
      type: item.type,
      dx: item.x - anchor.x,
      dy: item.y - anchor.y,
      w: item.w,
      h: item.h,
      rot: item.rot,
      seed: item.seed,
      assetId: item.assetId,
      asset: item.assetId === null ? null : assetInput(board, item.assetId),
      style: { ...item.style },
      text: textOf(board.items.get(item.id)),
      strokes: strokesOf(board.items.get(item.id)),
    })),
    pins: uniquePins.map((pin) => ({
      parent: pin.parent === null ? null : (itemAt.get(pin.parent) ?? null),
      lx: pin.parent === null ? pin.lx - anchor.x : pin.lx,
      ly: pin.parent === null ? pin.ly - anchor.y : pin.ly,
      kind: pin.kind,
      color: pin.color,
    })),
    strings,
    anchor,
  };
}

/**
 * Put a clip down with its anchor at `at`, as **one transaction**: one undo
 * entry, one update on the wire, however many notes and strings were in it.
 * The same rule `createItems` follows and for the same reason — pasting six
 * things is one thing the person did.
 *
 * Everything lands above everything already on the board, in the order it was
 * copied, because a paste you cannot see is a paste that did not happen.
 */
export function pasteClip(
  board: BoardDoc,
  clip: BoardClip,
  at: { x: number; y: number },
): PastedClip {
  return mutate(board, Origin.LOCAL_USER, () => {
    const now = Date.now();
    let z = highestZ(board);

    // Positional, and `null` for one that could not be written: the pins and
    // strings that refer to it by index have to be able to find that out.
    const itemIds: (string | null)[] = [];
    for (const clipped of clip.items) {
      const x = at.x + clipped.dx;
      const y = at.y + clipped.dy;
      // Invariant 1, the same guard and the same choice `createItems` makes: an
      // item nothing refers to yet costs only itself to refuse.
      if (![x, y, clipped.rot, clipped.w, clipped.h].every(Number.isFinite)) {
        itemIds.push(null);
        continue;
      }

      const id = freshId(board.items);
      z = keyAbove(z);
      const item = new Y.Map<unknown>();
      item.set("type", clipped.type);
      item.set("x", x);
      item.set("y", y);
      item.set("rot", clipped.rot);
      item.set("w", Math.max(1, clipped.w));
      item.set("h", Math.max(1, clipped.h));
      item.set("z", z);
      item.set("seed", clipped.seed);
      item.set("assetId", clipped.assetId);
      item.set("text", new Y.Text(clipped.text));
      const style = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(clipped.style)) style.set(key, value);
      item.set("style", style);
      const strokes = new Y.Map<YMap>();
      item.set("strokes", strokes);
      // A copy is a new object made now by whoever pressed the key — not a
      // record of who drew the original. Provenance of the *content* is the
      // asset hash's job and it is carried above.
      item.set("createdBy", board.doc.clientID);
      item.set("createdAt", now);
      board.items.set(id, item);

      // After the item is in the document rather than before: a nested type
      // written into while its parent is still detached is the one shape Yjs
      // has no answer for.
      let inkZ: string | null = null;
      for (const clippedStroke of clipped.strokes) {
        const stroke = new Y.Map<unknown>();
        stroke.set("tool", clippedStroke.tool);
        stroke.set("color", clippedStroke.color);
        stroke.set("size", clippedStroke.size);
        stroke.set("opacity", clippedStroke.opacity);
        stroke.set("seed", clippedStroke.seed);
        inkZ = keyAbove(inkZ);
        stroke.set("z", inkZ);
        stroke.set("bbox", [...clippedStroke.bbox]);
        // Sliced again on the way in, so two pastes of one clip do not share a
        // buffer between two documents' worth of history.
        stroke.set("pts", clippedStroke.pts.slice());
        strokes.set(freshId(strokes), stroke as YMap);
      }

      // `registerAsset` rather than a second copy of it. This was that second
      // copy, and it had already fallen a field behind (T-261).
      if (clipped.assetId && clipped.asset) {
        registerAsset(board, clipped.assetId, clipped.asset, now);
      }

      itemIds.push(id);
    }

    const pinIds: (string | null)[] = [];
    const freePins: string[] = [];
    for (const clipped of clip.pins) {
      const parent = clipped.parent === null ? null : itemIds[clipped.parent];
      // The item was refused, so the frame these coordinates are in does not
      // exist. `buildPin` would coerce rather than refuse — rightly, for a pin
      // whose parent is real — so the refusal has to happen here.
      if (parent === undefined || (clipped.parent !== null && parent === null)) {
        pinIds.push(null);
        continue;
      }
      const pin = buildPin(board, {
        parent,
        lx: parent === null ? at.x + clipped.lx : clipped.lx,
        ly: parent === null ? at.y + clipped.ly : clipped.ly,
        kind: clipped.kind,
        color: clipped.color,
      });
      board.pins.set(pin.id, pin.map);
      pinIds.push(pin.id);
      if (parent === null) freePins.push(pin.id);
    }

    const strings: string[] = [];
    for (const clipped of clip.strings) {
      const pins = clipped.nodes.map((index) => pinIds[index] ?? null);
      // All or nothing. A string that lost a pin to the guards above would be a
      // shorter string through the pins that survived, which is a different
      // object from the one that was copied.
      if (pins.some((pin) => pin === null)) continue;
      const built = buildString(board, {
        pins: pins as string[],
        slack: [...clipped.slack],
        color: clipped.color,
        thickness: clipped.thickness,
        material: clipped.material,
        layer: clipped.layer,
        closed: clipped.closed,
        createdBy: board.doc.clientID,
        createdAt: now,
      });
      if (!built) continue;
      board.strings.set(built.id, built.map);
      strings.push(built.id);
    }

    return {
      items: itemIds.filter((id): id is string => id !== null),
      freePins,
      strings,
    };
  });
}

/**
 * The middle of what was copied — the point a paste puts under the cursor.
 *
 * Centres and pin positions rather than the union of the items' corners: a
 * rotated sheet's corners are a different box from its centre's, and the
 * question this answers is "where was the middle of this", not "what did it
 * cover".
 */
function anchorOf(
  items: readonly { x: number; y: number }[],
  pins: readonly { parent: string | null; lx: number; ly: number }[],
): { x: number; y: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const see = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const item of items) see(item.x, item.y);
  for (const pin of pins) if (pin.parent === null) see(pin.lx, pin.ly);
  // Only parented pins were copied, so the items are the whole of it — and if
  // there were no items either, `copySubgraph` has already returned null.
  if (!Number.isFinite(minX)) return { x: 0, y: 0 };
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function textOf(item: YMap | undefined): string {
  const text = item?.get("text");
  return text instanceof Y.Text ? text.toString() : "";
}

function strokesOf(item: YMap | undefined): ClipStroke[] {
  const strokes = item?.get("strokes");
  if (!(strokes instanceof Y.Map)) return [];
  const out = [];
  for (const [id, map] of strokes as Y.Map<YMap>) {
    const stroke = readStroke(id, map);
    if (stroke) out.push(stroke);
  }
  // Ink stacks within the surface it is on, so the order matters and the map's
  // does not.
  out.sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0));
  return out.map((stroke) => ({
    tool: stroke.tool,
    color: stroke.color,
    size: stroke.size,
    opacity: stroke.opacity,
    seed: stroke.seed,
    bbox: [...stroke.bbox] as [number, number, number, number],
    pts: stroke.pts.slice(),
  }));
}

function assetInput(board: BoardDoc, sha256: string): AssetInput | null {
  const map = board.assets.get(sha256);
  const asset = map ? readAsset(sha256, map) : null;
  if (!asset) return null;
  return {
    w: asset.w,
    h: asset.h,
    mime: asset.mime,
    size: asset.size,
    ...(asset.origName ? { origName: asset.origName } : {}),
    // Carried, because a copied cassette is the same recording: re-deriving
    // this on the far side would mean holding the bytes, and the whole point
    // of the record is that it travels ahead of them.
    ...(asset.duration !== null ? { duration: asset.duration } : {}),
    ...(asset.pages !== null ? { pages: asset.pages } : {}),
  };
}
