/**
 * The schema contract, as types and typed readers.
 *
 * `docs/DATA-MODEL.md` is the authority; this file is its transcription. It
 * imports nothing from `render/` or `sim/` and never will.
 *
 * ## The governing rule (DATA-MODEL section 1)
 *
 * > A field is a CRDT type only if two people can meaningfully edit different
 * > parts of it at the same time. Everything else is a plain value inside a
 * > `Y.Map`, so it gets clean last-write-wins.
 *
 * So `text` is a `Y.Text` — two people can type into the same note and both
 * edits should survive. `x` is a plain number — two concurrent drags must
 * resolve to one position or the other, because merging them would put the
 * item somewhere neither person moved it.
 *
 * ## Why the readers are defensive
 *
 * A CRDT document can contain anything any version of any client ever wrote,
 * including an older schema and including a peer with a bug. DATA-MODEL
 * section 8.1 sets the policy: **dangling and malformed data is tolerated and
 * rendered gracefully, never repaired on read**, because repair-on-read causes
 * write storms in a shared session. These readers coerce and clamp; they never
 * write, and they never throw.
 */

import * as Y from "yjs";

export const SCHEMA_VERSION = 1;

export type ItemType = "polaroid" | "note" | "scrap" | "card";
export type PinKind = "pushpin" | "thumbtack" | "nail";
export type StringLayer = "over" | "under";
export type StringMaterial = "string" | "yarn" | "wire";
export type StrokeTool = "marker" | "highlighter" | "erase";

const ITEM_TYPES: ReadonlySet<string> = new Set(["polaroid", "note", "scrap", "card"]);
const PIN_KINDS: ReadonlySet<string> = new Set(["pushpin", "thumbtack", "nail"]);

/** Invariant 6 — merging never produces an item with zero or negative size. */
export const MIN_ITEM_SIZE = 1;
/** Invariant 2 — slack is strictly greater than zero, clamped to a minimum. */
export const MIN_SLACK = 0.01;

export interface Crop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface ItemFields {
  id: string;
  type: ItemType;
  /** Board coordinates of the item's **centre**. */
  x: number;
  y: number;
  /** Authored rotation, radians. The physics swing is never stored here. */
  rot: number;
  w: number;
  h: number;
  z: string;
  seed: number;
  assetId: string | null;
  crop: Crop | null;
  createdBy: number;
  createdAt: number;
}

export interface PinFields {
  id: string;
  /** `null` means free-floating in the cork. The source of truth for ownership. */
  parent: string | null;
  /** Item-local and **un-rotated** when parented; board coordinates when free. */
  lx: number;
  ly: number;
  kind: PinKind;
  color: string;
  createdBy: number;
  createdAt: number;
}

export interface StringNodeFields {
  nodeId: string;
  pin: string;
  /**
   * Ratio, not a length: `restLength = chord * (1 + slackAfter)`.
   * Undefined in meaning on the terminal node of an open string.
   */
  slackAfter: number;
}

export interface StringFields {
  id: string;
  nodes: StringNodeFields[];
  color: string;
  thickness: number;
  material: StringMaterial;
  layer: StringLayer;
  closed: boolean;
  createdBy: number;
  createdAt: number;
}

export interface AssetFields {
  sha256: string;
  w: number;
  h: number;
  mime: string;
  size: number;
  origName: string;
  addedBy: number;
  addedAt: number;
}

// --- coercion -------------------------------------------------------------

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readCrop(value: unknown): Crop | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Partial<Crop>;
  if (
    !Number.isFinite(c.sx) ||
    !Number.isFinite(c.sy) ||
    !Number.isFinite(c.sw) ||
    !Number.isFinite(c.sh)
  ) {
    return null;
  }
  return { sx: c.sx!, sy: c.sy!, sw: c.sw!, sh: c.sh! };
}

// --- readers --------------------------------------------------------------

export type YMap = Y.Map<unknown>;

/**
 * Returns null for an entry with no usable identity or geometry. The caller
 * skips it — which is what "rendered gracefully" means for an item whose
 * shape nobody recognises.
 */
export function readItem(id: string, map: YMap): ItemFields | null {
  const type = map.get("type");
  if (typeof type !== "string" || !ITEM_TYPES.has(type)) return null;
  const z = map.get("z");
  if (typeof z !== "string" || z.length === 0) return null;

  return {
    id,
    type: type as ItemType,
    x: num(map.get("x"), 0),
    y: num(map.get("y"), 0),
    rot: num(map.get("rot"), 0),
    // Clamped rather than rejected: an item with a nonsense size should still
    // be grabbable and deletable, not invisible.
    w: Math.max(MIN_ITEM_SIZE, num(map.get("w"), MIN_ITEM_SIZE)),
    h: Math.max(MIN_ITEM_SIZE, num(map.get("h"), MIN_ITEM_SIZE)),
    z,
    seed: num(map.get("seed"), 0) >>> 0,
    assetId: typeof map.get("assetId") === "string" ? (map.get("assetId") as string) : null,
    crop: readCrop(map.get("crop")),
    createdBy: num(map.get("createdBy"), 0),
    createdAt: num(map.get("createdAt"), 0),
  };
}

export function readPin(id: string, map: YMap): PinFields | null {
  const parent = map.get("parent");
  if (parent !== null && typeof parent !== "string") return null;
  const kind = str(map.get("kind"), "pushpin");

  return {
    id,
    parent: parent ?? null,
    lx: num(map.get("lx"), 0),
    ly: num(map.get("ly"), 0),
    kind: (PIN_KINDS.has(kind) ? kind : "pushpin") as PinKind,
    color: str(map.get("color"), "#c8352f"),
    createdBy: num(map.get("createdBy"), 0),
    createdAt: num(map.get("createdAt"), 0),
  };
}

/**
 * Nodes whose `pin` is missing or malformed are dropped here rather than
 * rendered — invariant 4, "every node's pin either resolves or is skipped
 * cleanly". Whether what remains is still a string is the caller's business
 * (invariant 3 wants two valid nodes).
 */
export function readStringNodes(array: Y.Array<YMap>): StringNodeFields[] {
  const out: StringNodeFields[] = [];
  for (const node of array) {
    const pin = node.get("pin");
    const nodeId = node.get("nodeId");
    if (typeof pin !== "string" || typeof nodeId !== "string") continue;
    out.push({
      nodeId,
      pin,
      slackAfter: Math.max(MIN_SLACK, num(node.get("slackAfter"), 0.12)),
    });
  }
  return out;
}

export function readString(id: string, map: YMap): StringFields | null {
  const nodesArray = map.get("nodes");
  if (!(nodesArray instanceof Y.Array)) return null;
  const nodes = readStringNodes(nodesArray as Y.Array<YMap>);

  return {
    id,
    nodes,
    // The default is a slightly desaturated cotton red: saturated red on brown
    // cork vibrates unpleasantly (DESIGN section 4.6).
    color: str(map.get("color"), "#a8322c"),
    thickness: Math.max(0.5, num(map.get("thickness"), 3)),
    material: str(map.get("material"), "string") as StringMaterial,
    layer: map.get("layer") === "under" ? "under" : "over",
    closed: bool(map.get("closed"), false),
    createdBy: num(map.get("createdBy"), 0),
    createdAt: num(map.get("createdAt"), 0),
  };
}

export function readAsset(sha256: string, map: YMap): AssetFields | null {
  const w = num(map.get("w"), 0);
  const h = num(map.get("h"), 0);
  if (w <= 0 || h <= 0) return null;
  return {
    sha256,
    w,
    h,
    mime: str(map.get("mime"), "application/octet-stream"),
    size: num(map.get("size"), 0),
    origName: str(map.get("origName"), ""),
    addedBy: num(map.get("addedBy"), 0),
    addedAt: num(map.get("addedAt"), 0),
  };
}

/**
 * Does a string still have enough valid nodes to be a string?
 * Invariant 3 — "no string survives with fewer than two valid nodes".
 */
export function isRenderableString(nodes: readonly StringNodeFields[], pins: ReadonlySet<string>): boolean {
  let valid = 0;
  for (const node of nodes) {
    if (pins.has(node.pin)) valid++;
    if (valid >= 2) return true;
  }
  return false;
}
