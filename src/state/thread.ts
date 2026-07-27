/**
 * Follow the thread — everything reachable from one pin.
 *
 * > | Follow the thread | Double-click | Selects the entire connected component
 * > of pins, strings and items | — DESIGN section 3.3
 *
 * > Double-clicking a pin selects the whole connected component, which is how
 * > you grab an entire thread of an investigation and move it somewhere else.
 * > — DESIGN section 3.8
 *
 * ## The graph
 *
 * Three kinds of node and two kinds of edge, and neither edge is stored as an
 * edge:
 *
 * - **pin ↔ string**, because a string's nodes name pins. Walked forwards
 *   through the run and backwards through `Scene.stringsThrough`.
 * - **pin ↔ item**, because a parented pin names the item it is pushed into.
 *   Walked forwards through `PinNode.parent` and backwards through
 *   `Scene.pinsOf`.
 *
 * There is deliberately no item ↔ item edge and no string ↔ string edge. Two
 * photographs are related only by something running between them, which is the
 * whole model: "strings attach to pins, never to items" (DESIGN section 2.3).
 *
 * ## Why an item pulls in its other pins
 *
 * A photograph held by two pins, one of which has a string on it, is one piece
 * of evidence — so reaching the photograph reaches its other pin, and anything
 * hanging off that. Stopping at the item instead would select a thread that
 * falls apart the moment it is dragged: the photograph would come and the pin
 * on its far side would stay, taking its string with it.
 *
 * That does mean a densely-strung board can hand back most of itself. That is
 * what a connected component *is*, and it is the honest answer — an arbitrary
 * hop limit would give a different selection depending on which pin of the same
 * thread you happened to double-click.
 *
 * ## Derived, never stored
 *
 * Computed per gesture and thrown away. There is nothing to invalidate, which
 * matters here more than it usually does: the component changes whenever any
 * string, pin or parent anywhere in it changes, including from a collaborator,
 * and a cached one would go quietly wrong rather than loudly.
 */

import type { Scene } from "@/state/scene";

export interface Thread {
  readonly items: ReadonlySet<string>;
  readonly strings: ReadonlySet<string>;
  readonly pins: ReadonlySet<string>;
}

/**
 * Everything connected to this pin, the pin included.
 *
 * A breadth-first walk over pins, since a pin is the only node type both edges
 * touch — items and strings are reached from one and never queued, so each is
 * visited exactly once and neither needs its own seen-set beyond the answer.
 *
 * An unknown pin gives three empty sets rather than throwing: a double-click
 * resolves the pin under the cursor a frame before this runs, and a
 * collaborator may have removed it in between.
 */
export function threadFrom(scene: Scene, from: string): Thread {
  const items = new Set<string>();
  const strings = new Set<string>();
  const pins = new Set<string>();
  if (!scene.pins.has(from)) return { items, strings, pins };

  // The queue is also the visited list — `pins` — so an index walks it rather
  // than shifting, and a component of two hundred pins is one array.
  const queue: string[] = [from];
  pins.add(from);

  for (let head = 0; head < queue.length; head++) {
    const pinId = queue[head]!;
    const pin = scene.pins.get(pinId);
    if (pin === undefined) continue;

    // Through the item this pin is pushed into, and out again to the other pins
    // holding it. A pin naming a parent that has gone is free-floating rather
    // than broken (DATA-MODEL section 8.1), so it simply has no item edge.
    if (pin.parent !== null && !items.has(pin.parent) && scene.has(pin.parent)) {
      items.add(pin.parent);
      for (const sibling of scene.pinsOf(pin.parent)) {
        if (pins.has(sibling)) continue;
        pins.add(sibling);
        queue.push(sibling);
      }
    }

    // Through the strings running off it, and along each one to its far pins.
    for (const stringId of scene.stringsThrough(pinId)) {
      if (strings.has(stringId)) continue;
      strings.add(stringId);
      const run = scene.strings.get(stringId);
      if (run === undefined) continue;
      for (const node of run.nodes) {
        // A run may name a pin that is gone — the renderer draws that as a gap
        // rather than as an error, and a selection must not hold the ghost.
        if (pins.has(node.pin) || !scene.pins.has(node.pin)) continue;
        pins.add(node.pin);
        queue.push(node.pin);
      }
    }
  }

  return { items, strings, pins };
}
