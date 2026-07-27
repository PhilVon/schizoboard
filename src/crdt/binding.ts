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
import { readItem, readPin, readString, type YMap } from "@/crdt/schema";
import type { DirtySets } from "@/state/dirty";
import type { Scene } from "@/state/scene";

type DeepEvent = Y.YEvent<Y.AbstractType<unknown>>;

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
    for (const [id, map] of this.board.items) this.syncItem(id, map);
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
      if (this.scene.strings.delete(id)) this.dirty.string(id);
      return;
    }
    this.scene.strings.set(id, {
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
            if (map) this.syncItem(id, map);
          }
        }
        continue;
      }

      // Anything nested: the item's own map, its text, its style, its strokes.
      const id = event.path[0];
      if (typeof id !== "string") continue;
      const map = this.board.items.get(id);
      if (map) this.syncItem(id, map);
    }
  };

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
            // references (DESIGN section 3.4).
            this.scene.strings.delete(id);
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
