/**
 * The only module in the codebase that subscribes to Yjs events.
 *
 * > `crdt/binding.ts` is the sole translator. It is the only file in the
 * > codebase that subscribes to Yjs events. — docs/ARCHITECTURE.md section 2.1
 *
 * Everything downstream — `sim/`, `render/`, the tools — reads the plain scene
 * mirror. This is the hinge of the one-way flow:
 *
 *     interaction -> crdt/ops -> Y.Doc -> observer -> binding -> Scene -> render
 *
 * Keeping it to one file is what makes that flow checkable by reading a single
 * import list rather than by grepping for `observe`.
 *
 * ## Why a change re-reads the whole entity
 *
 * A field-by-field patch would need a switch over every key, and a key added
 * later would be silently ignored — a class of bug that presents as "this one
 * property doesn't sync" months afterwards. Re-reading is a dozen map lookups
 * against an in-memory structure, and it runs when something actually changed,
 * not per frame.
 */

import * as Y from "yjs";

import type { BoardDoc } from "@/crdt/doc";
import { readItem, readPin, readStroke, readString, type YMap } from "@/crdt/schema";
import type { InkSample } from "@/lib/ink";
import { unpackStroke } from "@/lib/strokepack";
import type { DirtySets } from "@/state/dirty";
import type { Scene, SceneStroke } from "@/state/scene";

type DeepEvent = Y.YEvent<Y.AbstractType<unknown>>;

/**
 * The box round a stroke's points, measured here rather than read out of the
 * record — see `SceneStroke.bbox` for why the stored one is not trusted.
 */
function boundsOfSamples(
  samples: readonly InkSample[],
): readonly [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of samples) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return [x0, y0, x1, y1];
}

export class Binding {
  private readonly board: BoardDoc;
  private readonly scene: Scene;
  private readonly dirty: DirtySets;
  private started = false;

  constructor(board: BoardDoc, scene: Scene, dirty: DirtySets) {
    this.board = board;
    this.scene = scene;
    this.dirty = dirty;
  }

  /** Mirror the whole document, then follow it. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.resync();
    this.board.items.observeDeep(this.onItems);
    this.board.pins.observeDeep(this.onPins);
    this.board.strings.observeDeep(this.onStrings);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.board.items.unobserveDeep(this.onItems);
    this.board.pins.unobserveDeep(this.onPins);
    this.board.strings.unobserveDeep(this.onStrings);
  }

  /**
   * Rebuild the mirror from scratch. Used on load, and available for the
   * cases where computing a precise delta costs more than redrawing —
   * DirtySets.everything() exists for exactly this.
   */
  resync(): void {
    this.scene.clear();
    for (const [id, map] of this.board.items) {
      this.syncItem(id, map);
      this.syncStrokes(id);
    }
    for (const [id, map] of this.board.pins) this.syncPin(id, map);
    for (const [id, map] of this.board.strings) this.syncString(id, map);
    this.scene.layoutPins();
    this.dirty.everything();
  }

  private syncItem(id: string, map: YMap): void {
    const fields = readItem(id, map);
    if (!fields) {
      // An item nobody can make sense of is skipped, not repaired. Repair on
      // read causes write storms in a shared session (DATA-MODEL section 8.1).
      if (this.scene.removeItem(id)) this.dirty.item(id);
      return;
    }

    const text = map.get("text");
    this.scene.putItem(
      {
        id,
        type: fields.type,
        z: fields.z,
        seed: fields.seed,
        assetId: fields.assetId,
        createdBy: fields.createdBy,
        createdAt: fields.createdAt,
        text: text instanceof Y.Text ? text.toString() : "",
      },
      { x: fields.x, y: fields.y, rot: fields.rot, w: fields.w, h: fields.h },
    );
    this.dirty.item(id);
  }

  private syncPin(id: string, map: YMap): void {
    const fields = readPin(id, map);
    if (!fields) {
      if (this.scene.removePin(id)) this.dirty.pin(id);
      return;
    }
    const existing = this.scene.pins.get(id);
    this.scene.putPin({
      id,
      parent: fields.parent,
      lx: fields.lx,
      ly: fields.ly,
      kind: fields.kind,
      color: fields.color,
      // Keep the last known world position until LAYOUT recomputes it, so a
      // pin never flashes at the origin for one frame.
      wx: existing?.wx ?? fields.lx,
      wy: existing?.wy ?? fields.ly,
    });
    this.dirty.pin(id);
    if (fields.parent !== null) this.dirty.item(fields.parent);
    // The item it *left*, too. Dragging a pin off a photograph does not move
    // the photograph, so this looks like nothing for now — but pin count is
    // that photograph's physics (DESIGN section 2.2), and an item that just
    // went from one pin to none has stopped hanging and has to be told.
    if (existing && existing.parent !== null && existing.parent !== fields.parent) {
      this.dirty.item(existing.parent);
    }
  }

  /**
   * A string's run and style, mirrored for `sim/ropes.ts` to build segments
   * from.
   *
   * The nodes are copied out into plain objects rather than referenced,
   * because a `Y.Array` reaching the scene would put a CRDT type on the far
   * side of the wall the scene exists to be — and because the rope set
   * compares runs to decide whether to re-seed, which needs a snapshot rather
   * than a live view of the thing it is comparing against.
   *
   * Invariant 3 is applied here rather than downstream: a run of fewer than
   * two *valid* nodes is not a string anyone can draw, and `readStringNodes`
   * has already dropped the nodes whose `pin` field is malformed. The document
   * deletes such a string itself (DATA-MODEL section 5.3); until that lands,
   * this simply does not mirror it.
   */
  private syncString(id: string, map: YMap): void {
    const fields = readString(id, map);
    if (!fields || fields.nodes.length < 2) {
      if (this.scene.removeString(id)) this.dirty.string(id);
      return;
    }
    this.scene.putString({
      id,
      nodes: fields.nodes.map((node) => ({
        nodeId: node.nodeId,
        pin: node.pin,
        slackAfter: node.slackAfter,
      })),
      color: fields.color,
      thickness: fields.thickness,
      material: fields.material,
      layer: fields.layer,
      closed: fields.closed,
    });
    this.dirty.string(id);
  }

  private readonly onItems = (events: DeepEvent[]): void => {
    for (const event of events) {
      if (event.target === (this.board.items as unknown as Y.AbstractType<unknown>)) {
        for (const [id, change] of event.changes.keys) {
          if (change.action === "delete") {
            if (this.scene.removeItem(id)) this.dirty.item(id);
            // Pins are top-level and are removed by their own cascade; a pin
            // left dangling here is rendered free-floating, not cleaned up.
          } else {
            const map = this.board.items.get(id);
            if (map) {
              this.syncItem(id, map);
              // An item arriving already has its ink — a paste, a peer's create,
              // and the undo of a delete, which is the case that matters: the
              // strokes come back inside the item's map in the same entry, and
              // nothing below this line would otherwise notice.
              this.syncStrokes(id);
            }
          }
        }
        continue;
      }

      const id = event.path[0];
      if (typeof id !== "string") continue;
      /**
       * Ink is the one nested thing under an item that does not go through
       * `syncItem`, and the split is load-bearing rather than tidy.
       *
       * `syncItem` re-reads the whole entity, which is the right rule for the
       * item's own fields and its text — see the note at the top of this file.
       * Applied to ink it would decode every stroke on the item on every event
       * that touched it, and the event that touches an item most is a drag: an
       * annotated photograph moved across the board would unpack all of its ink
       * sixty times a second for a change to `x` and `y`.
       *
       * The other half is which dirty set it raises. A change to an item's ink
       * cannot move the item, so it must not raise `dirty.item` — `render/cull.ts`
       * says so in as many words ("ink and rope dirt cannot move an item, so
       * they cannot change the answer"), and raising it would re-cull and
       * re-write a transform for a stroke.
       */
      if (event.path[1] === "strokes") {
        this.syncStrokes(id);
        continue;
      }
      // Anything else nested: the item's own map, its text, its style.
      const map = this.board.items.get(id);
      if (map) this.syncItem(id, map);
    }
  };

  /**
   * Re-read one item's ink.
   *
   * The whole collection, not the one stroke that changed: a stroke is
   * immutable once written (DATA-MODEL section 6.2 — the only edits are adding
   * and removing whole records), so "which strokes does this item have" is the
   * only question worth asking, and asking it wholesale is what makes a removal
   * land without a second code path.
   *
   * The unpack happens here rather than in the renderer. It runs once per edit;
   * in the renderer it would run again for every item on every debounced
   * zoom-end. See `SceneStroke`.
   */
  private syncStrokes(id: string): void {
    const item = this.board.items.get(id);
    const map = item?.get("strokes");
    if (!(map instanceof Y.Map)) {
      this.scene.putStrokes(id, []);
      this.dirty.inkFor(id);
      return;
    }

    const strokes: SceneStroke[] = [];
    for (const [strokeId, record] of map as Y.Map<YMap>) {
      const fields = readStroke(strokeId, record);
      // A stroke nobody can make sense of is skipped, not repaired — the same
      // rule the rest of this file follows (DATA-MODEL section 8.1).
      if (!fields) continue;
      const samples = unpackStroke(fields.pts);
      if (samples.length === 0) continue;
      strokes.push({
        id: strokeId,
        tool: fields.tool,
        color: fields.color,
        size: fields.size,
        opacity: fields.opacity,
        seed: fields.seed,
        z: fields.z,
        // Measured, not the record's — see `SceneStroke`.
        bbox: boundsOfSamples(samples),
        samples,
      });
    }

    this.scene.putStrokes(id, strokes);
    this.dirty.inkFor(id);
  }

  /**
   * Any change anywhere inside `strings` re-reads the string it happened in.
   *
   * `event.path[0]` is the string id for everything nested — the nodes array,
   * one node's slack, the style fields — because `strings` is a map keyed by
   * string id and nothing below it is addressed any other way. So a slack
   * nudge and a whole run being rewritten take the same path, which is the
   * "re-read the whole entity" argument in the module comment applied to the
   * one type here that has a nested collection.
   */
  private readonly onStrings = (events: DeepEvent[]): void => {
    for (const event of events) {
      if (event.target === (this.board.strings as unknown as Y.AbstractType<unknown>)) {
        for (const [id, change] of event.changes.keys) {
          if (change.action === "delete") {
            // The pins stay exactly where they are — a string owns nothing but
            // references (DESIGN section 3.4). What goes is the run and its
            // entries in the pin index, which is what `removeString` is for.
            this.scene.removeString(id);
            this.dirty.string(id);
          } else {
            const map = this.board.strings.get(id);
            if (map) this.syncString(id, map);
          }
        }
        continue;
      }

      const id = event.path[0];
      if (typeof id !== "string") continue;
      const map = this.board.strings.get(id);
      if (map) this.syncString(id, map);
    }
  };

  private readonly onPins = (events: DeepEvent[]): void => {
    for (const event of events) {
      if (event.target === (this.board.pins as unknown as Y.AbstractType<unknown>)) {
        for (const [id, change] of event.changes.keys) {
          if (change.action === "delete") {
            const gone = this.scene.pins.get(id);
            this.scene.removePin(id);
            this.dirty.pin(id);
            if (gone?.parent) this.dirty.item(gone.parent);
          } else {
            const map = this.board.pins.get(id);
            if (map) this.syncPin(id, map);
          }
        }
        continue;
      }

      const id = event.path[0];
      if (typeof id !== "string") continue;
      const map = this.board.pins.get(id);
      if (map) this.syncPin(id, map);
    }
  };
}
