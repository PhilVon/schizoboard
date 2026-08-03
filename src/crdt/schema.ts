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

import { isHash } from "@/crdt/sync/assets";
import { assetKind, type AssetKind, type SourceAbout } from "@/lib/objects";
import {
  isItemFace,
  isPaperStock,
  NO_STYLE,
  TAPE_ALL,
  TAPE_NONE,
  type ItemFace,
  type ItemStyle,
  type PaperStock,
} from "@/lib/style";

export const SCHEMA_VERSION = 1;

/**
 * Two of these four cannot be created, and both facts are decisions.
 *
 * `scrap` is what DESIGN section 2.1 calls a blank sheet, and the note tool
 * makes one — as a `note` with no text in it, which is what the section says a
 * scrap is. `card` was struck from that section's archetype table on Q-179: an
 * index card is a *stock*, and any sheet's Paper strip will give you one.
 *
 * Both stay in the union anyway, and that is the point rather than the
 * leftover. `readItem` returns `undefined` for a type it does not know, so a
 * board written by anything that ever made one would lose the item rather than
 * keep a sheet of paper. A type is cheap to keep accepting and expensive to
 * stop.
 */
export type ItemType = "polaroid" | "note" | "scrap" | "card";
/**
 * `tape` is the odd one and the oddness is deliberate — Q-286.
 *
 * The other three are objects pushed into the board, and DESIGN section 2.2
 * builds the item's physics on exactly that: zero pins and it lies loose, one
 * and it hangs, two and it is rigid. A piece of tape is stuck to the *paper*
 * and to nothing else, so it holds a string to a page without holding the page
 * to the wall — and it therefore does **not** count toward that physics
 * (`Scene.pinCount`, which is where the exception lives).
 *
 * It is a pin kind rather than a new kind of string anchor because everything
 * else about it is a pin: a string runs to it, it is dragged, it is cut, a
 * citation tab hangs off it (T-284) and following a thread back lands on it
 * (T-285). D-1's "strings attach to pins, never to items" is the sentence that
 * would have to be given up otherwise, and giving it up costs a schema change
 * to `StringNodeFields` that an older build answers by dropping the node — and
 * with it the thread, which is the data-loss shape D-46 section 2 refused a new
 * item type over.
 *
 * An older build reads a kind it does not know and falls back to `pushpin`
 * below, so it draws a pinhead where this one draws tape. That is a wrong
 * picture rather than a lost card, which is the trade this union is chosen for.
 */
export type PinKind = "pushpin" | "thumbtack" | "nail" | "tape";
export type StringLayer = "over" | "under";
export type StringMaterial = "string" | "yarn" | "wire";
export type StrokeTool = "marker" | "highlighter" | "erase";

const ITEM_TYPES: ReadonlySet<string> = new Set(["polaroid", "note", "scrap", "card"]);
/**
 * The kinds, as a list, so the renderer's own copy of the union can be held
 * against this one — `tests/pin-kinds.test.ts`. `render/` does not import from
 * `crdt/`, so the two declarations are separate by design and a kind added here
 * and not there bakes a sprite of `NaN` pixels without a word.
 */
export const PIN_KIND_NAMES: readonly PinKind[] = ["pushpin", "thumbtack", "nail", "tape"];
const PIN_KINDS: ReadonlySet<string> = new Set(PIN_KIND_NAMES);
const STROKE_TOOLS: ReadonlySet<string> = new Set(["marker", "highlighter", "erase"]);

/** Invariant 6 — merging never produces an item with zero or negative size. */
export const MIN_ITEM_SIZE = 1;
/** The same clamp for a nib: a stroke of zero width is one nobody can erase. */
export const MIN_STROKE_SIZE = 0.25;
/** Invariant 2 — slack is strictly greater than zero, clamped to a minimum. */
export const MIN_SLACK = 0.01;

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
  /**
   * Where this came from, when it came from somewhere on the web — T-290,
   * Q-305.
   *
   * A pasted link becomes an object *about* a page, and the one thing such an
   * object owes anybody is the way back to the page. That address is written in
   * its caption too, and the caption is not good enough to open: it is text the
   * person can edit, so the link would be destroyed by rewriting the words
   * around it. Q-305 chose the field for that reason.
   *
   * **Null for almost everything, and that is the shape rather than an
   * omission.** A photograph somebody pasted came from their clipboard, a note
   * came from their hands, and a case file came from a disk — none of them has
   * a source in this sense. Only an object standing in for something that could
   * not be brought onto the board has one.
   *
   * It crosses the wire like any other field, so a peer can open the link too;
   * that is what makes it a field rather than something local.
   */
  source: string | null;
  /**
   * What the page at `source` was about — `lib/objects.ts`'s `SourceAbout`,
   * which is where the decision is written down (T-342).
   *
   * Never null and never absent to a reader: an item with no `source` at all
   * reads `page`, which costs nothing because nothing asks this of an item that
   * did not come from somewhere. Written to the map only when it is `media`, the
   * way `source` itself is written only when there is one — a key holding the
   * default on every item ever created is a key nobody can read anything from.
   */
  sourceAbout: SourceAbout;
  /**
   * What has been overridden of what the seed would decide — `lib/style.ts`.
   *
   * Always an object, never null, and `{}` for the overwhelming majority of
   * items. That asymmetry is deliberate: a null would make every reader ask
   * "chosen nothing, or not read yet?", and the answer is always the first.
   */
  style: ItemStyle;
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
  /**
   * Which page of the parent's document this pin is stuck to, or null for a pin
   * in the object itself — T-330, and the exact counterpart of
   * [`StrokeFields.page`].
   *
   * Null is every pin this application has ever written until now, and — as
   * with a mark — it is an answer rather than a missing one: a pushpin through a
   * photograph, through a sheet of paper and through the *cover* of a shut case
   * file are all the same thing, and none of them belongs to anything narrower
   * than the item. A number means the tape was stuck to a page that was on show,
   * so it goes inside the folder when it shuts and comes back when it is turned
   * to that page again.
   *
   * In practice it is a `tape`'s field, because tape is the only thing this
   * board sticks to a page (Q-286) — but it is declared on the pin rather than
   * on the kind, for the reason ink declares it on the stroke rather than on the
   * tool. It says *where the pin is*, and where a pin is has never depended on
   * what sort of pin it is.
   *
   * It is not the reader's position: `app/pages.ts` keeps which page **you** are
   * on local and off the wire, and this is a durable property of the pin, as
   * durable as its own coordinates. One-based, so a stored 0 reads as the absent
   * field it almost certainly is.
   */
  page: number | null;
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

/**
 * One committed stroke — DATA-MODEL section 6, and the same shape whether it is
 * nested under an item or under a board-ink tile.
 *
 * `pts` is the packed input points and nothing else: "store input points, never
 * the generated outline" (section 6.1), because the outline cannot be re-tuned
 * when the taper and thinning numbers in `render/ink/geometry.ts` are revisited.
 * `lib/strokepack.ts` is the codec at both ends.
 *
 * `bbox` is in the stroke's own space and is stored so that a tile can cull and
 * hit-test without unpacking. It is the box round the *points*, not round the
 * paint — a nib has width, and padding it is the reader's job because only the
 * reader knows whether it is asking about the path or the ink.
 */
export interface StrokeFields {
  id: string;
  tool: StrokeTool;
  color: string;
  /** Board units, which are item-local units too — the same scale. */
  size: number;
  /** 0 to 1. */
  opacity: number;
  seed: number;
  z: string;
  bbox: readonly [number, number, number, number];
  pts: Uint8Array;
  /**
   * Which page of the item's document this mark is on, or null for a mark on
   * the object itself — T-278.
   *
   * Null is every stroke this application has ever written until now, and it is
   * an answer rather than a missing one: a photograph, a sheet of paper and the
   * *cover* of a shut case file are all one surface, and a mark on one of them
   * belongs to the item and nothing narrower. A number means the item was open
   * at that page when the hand came down, and the mark is on the page rather
   * than on the folder holding it — so it goes away when the folder shuts and
   * comes back when it is turned to that page again.
   *
   * **It is not the reader's position and must not be confused with it.**
   * `app/pages.ts` keeps which page *you* are on deliberately local and off the
   * wire, for the reason the camera came off awareness (T-226). This is a
   * different fact about a different thing: where a mark was made, which is a
   * property of the mark and as durable as its own coordinates.
   *
   * One-based, like everything else that counts pages on this board, so that a
   * stored 0 reads as the absent field it almost certainly is.
   */
  page: number | null;
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
  /** Derived from `mime`; see [`assetKind`]. Never read off the map. */
  kind: AssetKind;
  /**
   * Seconds, for a film or a cassette. `null` for everything else and for a
   * container the shell could not read.
   *
   * Read once at ingest by the machine holding the file (T-300), because the
   * item reaches a peer long before the bytes do — the spine of a cassette has
   * to say something while a 400 MB interview is still transferring.
   *
   * A stored zero reads back as `null` on purpose. Nothing this build writes
   * can produce one, and a J-card reading `0:00` is a claim that the tape is
   * empty, which is a worse thing to say than nothing.
   */
  duration: number | null;
  /** Pages, for a document. `null` when it is not one or nobody has counted. */
  pages: number | null;
  /**
   * The still that stands for a film — itself an asset, named by its own hash
   * (T-270). `null` for every other kind, and for a film nobody has grabbed one
   * off yet.
   *
   * A hash rather than the bytes, so a poster dedupes, transfers and is
   * collected on the one path every other picture on this board already uses:
   * two people pasting the same interview grab the same frame and produce the
   * same hash, and a wall of tapes costs one thumbnail each rather than one
   * film each (I-70).
   *
   * Unlike `duration` and `pages` this is *not* read at ingest. It cannot be:
   * the frame comes out of a decoder, the only decoder here is the webview's,
   * and D-48 section 7 measured that a media element inside an item is paused
   * by the culler the moment it goes off screen. So it is grabbed lazily by
   * whichever machine holds the bytes, once, and lands on an existing record —
   * which is the per-property fill-in `registerAsset`'s comment anticipates.
   */
  poster: string | null;
  /**
   * The sidecar transcript that came in beside a recording — itself an asset,
   * named by its own hash (T-287). `null` for everything else, and for a
   * recording that arrived without one.
   *
   * A hash for `poster`'s reasons, and one more that only applies here. A page's
   * text is *derived*: any machine holding the file can extract it, so D-46
   * section 2 keeps it a local index and no peer is ever short of it. A
   * transcript cannot be derived from anything — it is a second file somebody
   * happened to have next to the first — so a peer that never sees those bytes
   * has no route to them at all. Holding it as an asset is what makes a
   * recording quotable on a machine that was not the one it was dropped on.
   *
   * **The transcript's *text* still never enters the document**, and this field
   * is what keeps that affordable rather than compromising it: what crosses is
   * 64 characters of hash, and the lines themselves are read off the bytes into
   * the same local index a case file's pages go into.
   *
   * Unlike `poster` this *is* known at ingest — the sidecar is read off the disk
   * in the same gesture that read the recording — so nothing has to go looking
   * for it later. It is still written by its own op rather than by
   * `registerAsset`, because the sidecar needs a record of its own in the same
   * transaction and that is `attachPoster`'s shape exactly.
   */
  transcript: string | null;
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

/**
 * Read the style map, keeping only what this build recognises.
 *
 * Property by property rather than all-or-nothing, and that is the point of it
 * being a map. A peer on a later build that has learned a sixth property writes
 * it alongside the five here; this reader drops the one it does not know and
 * keeps the four it does, so a board shared across two builds degrades one
 * appearance at a time instead of losing every override on the item.
 *
 * It also takes a `Y.Map` or a plain object without asking which. What arrives
 * is a Yjs type in the app and a literal in a test, and both answer `get`
 * — except that a plain object does not, which is why this goes through a
 * reader rather than through `map.get` directly.
 */
function readStyle(value: unknown): ItemStyle {
  const get = readerFor(value);
  if (get === null) return NO_STYLE;

  const style: {
    paperStock?: PaperStock;
    tint?: { hue: number; light: number };
    tapeStyle?: number;
    torn?: boolean;
    fontFamily?: ItemFace;
  } = {};

  const stock = get("paperStock");
  if (isPaperStock(stock)) style.paperStock = stock;

  const face = get("fontFamily");
  if (isItemFace(face)) style.fontFamily = face;

  const torn = get("torn");
  if (typeof torn === "boolean") style.torn = torn;

  // A mask, so anything outside the four bits is not a tape arrangement this
  // build can draw — and a fractional one is not a mask at all.
  const tape = get("tapeStyle");
  if (typeof tape === "number" && Number.isInteger(tape) && tape >= TAPE_NONE && tape <= TAPE_ALL) {
    style.tapeStyle = tape;
  }

  const tint = get("tint");
  const tintGet = readerFor(tint);
  if (tintGet !== null) {
    const hue = tintGet("hue");
    const light = tintGet("light");
    // Both or neither. Half a tint is not a tint, and defaulting the missing
    // half to zero would silently render a different sheet from the one the
    // writer meant.
    if (typeof hue === "number" && Number.isFinite(hue) && typeof light === "number" && Number.isFinite(light)) {
      style.tint = { hue, light };
    }
  }

  return style;
}

/** `get` for a `Y.Map` or a plain object, or null for neither. */
function readerFor(value: unknown): ((key: string) => unknown) | null {
  if (value instanceof Y.Map) return (key) => (value as YMap).get(key);
  if (typeof value === "object" && value !== null) {
    return (key) => (value as Record<string, unknown>)[key];
  }
  return null;
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
    // Read the way `assetId` is, and absent on every item written before this
    // existed — which is the ordinary case and reads as null.
    source: typeof map.get("source") === "string" ? (map.get("source") as string) : null,
    // Only `media` is ever written, and anything else — absent, a value a later
    // build invented, a peer's nonsense — reads as `page`. That is the default
    // rather than a repair: the question is "did this page say it was about a
    // film", and every answer short of yes is no.
    sourceAbout: map.get("sourceAbout") === "media" ? "media" : "page",
    style: readStyle(map.get("style")),
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
    // A page on a *free* pin is nonsense the same way a page on board ink is:
    // the cork has no document, so there is nothing for the number to index. It
    // is dropped here rather than at the writer alone, because the writer is
    // ours and this is not.
    page: parent === null ? null : readPage(map.get("page")),
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

/**
 * Null for a stroke with no points, which is the one field that cannot be
 * defaulted into something drawable — everything else clamps or falls back.
 *
 * `z` is required for the same reason it is on an item: without an ordering the
 * stroke has no defined place in the stack, and inventing one here would put it
 * somewhere different on every peer.
 *
 * `bbox` is *not* trusted. A malformed one is replaced with a degenerate box and
 * the renderer measures its own from the unpacked points (`state/scene.ts`);
 * invariant 7 says the box contains the points, and a peer that broke it must
 * not be able to clip our raster.
 */
export function readStroke(id: string, map: YMap): StrokeFields | null {
  const pts = map.get("pts");
  if (!(pts instanceof Uint8Array) || pts.length === 0) return null;
  const z = map.get("z");
  if (typeof z !== "string" || z.length === 0) return null;
  const tool = str(map.get("tool"), "marker");

  return {
    id,
    tool: (STROKE_TOOLS.has(tool) ? tool : "marker") as StrokeTool,
    color: str(map.get("color"), "#1f1b17"),
    // Clamped, not rejected, for `readItem`'s reason: a stroke with a nonsense
    // width should still be erasable rather than invisible.
    size: Math.max(MIN_STROKE_SIZE, num(map.get("size"), MIN_STROKE_SIZE)),
    opacity: Math.min(1, Math.max(0, num(map.get("opacity"), 1))),
    seed: num(map.get("seed"), 0) >>> 0,
    z,
    bbox: readBbox(map.get("bbox")),
    pts,
    page: readPage(map.get("page")),
  };
}

/**
 * Whether a value is a page number — one-based, whole, and real.
 *
 * The one predicate for it, exported because there are now three writers with
 * the same question (`ops/ink.ts` at the pen, `ops/pins.ts` at the tape, and
 * `readPage` below at every read) and a fourth copy of `Number.isInteger(n) &&
 * n >= 1` is how the pen and the tape end up disagreeing about what page 0
 * means.
 */
export function isPageNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * The page a stroke or a pin is on, and every other answer is null.
 *
 * Absent is the common case by a very long way — nothing written before T-278
 * has the key at all, and nothing on anything but an open case file has it since
 * — so this is a miss almost every time it is called and is written to be cheap
 * on the miss.
 *
 * A non-integer, a zero and a negative are all null rather than clamped, which
 * is the opposite of what `size` and `opacity` do in `readStroke`. The reason is
 * what the field decides: a nonsense width should still be erasable rather than
 * invisible, so it is clamped into range; a nonsense *page* has no range to be
 * clamped into, and picking one would file somebody's mark — or somebody's
 * thread — on a page they never opened. Null puts it back on the object, where
 * it is at least visible and can be rubbed out or cut.
 */
function readPage(value: unknown): number | null {
  return isPageNumber(value) ? value : null;
}

function readBbox(value: unknown): readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) return [0, 0, 0, 0];
  const box = value as number[];
  for (const n of box) if (typeof n !== "number" || !Number.isFinite(n)) return [0, 0, 0, 0];
  return [box[0]!, box[1]!, box[2]!, box[3]!];
}

/**
 * Read an asset record.
 *
 * ## The box guard, which is the load-bearing line in here
 *
 * A record with no pixel box used to read as *absent*, and that was right while
 * every asset was a photograph: a photograph whose dimensions are unknown is a
 * record that cannot be used for anything, and absent is a state the item
 * already renders (DESIGN section 7.5). It is also the single most likely place
 * to lose a file silently, because absent from here means absent from
 * `referencedAssets`, which means collected by the sweep.
 *
 * A cassette has no pixel box. Neither does a case file, and neither does a
 * VHS — the film has a frame size but the *object on the wall* is a cassette,
 * and its shape is the cassette's. So the guard learns which kinds are supposed
 * to have a box rather than being relaxed for everything (I-95).
 *
 * It still applies to `unknown`, and that is deliberate: a record whose mime
 * says nothing and whose box says nothing is the genuinely unusable record the
 * guard was written for, and it goes on reading as absent exactly as it did
 * before any of this.
 */
export function readAsset(sha256: string, map: YMap): AssetFields | null {
  const mime = str(map.get("mime"), "application/octet-stream");
  const kind = assetKind(mime);
  const w = num(map.get("w"), 0);
  const h = num(map.get("h"), 0);
  if ((kind === "image" || kind === "unknown") && (w <= 0 || h <= 0)) return null;
  return {
    sha256,
    w,
    h,
    mime,
    size: num(map.get("size"), 0),
    origName: str(map.get("origName"), ""),
    addedBy: num(map.get("addedBy"), 0),
    addedAt: num(map.get("addedAt"), 0),
    kind,
    duration: positive(map.get("duration")),
    pages: positive(map.get("pages")),
    poster: hash(map.get("poster"), sha256),
    transcript: hash(map.get("transcript"), sha256),
  };
}

/**
 * A hash we are willing to act on, or nothing.
 *
 * `isHash`'s argument, one layer further in: this value arrived in a `Y.Map`
 * that any peer can write, and what it becomes on this side is a path in the
 * content store and a key in the exchange. A poster naming `../../etc` is the
 * one thing an asset record can carry that is worse than a wrong number.
 *
 * It also refuses a film that names *itself* as its own still. Nothing here
 * writes that, and the loop it makes is not an obvious one to spot from the
 * outside: `posterOf` would resolve the film's hash, raise a want on the film's
 * bytes and hand an `<img>` a video to decode.
 */
function hash(value: unknown, self?: string): string | null {
  if (typeof value !== "string" || !isHash(value)) return null;
  return value === self ? null : value;
}

/**
 * A number that is a measurement, or nothing.
 *
 * Zero is not a measurement here — see `AssetFields.duration`. Nor is a
 * negative, an infinity or a `NaN`, all of which are what a hostile or simply
 * older peer can put in a `Y.Map` that this side has to survive reading.
 */
function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Whichever collection of pins the caller happens to hold.
 *
 * The document's answer is a `Set` of ids built for the question; the mirror's
 * is `Scene.pins`, a `Map` keyed by the same ids. Both answer "is this pin
 * there", and a `Map` is not a `ReadonlySet` — so asking for the *question*
 * rather than for a container is what lets `crdt/binding.ts` apply invariant 3
 * against the mirror without building a throwaway set on every string it reads.
 */
export interface PinPresence {
  has(pinId: string): boolean;
}

/**
 * Does a string still have enough valid nodes to be a string?
 * Invariant 3 — "no string survives with fewer than two valid nodes".
 */
export function isRenderableString(nodes: readonly StringNodeFields[], pins: PinPresence): boolean {
  let valid = 0;
  for (const node of nodes) {
    if (pins.has(node.pin)) valid++;
    if (valid >= 2) return true;
  }
  return false;
}
