/**
 * Entry point. Builds the layer stack, binds the document, wires the nine
 * phases, starts the loop.
 *
 * This is the one module allowed to know about every layer at once — it is
 * where `crdt/`, `state/` and `render/` are introduced to each other. The
 * one-way flow they form is the whole architecture:
 *
 *     interaction -> crdt/ops -> Y.Doc -> observer -> binding -> Scene -> render
 */

import { Binding } from "@/crdt/binding";
import { boardSeed, encodedSize, initialiseBoard, openBoardDoc, snapshot } from "@/crdt/doc";
import * as ops from "@/crdt/ops";
import {
  bringToFront,
  commitStrokes,
  createItems,
  createPin,
  createStringThrough,
  deleteBoardStrokes,
  deleteItems,
  deletePins,
  deleteStrokes,
  deleteStrings,
  insertPinIntoString,
  movePins,
  placePin,
  resizeItems,
  scaleNodeSlack,
  scaleStringSlack,
  setItemPoses,
  sendToBack,
  setNodeSlack,
  setStringSlack,
  setStringStyle,
} from "@/crdt/ops";
import { Origin } from "@/crdt/origins";
import { Persistence } from "@/crdt/persistence";
import { AssetExchange, Priority } from "@/crdt/sync/exchange";
import { WireProvider } from "@/crdt/sync/provider";
import { UndoHistory } from "@/crdt/undo";
import { noteSizeFor } from "@/app/ingest";
import { Paste } from "@/app/paste";
import { Mesh } from "@/app/mesh";
import { formatInvite, inviteSearch, openingPlan, parseInvite } from "@/app/invite";
import { dialAddress, identityFor } from "@/app/sync";
import { DEFAULT_ERASER_SIZE, type InkSurface, type WetStroke } from "@/lib/ink";
import { initPlatform } from "@/platform";
import { variantFor } from "@/platform/types";
import { Cork } from "@/render/cork";
import { Culler } from "@/render/cull";
import { BoardInkLayer } from "@/render/ink/board";
import { DomItemLayer, type AssetView } from "@/render/items/dom";
import { FrameLoop } from "@/render/loop";
import { Overlay, type PendingRun } from "@/render/overlay";
import { Janitor } from "@/crdt/janitor";
import { Peers, readPeer } from "@/render/presence/peers";
import { PinLayer } from "@/render/pins/dom";
import { RopeLayer } from "@/render/ropes/paint";
import { World } from "@/render/world";
import { RopeSet, type RopeHit } from "@/sim/ropes";
import { Torsion } from "@/sim/torsion";
import { AssetStates } from "@/state/assets";
import { MissingAssets } from "@/state/missing";
import { Camera, type Bounds } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Flashes } from "@/state/flash";
import { Flatten } from "@/state/flatten";
import { chromeFrame, emptyFrame, handleAt, handleCursor } from "@/state/handles";
import { isChromeTarget, isTextTarget } from "@/state/input";
import { Navigation } from "@/state/navigation";
import { Presence } from "@/state/presence";
import { RemoteMotion } from "@/state/remote";
import { reveal, widen } from "@/state/reveal";
import { Scene } from "@/state/scene";
import { Selection } from "@/state/selection";
import { ToolMachine } from "@/state/tools/machine";
import { EraserTool } from "@/state/tools/eraser";
import { MarkerTool } from "@/state/tools/marker";
import { NoteTool } from "@/state/tools/note";
import { PinTool } from "@/state/tools/pin";
import { stringAt } from "@/state/tools/frame";
import { SelectTool } from "@/state/tools/select";
import { StringTool } from "@/state/tools/string";
import type { BoardWriter, WritePose } from "@/state/tools/tool";
import { boardMenuRows, itemMenuRows, penMenuRows, pinMenuRows, stringMenuRows } from "@/ui/boardmenu";
import { Hud, type HudStats } from "@/ui/hud";
import { Flash } from "@/ui/flash";
import { Notice } from "@/ui/notice";
import { ContextMenu, type MenuEntry } from "@/ui/menu";

/**
 * How often the missing-photograph notice checks that what it is counting is
 * still on the board.
 *
 * Half a second, which is far slower than anything a person can delete and far
 * faster than they can wonder why the count is wrong. The sweep is a scene walk,
 * and it only runs at all while something is missing.
 */
const NOTICE_SWEEP_MS = 500;

/** No pen in hand, or one holding nothing — the same array every frame, because
 *  the two readers of it run sixty times a second on a board with no ink on it
 *  at all. */
const NO_WET_RUNS: readonly WetStroke[] = Object.freeze([]);

async function boot(): Promise<void> {
  const native = await initPlatform();

  const root = document.querySelector<HTMLDivElement>("#board-root");
  if (!root) throw new Error("#board-root missing from index.html");

  // --- document ------------------------------------------------------------
  const board = openBoardDoc();
  const persistence = new Persistence(board, native);
  // Before `initialiseBoard`, so a board that already exists keeps its own cork
  // seed and creation date rather than having fresh ones merged over the top,
  // and before the binding starts, so the scene is mirrored once.
  await persistence.open();
  initialiseBoard(board);

  const scene = new Scene();
  const dirty = new DirtySets();
  const binding = new Binding(board, scene, dirty);
  binding.start();
  /**
   * What the last undo changed, fading — DESIGN section 7.6.
   *
   * Next to the dirty sets because that is where it reads from: an undo is a
   * transaction like any other, and the binding above has already turned its
   * events into the ids of the things that moved.
   */
  const flashes = new Flashes();

  // --- presentation --------------------------------------------------------
  const camera = new Camera();
  const world = new World(root);
  const cork = new Cork(world.layers.cork, boardSeed(board));
  /**
   * What this machine can show of each photograph, and how far off the rest are.
   *
   * `platform/types.ts` says `assetUrl` "returns an empty string for an asset
   * this process has never seen, which the item renders as its `unknown` state
   * rather than as an error" — and under the shell it cannot keep that promise
   * on its own, because building the URL is pure string work that knows
   * nothing about what is on disk. So the knowledge lives here, and this is
   * the local per-asset state DATA-MODEL section 10 says is never in the
   * document.
   *
   * It matters more than a contract detail. Without it an item points an
   * `<img>` at bytes that have not arrived, gets a 404, and the only thing
   * standing between the user and a broken-image icon is an error handler. With
   * it, an item with no photograph yet is simply an item with no photograph
   * yet — undeveloped film, which is what DESIGN section 7.5 asks for.
   *
   * This module is wiring for it and nothing else: every transition below is one
   * line next to the event that causes it, and `state/assets.ts` owns which of
   * them are allowed to win.
   */
  const assets = new AssetStates();
  /**
   * And whose laptop the ones nobody here has are on (T-75, DESIGN 7.5).
   *
   * Separate from `assets` because it answers a different question and lives on
   * a different timescale: `assets` says which of five states a hash is in and
   * is read by the renderer every frame; this says who claimed a hash we then
   * failed to get, and it keeps peers' names after they leave — which is the
   * only reason it can answer at all, since by the time anything is unavailable
   * the holder has almost always gone and awareness has dropped them.
   */
  const missing = new MissingAssets();
  /**
   * Fetches the bytes `assets` is waiting for, once there is a wire (T-74).
   *
   * Declared here and assigned with the provider a long way below, because the
   * two things that drive it are at opposite ends of this function: an item
   * being drawn is what says an asset is wanted *now*, and that happens in
   * `assetUrl` a few lines down. Null on a board with no relay, where every
   * asset that is not already on this disk is simply not coming.
   */
  let exchange: AssetExchange | null = null;
  /**
   * Which stored variant serves an item that is about to be drawn `screenPx`
   * across.
   *
   * The renderer says how big; this says which file, because which variants exist
   * and how large they are is a fact about the asset store rather than about
   * drawing. Getting it wrong is expensive in a way that is easy to miss: an
   * `<img>` decodes at first paint, so a 16-pixel item pointed at a 2560-pixel
   * photograph pays for the whole decode and throws almost all of it away. D-15
   * measured that as a 243 ms frame, and it is culling that made it visible —
   * before culling every item was mounted from the start and had already paid.
   *
   * The choice itself is `variantFor`, over in `platform/`, because this module
   * is wiring and nothing tests it.
   */
  /**
   * The bytes are on this disk.
   *
   * Both things, always, because they are one fact. The exchange clears a want
   * when a transfer commits, which covers every photograph that *arrived* - and
   * misses the much more common one that was never absent. Boot mounts items and
   * `assetUrl` asks for every photograph it cannot yet show, and that happens
   * before `reconcileAssets` has finished asking the store whether they are
   * already here; the answer comes back yes, and the want stays.
   *
   * Left alone it never goes: nothing removes a want but bytes landing, and no
   * bytes are coming for a file that was already there. So a board where every
   * photograph is present reads "N missing" in the HUD's alert colour for the
   * whole session - which is the row a person would look at to tell whether
   * transfers are stuck - and we broadcast WANT to every peer for photographs we
   * are holding, which is a message per asset per peer saying something untrue
   * about us.
   */
  const holdsAsset = (sha256: string): void => {
    assets.ready(sha256);
    exchange?.forget(sha256);
  };

  const assetUrl = (sha256: string, screenPx: number): AssetView => {
    if (assets.isReady(sha256)) {
      return { url: native.assetUrl(sha256, variantFor(screenPx)), phase: "ready", fraction: 0 };
    }
    // Asked for a photograph we do not have the bytes of, which means an item
    // wearing it is being drawn — and culling only binds what is on screen, so
    // this *is* "an asset whose item is in or near the viewport" (ARCHITECTURE
    // section 5.2). No viewport arithmetic of its own: the layer that already
    // decides what to mount is a better answer than a second opinion about it.
    //
    // Only a board with a wire is *requesting* anything. Without one there is
    // nobody to ask, so saying so here would be a promise this process cannot
    // keep; `reconcileAssets` is what calls that case what it is, once it has
    // asked the store and knows the bytes are genuinely not here.
    if (exchange !== null) {
      exchange.want(sha256, Priority.VISIBLE);
      assets.requesting(sha256);
    }
    // Read after asking, so the first frame an item appears on already draws it
    // as film somebody has been asked for rather than as film nobody has
    // mentioned. Both are blank, and the difference is one repaint.
    return { url: "", phase: assets.phase(sha256), fraction: assets.fraction(sha256) };
  };
  /** Phase 3, after the torsion: the note being written on, laid flat (T-178). */
  const flatten = new Flatten();
  /**
   * The caret, when there is one (DESIGN section 3.6).
   *
   * The layer owns the field — see `render/items/view.ts` on why nothing that
   * crosses that seam may be an element — and these two are what it reports.
   * `onInput` is wired to the document in T-180; for now the field is a
   * scratchpad, and closing it throws the text away.
   */
  const items = new DomItemLayer(world.layers.world, assetUrl, {
    /**
     * Straight to the document, not queued to phase 9 like a tool's writes.
     *
     * The queue exists so a *tool* cannot change the document out from under
     * the renderer halfway through a frame — it runs in phase 1 and the flush
     * is phase 9. An `input` event is not in a frame at all; it fires between
     * them, exactly as the paste handler does, and holding a keystroke back
     * for a frame would only make the caret and the paper disagree.
     */
    onInput: (id, text) => {
      ops.setItemText(board, id, text);
    },
    onClosed: (id) => {
      // Let the paper back down. The clock runs from wherever it got to, so
      // clicking away mid-rise does not snap.
      if (flatten.itemId === id) flatten.close();
    },
  });

  /**
   * Put the caret in an item — the whole of "start writing on this", in one
   * place, because two things ask for it (DESIGN section 3.6).
   *
   * The double-click gets here through `ToolContext.edit`, and the context
   * menu's *Edit text* row calls it directly. One function rather than two
   * closures, so the two routes cannot drift into laying the paper flat by
   * different amounts or seeding the field from different text.
   *
   * The flatten first: it steps in phase 3 and the field is parked in phase 5,
   * so the paper has already begun to turn by the time the caret lands.
   */
  const startEditing = (itemId: string): void => {
    flatten.open(itemId);
    items.edit(itemId, scene.cold(itemId)?.text ?? "");
  };

  /** Ink on the bare cork — its own layer, under the string and under the paper
   *  (T-61). Nothing else on this board draws below the items. */
  const boardInk = new BoardInkLayer(world.layers.boardInk);

  /** Re-bind every item wearing this asset. A walk, on a once-per-photograph
   *  event. */
  const refreshAsset = (sha256: string): void => {
    for (const id of scene.itemIds()) {
      if (scene.cold(id)?.assetId === sha256) dirty.item(id);
    }
  };
  // One subscription rather than a `refreshAsset` beside every transition. A
  // state that changed and did not redraw is the bug this makes impossible, and
  // there are five places that change one.
  assets.onChange(refreshAsset);

  // Awaited, not fired and forgotten: `listen` is itself a round trip, and an
  // `asset:ready` emitted before it resolves is simply lost — which would
  // strand that one photograph undeveloped for the session while every later
  // one worked.
  await native.on("asset:ready", ({ sha256 }) => {
    holdsAsset(sha256);
    // We are now somebody who has it, whether it was pasted here or fetched
    // from a peer. Saying so immediately rather than waiting for a periodic
    // sweep is what makes a photograph dropped on one machine appear on the
    // other one while the person who dropped it is still looking at it.
    exchange?.announce([sha256]);
  });
  const overlay = new Overlay(world.layers.overlay);
  /**
   * The two rope canvases — DESIGN section 6.2's "two rope canvases, not one".
   * Real boards have string running behind photographs that were pinned on top
   * of it later, and one overlay would force every string above or every string
   * below. Same painter twice; the string's own `layer` field picks.
   */
  const ropesUnder = new RopeLayer(world.layers.ropesUnder, "under");
  const ropesOver = new RopeLayer(world.layers.ropesOver, "over");
  /**
   * Pins, in their own screen-space layer above everything else on the board.
   * Not inside the world transform, and `render/pins/dom.ts` explains why: a
   * pin's head has a floor in *screen* pixels so that a zoomed-out board still
   * has something visible holding it together (DESIGN section 4.5).
   */
  const pins = new PinLayer(world.layers.pins);
  /**
   * Which items are worth having in the DOM. The spike (D-12) measured the
   * gesture-end repaint at 777 ms with 500 live nodes, so this is load-bearing
   * rather than an optimisation — see `render/cull.ts`.
   */
  const culler = new Culler();
  /** Phase 3: "pin count is the item's physics" (DESIGN section 2.2). */
  const torsion = new Torsion();
  /** Phase 3, the other half. Empty until something makes a string (T-41), and
   *  free while it is — a rope set with no ropes steps nothing. */
  const ropes = new RopeSet();
  /**
   * Phase 2: every other peer's in-flight drag, rendered 100 ms in the past.
   *
   * Fed from the awareness subscription below, which is also where its arrival
   * times come from. Empty and free on a board with no wire.
   */
  const remote = new RemoteMotion();
  /**
   * Phase 8: the same peers, as a picture — where they are pointing and what
   * they have hold of.
   *
   * The other half of the same awareness state. `remote` takes the `grab`, which
   * moves items and is therefore a write into the scene; this takes the cursor
   * and the selection, which are never anything but chrome on the overlay. One
   * subscription, split by what the payload is *for*.
   */
  const peers = new Peers();
  const loop = new FrameLoop();
  const selection = new Selection();
  // Both annotated, and they have to be: `offerWheel` below reaches forward to
  // `tools` and `tools`' `suppressed` reaches back to this, so inference has a
  // cycle to walk and gives up. The truce being mutual is the reason.
  const navigation: Navigation = new Navigation(camera, root, {
    contentBounds: () => scene.contentBounds(),
    selectionBounds: () => scene.boundsOfMany(selection.members),
    /**
     * The wheel is the one input the camera and the board both want — it zooms
     * (DESIGN section 3.7) and it adjusts a selected segment's slack (section
     * 3.4) — so the camera offers each notch to the active tool first. True
     * means the tool took it.
     *
     * `tools` is declared below and this closes over it, which is safe because
     * nothing calls it until a wheel event arrives. The two objects need each
     * other: this is the truce in one direction and `suppressed` below is the
     * same truce in the other.
     */
    offerWheel: (e): boolean => tools.claimWheel(e),
  });

  // --- interaction ---------------------------------------------------------

  /**
   * Document writes a tool asks for are *queued*, not made. They land in phase
   * 9, below, so no observer can move the scene out from under a frame that
   * phases 4 and 5 have already read (ARCHITECTURE section 3).
   */
  const queued: (() => void)[] = [];
  /**
   * A settle map, copied and normalised for the queue.
   *
   * Copied like every other queued write, because this runs in phase 9 and the
   * tool has moved on by then; and an empty one becomes `undefined` so that the
   * ops below can keep asking "was I given any poses" rather than "was I given
   * a map, and if so does it contain anything".
   */
  const settled = (
    settle?: ReadonlyMap<string, WritePose>,
  ): Map<string, WritePose> | undefined =>
    settle && settle.size > 0 ? new Map(settle) : undefined;
  const writer: BoardWriter = {
    setPoses: (poses, phase) => {
      const snapshot = new Map(poses);
      queued.push(() =>
        setItemPoses(
          board,
          snapshot,
          // A live pose is the throttled crash-safety write; the undo manager
          // (T-29) merges it into the release's entry rather than stacking one
          // entry per half second of dragging.
          phase === "live" ? Origin.DRAG_THROTTLE : Origin.LOCAL_USER,
        ),
      );
    },
    setSizes: (sizes, phase) => {
      const snapshot = new Map(sizes);
      queued.push(() =>
        resizeItems(
          board,
          snapshot,
          phase === "live" ? Origin.DRAG_THROTTLE : Origin.LOCAL_USER,
        ),
      );
    },
    deleteItems: (ids, keepPins) => {
      const snapshot = [...ids];
      queued.push(() => deleteItems(board, snapshot, { keepPins }));
    },
    /**
     * The two ends of the stack. Copied and queued like every other write here,
     * which matters more than usual for these two: the ops read the whole
     * board's keys to find the end they are generating against, and doing that
     * in phase 9 means they read the board after the frame's other writes have
     * landed rather than the one the menu was built from.
     */
    bringToFront: (ids) => {
      const snapshot = [...ids];
      queued.push(() => bringToFront(board, snapshot));
    },
    sendToBack: (ids) => {
      const snapshot = [...ids];
      queued.push(() => sendToBack(board, snapshot));
    },
    /**
     * A blank sheet — what DESIGN section 2.1 calls a scrap, which is "a note
     * that happens to have no text yet".
     *
     * Sized by the same function that sizes a pasted note, asked for the empty
     * string, so an empty one and a one-word one are the same piece of paper.
     * The pin and the scatter angle are not passed: `createItems` defaults both,
     * which is exactly why they are defaults — "a caller that has to remember to
     * jitter is a caller that will forget".
     */
    createNote: (x, y) => {
      queued.push(() => {
        const size = noteSizeFor("");
        const made = createItems(board, [{ type: "note", x, y, w: size.w, h: size.h }]);
        if (made.length > 0) selection.replace(made.map((item) => item.itemId));
      });
    },
    /**
     * The three pin writes. The coordinates arrive already in the frame the
     * parent implies — the tool converts, because only the tool knows the pose
     * a hanging item is actually drawn at (`state/tools/frame.ts`).
     */
    createPin: (parent, lx, ly, settle) => {
      const poses = settled(settle);
      queued.push(() => createPin(board, { parent, lx, ly }, poses));
    },
    placePin: (pinId, parent, lx, ly, settle) => {
      const poses = settled(settle);
      queued.push(() => placePin(board, pinId, parent, lx, ly, poses));
    },
    createString: (anchors, closed, settle) => {
      // Copied, like every other queued write: this runs in phase 9 and the
      // tool has moved on by then.
      const run = anchors.map((a) => ({ ...a }));
      const poses = settled(settle);
      queued.push(() => createStringThrough(board, run, { closed }, poses));
    },
    /**
     * The headline gesture: a loop of string pulled out to a new pin (DESIGN
     * section 3.4). The pin and the node it hangs on are one transaction, so
     * `Ctrl+Z` takes the pin with the node rather than leaving it in the cork.
     *
     * The chords arrive measured, because geometry lives in the scene and
     * `crdt/` may not read it. Two things deliberately do not: the segment's
     * own slack, and *which* segment it is. Both are read inside the op's
     * transaction — one from the node, one by resolving `after` — which is what
     * makes the `queued.push` below safe. The write runs at the next flush, and
     * by then the number the gesture saw may be a peer's edit old and the
     * position it counted may be a peer's insert out (DATA-MODEL section 5.4).
     */
    insertPin: (stringId, after, anchor, split, settle) => {
      const at = { ...anchor };
      const cut = { ...split };
      const poses = settled(settle);
      queued.push(() => insertPinIntoString(board, stringId, after, at, cut, poses));
    },
    deletePins: (ids, settle) => {
      const snapshot = [...ids];
      const poses = settled(settle);
      queued.push(() => deletePins(board, snapshot, poses));
    },
    /**
     * The four slack writes — DESIGN section 3.4's editing table, which is one
     * gap or the whole run, set or scaled.
     *
     * The two scaling ones hand over a factor rather than a value on purpose:
     * a tool's read of the scene is a frame older than the write it produces,
     * so a roll of the wheel that multiplied in the tool would keep deriving
     * the same answer from the same stale number. `crdt/ops/strings.ts` says it
     * at length.
     */
    setNodeSlack: (stringId, nodeId, slack) => {
      queued.push(() => setNodeSlack(board, stringId, nodeId, slack));
    },
    scaleNodeSlack: (stringId, nodeId, factor) => {
      queued.push(() => scaleNodeSlack(board, stringId, nodeId, factor));
    },
    setStringSlack: (stringIds, slack) => {
      const snapshot = [...stringIds];
      queued.push(() => setStringSlack(board, snapshot, slack));
    },
    scaleStringSlack: (stringIds, factor) => {
      const snapshot = [...stringIds];
      queued.push(() => scaleStringSlack(board, snapshot, factor));
    },
    /**
     * Tuck behind, and the only thing in the app that writes `layer`.
     *
     * `setStringStyle` takes the whole style and applies only the fields it is
     * given, so this hands over the one field rather than reading the other
     * four out of the scene and writing them back — a restyle that echoed the
     * colour and thickness would collide with a concurrent restyle of those
     * fields for no reason at all.
     */
    setStringLayer: (stringIds, layer) => {
      const snapshot = [...stringIds];
      queued.push(() => setStringStyle(board, snapshot, { layer }));
    },
    /** Restyle — DESIGN section 3.4. Straight through: `setStringStyle` already
     *  applies only the fields it is given, which is exactly the contract. */
    setStringStyle: (stringIds, style) => {
      const snapshot = [...stringIds];
      const fields = { ...style };
      queued.push(() => setStringStyle(board, snapshot, fields));
    },
    /** DESIGN section 3.4's *Delete*. The pins stay; `deleteStrings` deletes
     *  the string map and nothing else, which is the whole of the rule. */
    deleteStrings: (stringIds) => {
      const snapshot = [...stringIds];
      queued.push(() => deleteStrings(board, snapshot));
    },
    /**
     * The free pins a dragged or rotated thread carries with it.
     *
     * Snapshotted, like every other queued write here: the tool hands over the
     * positions it computed this frame and goes on moving the pins in the
     * mirror, so a map read at flush time would be a frame ahead of the poses
     * it is supposed to travel with.
     *
     * `lx`/`ly` rather than `x`/`y` at this boundary because that is what the
     * document calls a pin's stored position — and for a free pin the two are
     * the same numbers, which is exactly why only free pins are ever in here.
     */
    movePins: (positions) => {
      const snapshot = new Map<string, { lx: number; ly: number }>();
      for (const [id, at] of positions) snapshot.set(id, { lx: at.x, ly: at.y });
      queued.push(() => movePins(board, snapshot));
    },
    /**
     * One finished stroke, and the near end of the wet/dry handoff.
     *
     * Not copied, which is the one write on this interface that is not. Every
     * other one snapshots because the tool goes on mutating what it handed over;
     * the marker instead swaps in a fresh array the moment a stroke ends
     * (`state/tools/marker.ts`), so the samples here are already dead to it — and
     * a stroke is the largest thing any gesture hands over, in the one gesture on
     * this board with a latency budget.
     *
     * The far end is [`drying`] below. What is settled here is only the case
     * where no ink is coming at all.
     */
    commitStrokes: (runs) => {
      queued.push(() => {
        const written = commitStrokes(
          board,
          runs.map((run) => ({
            // The pen named this run at pen-down, so that a peer already
            // drawing it can recognise the record when it arrives (DATA-MODEL
            // section 9.2). Dropping it here would leave the ghost on their
            // overlay with nothing to match.
            id: run.id,
            item: run.item,
            tool: run.tool,
            color: run.color,
            size: run.size,
            opacity: run.opacity,
            samples: run.samples,
          })),
        );
        // Which surfaces to wait for, one per run that actually landed. Both
        // halves come back from the op — the runs it refused are simply absent,
        // so nothing here has to match results to inputs by position.
        drying = written.map((one): InkSurface =>
          one.tile === null ? { kind: "item", id: one.item! } : { kind: "tile", key: one.tile },
        );
        if (drying.length > 0) return;
        // Nothing was written: a click rather than a stroke, or paper that left
        // the board while the pointer was down. No re-raster is coming, so the
        // overlay copies are all that is holding the mark up and they stop being
        // drawn now.
        drying = null;
        dried();
      });
    },
    /**
     * The eraser's whole output. No re-raster to wait for and nothing drying —
     * a record that has gone leaves the item's or the tile's canvas repainting
     * from what is left, which the INK phase does anyway.
     */
    eraseStrokes: (surface, ids) => {
      queued.push(() => {
        if (surface.kind === "item") deleteStrokes(board, surface.id, ids);
        else deleteBoardStrokes(board, surface.key, ids);
      });
    },
  };

  /**
   * The surfaces a pen is still drawing on the overlay because their canvases
   * have not caught up — the far end of `BoardWriter.commitStrokes`, and the
   * whole of what stops a pen-up from blinking.
   *
   * A list, because one gesture can be several runs on several surfaces (T-137),
   * and each is an item or a board-ink tile — the two things a stroke can land on,
   * rastered by different layers with different budgets. A plain string would
   * collapse them and the wrong layer would be asked.
   *
   * One list, not a queue of them: a press drops whatever that pen had drying
   * (see `MarkerTool.runsInFlight`), so there is never a second gesture's worth to
   * hold.
   */
  let drying: InkSurface[] | null = null;
  /**
   * Both pens, rather than the one that committed.
   *
   * Only the current tool's stroke is ever drawn (see the OVERLAY phase), so the
   * other pen's slot is invisible either way — and clearing it is what stops a
   * stroke drawn with the marker, switched away from and switched back to, from
   * being drawn a second time over ink that has long since landed. `dry` is
   * idempotent, which is what makes asking both of them free.
   */
  const dried = (): void => {
    marker.dry();
    highlighter.dry();
    smudge.dry();
  };

  /**
   * Undo.
   *
   * The camera and the selection are not in the document, but "undo takes me
   * back to where I was" still matters (DESIGN section 7.6), so they are
   * stashed on the way out and put back on the way in. Both restores land in
   * phase 9, one phase after the DOM was written, so they show on the next
   * frame — which is what `Camera.version` and `Selection.version` are for.
   */
  const undo = new UndoHistory(board, {
    captureView: () => ({
      x: camera.x,
      y: camera.y,
      zoom: camera.zoom,
      selection: selection.snapshot(),
    }),
    restoreView: (view) => {
      camera.setView(view.x, view.y, view.zoom);
      // Undoing a paste un-creates what it selected, so a stashed selection
      // can name things that no longer exist. A selection holding a ghost
      // makes the next Delete an op that quietly does nothing, which is the
      // confusing kind of nothing.
      selection.restore(
        view.selection,
        (id) => scene.has(id),
        (id) => scene.strings.has(id),
        (id) => scene.pins.has(id),
      );
    },
  });

  /**
   * Ctrl+Z · Ctrl+Shift+Z (DESIGN section 3.7), and Ctrl+Y because this is a
   * Windows-first application and that is the other muscle memory.
   *
   * Ambient, like navigation — undo works in every tool, so it is not the tool
   * machine's. The intent is *queued* rather than acted on: `undo()` opens a
   * transaction, and a listener that writes to the document does it in the
   * middle of a frame whose layout phase has already read the scene.
   */
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    // Inside a text field, Ctrl+Z belongs to the text field.
    if (isTextTarget(e.target)) return;
    const intent =
      e.code === "KeyZ" ? (e.shiftKey ? "redo" : "undo") : e.code === "KeyY" ? "redo" : null;
    if (!intent) return;
    e.preventDefault();
    // Held down, the key repeats and each repeat is another step back. That is
    // the point of holding it.
    //
    // Wrapped in `flashes.around` so that whatever the step turns out to move
    // is lit for a moment: undo is origin-scoped, so it can put back a value a
    // collaborator has since changed, in a corner of the board nobody is
    // looking at (DESIGN section 7.6, `state/flash.ts`).
    queued.push(
      intent === "undo"
        ? () => {
            if (flashes.around(dirty, scene, () => undo.undo())) revealChanged = true;
          }
        : () => {
            if (flashes.around(dirty, scene, () => undo.redo())) revealChanged = true;
          },
    );
  });

  /**
   * An undo landed and the camera has not yet been asked whether it can see
   * what moved — Q-79, `state/reveal.ts`.
   *
   * A flag rather than the check itself, because the check runs a phase and a
   * frame later. A pin's world position is recomputed in LAYOUT from the item
   * it hangs on, and the undo lands in phase 9 — so asking here would measure
   * the board as it was before the write it is asking about.
   */
  let revealChanged = false;

  const select = new SelectTool();
  /**
   * One placement and the board is back in `select` — see `state/tools/note.ts`
   * for why a tool nothing on screen advertises must not stay armed.
   *
   * Queued rather than switched on the spot: `setTool` cancels whatever the old
   * tool had hold of, which writes to the scene, and this runs from inside the
   * note tool's own `handle` in phase 1 — swapping the machine's tool out from
   * under the loop mid-drain is how a gesture ends up half delivered to each.
   */
  const note = new NoteTool({ onDone: () => queued.push(() => tools.setTool(select)) });
  const pinTool = new PinTool({ onDone: () => queued.push(() => tools.setTool(select)) });
  /** `S`. The primary verb — DESIGN section 1.3, "the string is the product". */
  const stringTool = new StringTool({ onDone: () => queued.push(() => tools.setTool(select)) });
  /**
   * `M` and `H` — the two pens of DESIGN section 3.9.
   *
   * Both sticky, unlike the note and pin tools, and for the reason they are not:
   * those place one thing and a second click would place another by accident,
   * while nobody draws exactly one stroke. `Escape` or `V` hands the board back.
   *
   * One class twice. The two differ in width, colour, opacity and compositing and
   * in nothing else about the gesture — `state/tools/marker.ts` takes a tool name
   * and reads the rest of it off `lib/ink.ts`, so the only thing said here is
   * which pen this is.
   */
  const marker = new MarkerTool({ onDone: () => queued.push(() => tools.setTool(select)) });
  const highlighter = new MarkerTool({
    tool: "highlighter",
    onDone: () => queued.push(() => tools.setTool(select)),
  });
  /**
   * `E` — the rubber, and the one tool that draws nothing.
   *
   * Not a `MarkerTool` and not a variant of one: it makes no mark, has no colour
   * and writes a delete rather than an insert (`state/tools/eraser.ts`). What it
   * shares with the pens is the gesture — a held pointer, the coalesced trail,
   * and a surface fixed at the press — and that is a shape, not a class.
   *
   * The `Shift+E` smudge is a mark and *is* the marker again; it is not built
   * (T-62's second half) and is not bound, because a key that silently does
   * nothing is worse than one that is not bound.
   */
  const eraser = new EraserTool({ onDone: () => queued.push(() => tools.setTool(select)) });
  /**
   * `Shift+E` — the smudge, which is a mark rather than an absence and is
   * therefore `MarkerTool` a third time.
   *
   * > A `Shift+E` smudge eraser paints a `destination-out` stroke for partial
   * > rubbing-out. — DESIGN section 2.4
   *
   * Everything about the gesture, the space rule and the commit is the pens'.
   * What differs is one line of compositing and the fact that it has no colour —
   * `lib/ink.ts` answers the palette with an empty list, and the menu drops the
   * row rather than offering four swatches that all do the same nothing.
   */
  const smudge = new MarkerTool({
    tool: "erase",
    size: DEFAULT_ERASER_SIZE,
    onDone: () => queued.push(() => tools.setTool(select)),
  });
  /**
   * The pen currently in hand, or null when the tool is not one.
   *
   * Asked by the three things that treat the two pens as one tool with a
   * variable in it: the right-click menu that loads it, the `[` and `]` keys
   * that walk its ladder, and the overlay, which draws whichever one is holding
   * the board.
   */
  const penInHand = (): MarkerTool | null =>
    tools.current === marker
      ? marker
      : tools.current === highlighter
        ? highlighter
        : tools.current === smudge
          ? smudge
          : null;
  /** The pen whose stroke the *overlay* draws — every one but the smudge, whose
   *  mark is an absence and belongs on the ink canvas. See the OVERLAY phase. */
  const wetPen = (): MarkerTool | null => {
    const pen = penInHand();
    return pen === null || pen.kind === "erase" ? null : pen;
  };
  /**
   * The three hit tests, named once. The tool machine is handed them, and so is
   * the hover in phase 4 — which asks the same questions between gestures that
   * a press asks during one, and has to get the same answers.
   */
  const hitItem = (bx: number, by: number): string | null => items.hitTest(scene, bx, by);
  // Screen space, because a pin's grab radius is in screen pixels and has a
  // floor — see `render/pins/dom.ts`.
  const hitPin = (sx: number, sy: number): string | null => pins.hitTest(scene, camera, sx, sy);
  // Board space, and against the particles: where a string *hangs*, which is
  // the only thing that knows about the sag.
  const hitString = (bx: number, by: number, reach: number): RopeHit | null =>
    ropes.nearest(bx, by, reach);

  const tools: ToolMachine = new ToolMachine(select, root, {
    scene,
    dirty,
    camera,
    selection,
    write: writer,
    hitTest: hitItem,
    hitPin,
    hitString,
    /** A double-click on paper puts a caret in it (Q-92). */
    edit: startEditing,
    // Space+drag and middle-drag belong to the camera, not to the board.
    suppressed: () => navigation.panReady,
  });

  /**
   * Picking a tool (DESIGN section 3.9).
   *
   * All eight of DESIGN section 3.5's rows, `E` and `Shift+E` included.
   *
   * Unmodified keys, plus the one `Shift`. `Ctrl+V` is paste and must not also
   * change tool, and inside a note an `n` is an `n`.
   */
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (isTextTarget(e.target)) return;
    const next =
      e.code === "KeyV"
        ? select
        : e.code === "KeyN"
          ? note
          : e.code === "KeyP"
            ? pinTool
            : e.code === "KeyS"
              ? stringTool
              : e.code === "KeyM"
                ? marker
                : e.code === "KeyH"
                  ? highlighter
                  : e.code === "KeyE"
                    ? // The one key with a modifier on it. `E` takes whole
                      // records away and `Shift+E` rubs part of one out — two
                      // different tools, and DESIGN section 3.5 lists them as
                      // two rows of the same table.
                      e.shiftKey
                      ? smudge
                      : eraser
                    : null;
    if (!next) return;
    e.preventDefault();
    // Queued for the same reason `onDone` is: switching cancels the outgoing
    // tool's gesture, which touches the scene.
    queued.push(() => tools.setTool(next));
  });

  /**
   * > Size is `[` and `]`. — DESIGN section 3.9
   *
   * Only while something with a nib is in hand, and silent otherwise: the two
   * keys mean nothing to the select tool, and a board that quietly resized an
   * invisible nib when they were pressed would be teaching the wrong thing.
   *
   * The eraser has one too. It makes no mark, but its width is what decides how
   * much of a sweep it takes, and a rubber you cannot make smaller is one you
   * cannot aim at a mark next to a mark you want to keep.
   *
   * Not queued, unlike a tool change. Nothing about loading a pen touches the
   * scene or the document — it is the tool's own state, read at the next release
   * (`state/tools/marker.ts`) — so there is nothing for phase 9 to protect.
   *
   * Separate from the tool-picking listener above rather than another branch in
   * it, because that one is a switch over which tool to *become* and returns
   * early on anything else.
   */
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTextTarget(e.target)) return;
    const by = e.code === "BracketRight" ? 1 : e.code === "BracketLeft" ? -1 : 0;
    if (by === 0) return;
    const nibbed = penInHand() ?? (tools.current === eraser ? eraser : null);
    if (nibbed === null) return;
    e.preventDefault();
    nibbed.step(by);
  });

  /**
   * The context menu (DESIGN sections 3.2, 3.3 and 3.4).
   *
   * Ambient, like navigation and undo: a right-click means the same thing in
   * every tool, so it is not the tool machine's. The rows themselves are
   * `ui/boardmenu.ts`, which is a pure function of ids — this is only the part
   * that has to happen here, which is the hit test.
   *
   * ## Which of the three menus opens
   *
   * A pin, then a string, then an item, then bare cork — the same order a
   * left-click resolves in, because it is the order the things are physically
   * stacked in. `hitPin` first and in screen space, since a pin's grab radius
   * has a floor in pixels and is what `anchorAt` asks first too. `stringAt` for
   * the middle one, which is the *same* function the press and the hover
   * highlight go through, so the menu cannot offer a string a left-click would
   * not have grabbed: a string tucked under a photograph is not right-clickable
   * through the photograph either — and it is the item's menu that opens there,
   * which is the honest answer to a right-click on a photograph.
   *
   * `preventDefault` is duplicated with `Navigation`'s blanket one, which stops
   * the webview menu everywhere on the board including where this opens
   * nothing. Two calls, deliberately — the menu must not depend on some other
   * module happening to suppress the native one first.
   */
  const menu = new ContextMenu(world.layers.ui);

  /**
   * This board's invite link, or null when there is nothing to give away
   * (T-164).
   *
   * Declared here rather than beside the rest of the sync wiring below because
   * the context-menu handler closes over it, and the handler is registered
   * first. `board.ts` fills it in once the shell has answered with a secret, and
   * `rewire` replaces it when an invite moves this window to another board — so
   * it is a `let` on purpose, and reading it at any other time than menu-open is
   * a bug.
   */
  let invite: string | null = null;

  /**
   * Put the link where somebody can paste it, and say so.
   *
   * `navigator.clipboard` rather than a shell call: the webview is a secure
   * context, the click is the user activation the API wants, and adding a
   * clipboard *write* to `platform/types.ts` for one caller would mean building
   * it twice — the mock would need one too, and a browser's answer would be this
   * exact line.
   *
   * The failure path names the console rather than apologising, because there is
   * genuinely somewhere to go: the link is logged, and it can be copied from
   * there. A confirmation that only said "sorry" would leave somebody with no
   * next move.
   */
  const copyInvite = async (link: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link);
      flash.say("Invite link copied — send it to whoever should join this board");
    } catch (error) {
      console.warn(`[sync] the invite could not be copied: ${link}`, error);
      flash.say("Could not reach the clipboard — the invite link is in the console");
    }
  };

  root.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    // A right-click on the menu itself, or on the HUD. Chrome takes its own.
    if (isChromeTarget(e.target)) return;

    /**
     * Open, and queue the selection those rows were computed against.
     *
     * Queued to phase 9 with every other consequence of an input, so the halo
     * and the menu appear on the same frame rather than a frame apart. A
     * `select` of `undefined` means the target was already selected and the
     * selection is what the rows act on, so there is nothing to move.
     */
    const open = (rows: readonly MenuEntry[], select?: () => void): void => {
      if (rows.length === 0) return;
      if (select) queued.push(select);
      menu.openAt(e.clientX, e.clientY, rows);
    };

    /**
     * Right-clicking something already selected acts on the whole selection;
     * right-clicking something else acts on that one thing and takes the
     * selection with it.
     *
     * The second half is what stops the menu being a trap. Without it, a
     * right-click on an unselected string would offer verbs against whatever
     * happened to be selected somewhere off-screen — and the halo, which is the
     * only thing on the board that says what a verb will hit, would be pointing
     * at it rather than at the string under the cursor.
     */
    /**
     * A pen in hand short-circuits the four hit tests below, because with one
     * held a right-click is not about the paper under the cursor: there is no
     * selection to act on and no verb to offer a photograph that drawing on it
     * would want. The menu loads the pen instead — DESIGN section 3.9's palette,
     * which is given a page of colours and no key to pick them with.
     *
     * Before the tests rather than after, so it holds over a pin and a string
     * too. A pen does not care what is underneath, and a menu that changed its
     * mind depending on what a stray pixel of string was doing under the cursor
     * would be the worse surprise.
     */
    const pen = penInHand();
    if (pen !== null) {
      open(penMenuRows(pen));
      return;
    }

    const pinId = hitPin(e.clientX, e.clientY);
    if (pinId !== null) {
      const held = selection.hasPin(pinId);
      open(
        pinMenuRows(scene, writer, held ? [...selection.pins] : [pinId]),
        held ? undefined : () => selection.replaceThread([], [], [pinId]),
      );
      return;
    }

    const hit = stringAt(scene, camera, hitItem, hitPin, hitString, e.clientX, e.clientY);
    if (hit !== null) {
      const held = selection.hasString(hit.string);
      open(
        stringMenuRows(scene, writer, held ? [...selection.strings] : [hit.string]),
        held ? undefined : () => selection.replaceStrings([hit.string]),
      );
      return;
    }

    const board = camera.screenToBoard(e.clientX, e.clientY);
    const itemId = hitItem(board.x, board.y);
    if (itemId !== null) {
      const held = selection.has(itemId);
      open(
        itemMenuRows(
          scene,
          writer,
          itemId,
          held ? selection.toArray() : [itemId],
          board.x,
          board.y,
          startEditing,
        ),
        held ? undefined : () => selection.replace([itemId]),
      );
      return;
    }

    /**
     * Bare cork — the one case with nothing under the cursor to name, so the
     * menu is about the string selection as it stands, and about the board
     * itself (Q-76).
     *
     * The string rows are kept because a right-click *near* a string is a
     * right-click that missed by a few pixels, and a menu that vanished for it
     * would be worse than one that offers the string you are plainly pointing
     * at. What changed with T-164 is that empty cork with nothing selected is no
     * longer a gesture that opens nothing: it is where the invite lives, because
     * it was the only surface left and because the honest answer to "what is
     * here" on bare cork is the board.
     */
    open(
      boardMenuRows(scene, writer, [...selection.strings], { link: invite, copy: copyInvite }),
    );
  });

  const paste = new Paste({
    native,
    board,
    camera,
    cursor: () => tools.cursor,
    // Putting something down and then wanting to move it is one gesture in two
    // halves, so the second half starts with it already held.
    onCreated: (ids) => selection.replace(ids),
  });
  await paste.attach();

  const hud = new Hud(world.layers.ui, loop, () => stats());
  /**
   * The board-level half of DESIGN 7.5 — how many photographs nobody here has,
   * and whose they are. Silent, and touching no DOM at all, until there is one.
   */
  const notice = new Notice(world.layers.ui);
  /**
   * Where a verb with no visible result says it happened (T-164).
   *
   * Copying an invite is the first thing on this board that changes nothing on
   * the board, so it is the first that needs telling.
   */
  const flash = new Flash(world.layers.ui);
  /**
   * When the notice last checked that what it is counting is still on the board.
   *
   * The check is a scene walk, so it is throttled and — more to the point — only
   * runs at all once something is actually missing. A healthy board never pays
   * for it.
   */
  let noticeSweptAt = 0;
  let docBytes = 0;
  let docMeasuredAt = 0;
  const stats = (): HudStats => {
    // Encoding the whole document is cheap now and will not always be, so it
    // is measured at 1 Hz rather than at the HUD's 5 Hz paint rate.
    const now = performance.now();
    if (now - docMeasuredAt > 1000) {
      docMeasuredAt = now;
      docBytes = encodedSize(board);
    }
    // A board with no wire wants nothing, because nothing could bring it.
    const transfers = exchange?.stats() ?? { wanted: 0, inFlight: 0, percent: 0 };
    return {
      zoom: camera.zoom,
      cameraX: camera.x + camera.width / (2 * camera.zoom),
      cameraY: camera.y + camera.height / (2 * camera.zoom),
      // Everything phase 3 is stepping: items mid-swing plus ropes not yet
      // settled. One number, because it answers one question — is the
      // simulation asleep? — and a board at rest must read zero.
      awakeParticles: torsion.awake + ropes.awake,
      docBytes,
      items: scene.size,
      mounted: items.mounted,
      // Board-ink tiles count as inked surfaces and their backing stores count
      // as pixels. The HUD's ink numbers exist to make the memory risk (DESIGN
      // section 9.5, risk 5) watchable, and a tile is the largest single bitmap
      // on the board — leaving it out would be the one omission that matters.
      janitorPending: janitor.pending,
      janitorSwept: swept,
      assetsWanted: transfers.wanted,
      assetsInFlight: transfers.inFlight,
      assetsPercent: transfers.percent,
      assetsUnavailable: assets.countUnavailable(),
      inked: items.inked + boardInk.mounted,
      inkPixels: items.inkPixels + boardInk.pixels,
    };
  };

  /**
   * The debounced gesture end, where everything holding a bitmap re-rasterises
   * at the scale it is actually being displayed at (DESIGN section 6.6). A
   * photograph's "bitmap" is whichever stored variant it is pointed at, so this
   * is where it reconsiders.
   *
   * `everything()` because the choice depends on each item's size and there is no
   * cheaper way to say "every item may want a different file now". Once per
   * gesture, on the frame the whole world layer is repainting regardless.
   */
  world.onRasterize((scale) => {
    items.setRasterScale(scale);
    boardInk.setRasterScale(scale);
    dirty.everything();
  });

  // --- sync ----------------------------------------------------------------
  /**
   * The wire, if there is one.
   *
   * Everything above this line is a board that works alone; everything Phase 7
   * builds needs a provider to exist, and until now nothing constructed one.
   * `app/sync.ts` owns the decision of what to connect to — that part has cases
   * and is tested — and this owns the wiring, which does not.
   *
   * `provider` is null on a plain browser with no `?relay=`, which is the fast
   * dev loop working as designed rather than a failure: `platform/mock.ts`
   * refuses `syncStart` and the board is simply local. Every use below is
   * therefore guarded, and none of them is on a hot path.
   */
  /**
   * The compaction section 8.1 names, ticked in phase 9.
   *
   * It collects the records no cascade can reach — a string left with fewer than
   * two nodes that resolve to a pin, which two peers produce between them
   * without either of them being wrong (T-76 found both ways). Constructed
   * unconditionally because a board with no wire has them too, from a document
   * loaded off disk that was shared earlier.
   */
  const janitor = new Janitor(board);
  /** How many records it has collected this session, for the dev HUD. */
  let swept = 0;
  /**
   * Whether a collaborator has hold of a segment of this string — DATA-MODEL
   * section 5.4's advisory lock, which the janitor waits on rather than obeys.
   *
   * A walk of everybody's claims, which is a handful of peers holding almost
   * always nothing, and it is asked only about a string that is already ripe.
   * The lock lives in `render/presence/peers.ts` because it is drawn; the
   * janitor may not reach for it, so it is handed over.
   */
  const heldByAPeer = (stringId: string): boolean => {
    for (const peer of peers.peers()) {
      for (const lock of peer.locks) if (lock.string === stringId) return true;
    }
    return false;
  };

  // The address bar, or the invite that launched this window — see
  // `openingPlan`. Cold arrivals cost nothing here: there is no provider yet, so
  // the link is simply the plan.
  const plan = await openingPlan(() => native.syncTakeInvite(), window.location.search);
  if (plan.complaint !== null) console.warn(`[sync] ignored: ${plan.complaint}`);
  const address = await dialAddress(native, plan.config);
  const provider = address === null ? null : new WireProvider(board.doc, address);
  if (provider === null) console.info("[sync] local board — no relay to dial");
  else console.info(`[sync] ${plan.config.mode} · ${address}`);
  provider?.on("error", (error) => console.warn("[sync] error", error));
  provider?.on("denied", (reason) => console.warn(`[sync] denied: ${reason}`));

  /**
   * The peers this client finds for itself (T-70).
   *
   * One more provider per board the shell finds on the network, on this same
   * document and sharing this same awareness — see `app/mesh.ts` for why nobody
   * is elected and why no second `AssetExchange` is needed.
   *
   * Only where there is already a provider, because the awareness object to
   * share comes from it: with no wire at all there is nothing to join a peer
   * *to*, and under `platform/mock.ts` no peer is ever announced anyway.
   */
  const mesh =
    provider === null
      ? null
      : new Mesh({
          connect: (url) => {
            console.info(`[sync] found a peer at ${url.replace(/token=[^&]*/, "token=…")}`);
            const found = new WireProvider(board.doc, url, { awareness: provider.awareness });
            found.on("denied", (reason) => console.warn(`[sync] a found peer refused us: ${reason}`));
            found.on("error", (error) => console.warn("[sync] found peer error", error));
            return found;
          },
        });
  // Awaited for the same reason `asset:ready` is: `listen` is a round trip, and
  // a peer announced before it resolves is a peer this window never dials.
  if (mesh !== null) await native.on("sync:peer-found", (peer) => mesh.found(peer));

  /**
   * Work out what this board's invite says, now that the shell has a secret for
   * it (T-164).
   *
   * Asked of `syncStatus` rather than read off `plan.config`, because the plan
   * is what was *requested* and the secret is very often not in it: the ordinary
   * first launch of a board asks for no secret at all and the shell answers with
   * the one it found on disk or invented (Q-75). So the shell is the only place
   * that knows, and this is the round trip that gets it.
   *
   * Null on a plain browser, which is correct and not a gap — `platform/mock.ts`
   * has no relay to hold a secret, and the invite row simply does not appear.
   */
  const refreshInvite = async (boardId: string): Promise<void> => {
    const status = await native.syncStatus();
    invite = status.secret === null ? null : formatInvite({ boardId, secret: status.secret });
  };
  await refreshInvite(plan.config.boardId);

  /**
   * An invite clicked while this board is already open (T-165, Q-77).
   *
   * The **warm** arrival, and the one that has something to tear down: a
   * provider, a mesh, an asset exchange and a presence, all bound to the
   * connection this window has been using. Q-77 settled how — the window
   * reloads, and the whole boot path runs again against the new plan.
   *
   * That is not the lazy answer, it is the safe one. Nothing about the document
   * changes when you join another board — there is one per installation, and it
   * is on disk — so all that is really moving is the wire. Four things
   * individually detached and reattached is four ways to be left half-connected,
   * and the symptom of any of them is a board that looks synced and is not,
   * which is the most expensive kind of wrong this application has.
   *
   * The link's own query string is what the window reloads with, unchanged. That
   * is `inviteSearch`, and it is the whole "an invite is the address bar" idea
   * being spent rather than merely stated.
   */
  await native.on("deeplink:open", ({ url }) => {
    const search = inviteSearch(url);
    if (search === null) return;

    // Already here. Worth saying rather than silently doing nothing: somebody
    // who clicks an invite twice, or who clicks their own, has asked a question
    // and deserves the answer — and reloading for it would throw away their
    // camera and selection to arrive exactly where they already were.
    //
    // Compared as links rather than field by field, so there is one notion of
    // what "the same board" means and it is the one the user was handed. A link
    // carrying no secret cannot match — it is not a link this window would ever
    // have produced — so it reloads, and settles on the second pass once the
    // shell has answered with the secret it kept (Q-75).
    const arriving = parseInvite(url)?.config;
    const asLink =
      arriving?.secret === undefined
        ? null
        : formatInvite({ boardId: arriving.boardId, secret: arriving.secret });
    if (asLink !== null && asLink === invite) {
      flash.say("You are already on that board");
      return;
    }

    // The menu may be standing open with the *old* board's invite in it, which
    // would otherwise be copyable for the moment before the page goes. It is
    // also about to be a menu belonging to a board nobody is on.
    menu.close();
    flash.say("Joining that board…");
    window.location.search = search;
  });

  /**
   * The bytes behind the document (T-74).
   *
   * The document syncs an item saying "a 4032x3024 JPEG, sha256 abc…"; nothing
   * in it says what the pixels are, so without this a fully synced board is a
   * wall of empty frames.
   */
  if (provider !== null) {
    exchange = new AssetExchange(provider, native, {
      onProgress: (sha256, received, total) => {
        assets.transferring(sha256, received, total);
        // Bytes are moving, so whatever the notice said about this hash is over.
        // On `transferring` rather than on `ready` for the reason `assets` also
        // clears its sticky `unavailable` there: somebody who holds it has
        // turned up, and that is the news, not the last chunk.
        missing.arrived(sha256);
      },
      onUnavailable: (sha256, tried) => {
        assets.unavailable(sha256);
        // Who claimed it and could not produce it, kept so the board can say so
        // (DESIGN 7.5). This is the only moment those ids exist — the exchange
        // drops the want, and the set with it, on the line after this call.
        missing.unavailable(sha256, tried);
        console.warn(`[sync] nobody on this board has ${sha256.slice(0, 8)}`);
      },
    });
  }

  /**
   * What this client tells everybody else, every other frame (T-71).
   *
   * The scene is handed over as the pose source for the `grab` field: a drag is
   * published as where the held items *are*, which is a question only the scene
   * can answer, and `state/presence.ts` is what decides how much of that answer
   * reaches the wire.
   */
  const presence =
    provider === null
      ? null
      : new Presence(
          provider.awareness,
          camera,
          selection,
          scene,
          identityFor(board.doc.clientID),
        );

  /**
   * Everybody else's states, as they arrive.
   *
   * The arrival *time* is the reason this is a subscription rather than a poll of
   * `getStates()` in phase 2: `state/remote.ts` needs to know when a sample
   * landed, and only the moment it lands knows that. `change` rather than
   * `update` because `Awareness` bumps its own clock every fifteen seconds
   * whether anything changed or not, and a heartbeat is not a sample.
   *
   * Our own state is skipped. It is in `getStates()` like everyone else's, and
   * interpolating our own drag would fight the gesture making it.
   */
  /**
   * Remember a peer's name, for the notice about photographs only they have.
   *
   * `readPeer` is the same validation the cursors are drawn through, so the name
   * in the notice and the label on the cursor cannot disagree - and a state with
   * no `user` in it is skipped by both.
   */
  const nameFor = (client: number, state: unknown): void => {
    const peer = readPeer(state);
    if (peer !== null) missing.seen(client, peer.name, peer.color);
  };
  provider?.awareness.on(
    "change",
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const arrived = performance.now();
      const states = provider.awareness.getStates();
      for (const client of added) {
        const state = states.get(client);
        remote.observe(client, state, arrived);
        peers.observe(client, state);
        nameFor(client, state);
      }
      for (const client of updated) {
        const state = states.get(client);
        remote.observe(client, state, arrived);
        peers.observe(client, state);
        nameFor(client, state);
      }
      // Awareness drops a peer's state on disconnect by design, and this is the
      // only notice of it there is.
      for (const client of removed) {
        remote.forget(client);
        peers.forget(client);
        // Not a matching `forget`. A peer who has gone is the ordinary reason a
        // photograph is unavailable, so this is exactly when their name becomes
        // worth having (DESIGN 7.5) - `missing` keeps it and marks them absent.
        missing.left(client);
      }
    },
  );
  if (provider !== null) {
    remote.ignore(board.doc.clientID);
    peers.ignore(board.doc.clientID);
  }

  const resize = (): void => {
    const { innerWidth: w, innerHeight: h } = window;
    camera.resize(w, h);
    world.resizeCanvases(w, h);
    // Resizing blanks the backing store, so every cached screen-space path is
    // now a picture of a canvas that no longer exists.
    ropesUnder.invalidate();
    ropesOver.invalidate();
  };
  window.addEventListener("resize", resize);
  resize();

  // Best effort, and only worth the line because the window closing is the one
  // moment a whole batch can be in flight: a gesture that ended 199ms ago is
  // otherwise the one thing a clean exit loses.
  window.addEventListener("pagehide", () => void persistence.flush());

  // --- the nine phases (docs/ARCHITECTURE.md section 3) ---------------------

  let undoSelectionVersion = selection.version;
  /**
   * -1 rather than the camera's current version, so the first frame is dirty and
   * the culler and the screen-space layers all get one guaranteed pass.
   */
  let cameraVersion = -1;
  loop.on("input", (frame) => {
    navigation.flush();
    if (navigation.gestured) world.gestureTick(camera.zoom);
    tools.flush(frame.dt);
    // The camera is moved by navigation, by a resize, and by undo restoring a
    // stashed view in phase 9 of the frame before. Comparing the version once
    // per frame, here at the top, catches all three without any of them having
    // to remember to raise a flag — and it is phase 1, so phases 4 and 5 see it.
    if (camera.version !== cameraVersion) {
      cameraVersion = camera.version;
      dirty.camera = true;
      // Every camera change ends in a re-raster, not only a pointer gesture.
      // `Ctrl+0`, `F`, a resize and an undo restoring a stashed view all change
      // the zoom without `navigation.gestured` ever being true, and a bitmap
      // built for the old scale then stays stretched until somebody happens to
      // pan. Debounced like the rest — a keyboard fit is a gesture that took one
      // frame, and it re-rasters 180 ms later along with everything else.
      world.gestureTick(camera.zoom);
      // An open menu is anchored to a screen point that meant something when
      // it opened. Pan or zoom and it is a box of verbs pointing at whatever
      // has slid underneath it, so the camera moving dismisses it.
      menu.close();
    }
    // "Call stopCapturing() on pointer-up, tool change and selection change.
    // Explicit boundaries beat time-based grouping" — DATA-MODEL section 11.
    // Queued rather than called, so the gesture's own release write — queued a
    // line above, inside `tools.flush` — falls inside the entry this closes
    // instead of becoming the first thing in the next one.
    if (tools.gestureEnded || selection.version !== undoSelectionVersion) {
      undoSelectionVersion = selection.version;
      queued.push(() => undo.boundary());
    }
  });

  /**
   * Phase 2. Where everybody else's hands are.
   *
   * > PRESENCE — apply interpolated remote poses at (now − 100 ms)
   * > — ARCHITECTURE section 3
   *
   * Before phase 3, and that is the whole of AC-84: `RopeSet` pulls its anchors
   * out of the scene itself (`scene.layoutPin`), so a pose written here is the
   * anchor a rope swings from this frame, and a pose written any later would not
   * be. After phase 1, for the same reason the swing is: a remote peer's drag and
   * a local gesture both move items, and the sim has to see one frame's worth of
   * both rather than a mixture of this frame and last.
   */
  loop.on("presence", (frame) => {
    remote.apply(frame.now, frame.dt, scene, dirty);
  });

  /**
   * Phase 3. Two things move on their own — the swing of a single-pinned item
   * and the sag of a rope — and both are asleep unless something has just
   * disturbed them.
   *
   * After the tool machine, which is phase 1: the swing is composed on top of
   * whatever carry rotation a gesture in progress has built up, so it has to
   * read this frame's, not last frame's.
   *
   * Swings before ropes, and not the other way round: a rope hangs off pins,
   * a pin rides on an item, and an item's rendered pose is its stored one plus
   * the swing. Stepping ropes first would tie every string to where its
   * photograph was a frame ago. `RopeSet` pulls the pin positions it needs
   * current itself (`scene.layoutPin`), because the sweep that does that for
   * the whole board is phase 4 and runs after this.
   *
   * Nothing creates a string yet — that is T-41 and the binding — so today
   * this is an empty set stepping nothing. It is wired now so the ordering
   * above is settled before there is anything to get it wrong with.
   */
  loop.on("sim", (frame) => {
    torsion.step(scene, dirty, frame.dt, select.heldItems, select.carryLag, select.heldPivots);
    // After the torsion, never before it: the translation that holds a pin
    // still while its note is laid flat is computed from the settled angle,
    // and the torsion is what settles it.
    flatten.step(scene, dirty, frame.dt);
    ropes.step(scene, dirty, frame.dt);
  });

  /**
   * The pin the cursor is over, or null — the eyelet (DESIGN section 3.4).
   *
   * Resolved in the LAYOUT phase and consumed in the DOM phase, like culling,
   * because it is a question about where things are and the write phase may
   * only consume answers. It is asked *after* `layoutPins`, so it is this
   * frame's positions rather than last frame's.
   */
  let hoveredPin: string | null = null;
  /**
   * And the point on the string under it, which is the affordance the headline
   * gesture has:
   *
   * > Hover a string. The nearest point on the rope highlights, tracking your
   * > cursor along the curve. — DESIGN section 3.4
   *
   * Asked here rather than delivered to the tool, for the reason the pin hover
   * is: between gestures nothing has pointer capture, so the tool is never
   * handed a `move`. The *rule* is not duplicated though — `stringAt` is the
   * same function `state/tools/select.ts` puts a press through, given the same
   * three hit tests — so the highlight cannot offer something a press would
   * not do.
   */
  let hoveredString: { x: number; y: number } | null = null;
  let hoverAskedX = Number.NaN;
  let hoverAskedY = Number.NaN;
  loop.on("layout", () => {
    // World pin positions for items that moved. Nothing reads the DOM.
    // `dirty.pins` gets a pass too, and with the *item* set — which for a free
    // pin dragged across bare cork is empty, and an empty set is exactly right:
    // `layoutPins` always recomputes an unparented pin and skips every parented
    // one whose item is not in the set.
    if (dirty.all) scene.layoutPins();
    else if (dirty.items.size > 0 || dirty.pins.size > 0) scene.layoutPins(dirty.items);
    // And which items are near enough the viewport to be worth mounting. A read
    // phase, deliberately: the DOM phase below only consumes the answer.
    culler.update(scene, dirty, camera);

    // Asked only when the answer can have changed — the cursor moved, or the
    // board did. An idle board with the pointer at rest on it must stay free,
    // and a hit test is a walk over every pin.
    // Not while a stroke is being drawn, either. A lit pin or a highlighted
    // string tracking the nib is a second cursor arguing with the mark, and both
    // of them promise a gesture that the marker is not going to make.
    const cursor =
      navigation.panReady ||
      marker.stroking ||
      highlighter.stroking ||
      smudge.stroking ||
      eraser.sweeping
        ? null
        : tools.cursor;
    if (!cursor) {
      hoveredPin = null;
      hoveredString = null;
      hoverAskedX = Number.NaN;
    } else if (cursor.x !== hoverAskedX || cursor.y !== hoverAskedY || !dirty.isClean) {
      hoverAskedX = cursor.x;
      hoverAskedY = cursor.y;
      hoveredPin = pins.hitTest(scene, camera, cursor.x, cursor.y);
      // The select tool only, and not while it has hold of something. The
      // string tool's own affordance is the run it is building, and mid-gesture
      // the loop being pulled out is the feedback — a highlight tracking the
      // curve as well would be a second cursor.
      const offer =
        tools.current === select && !select.gesturing
          ? stringAt(scene, camera, hitItem, hitPin, hitString, cursor.x, cursor.y)
          : null;
      hoveredString = offer && { x: offer.x, y: offer.y };
    }

    /**
     * An undo landed last frame: can the person see what it moved? (Q-79,
     * `state/reveal.ts`.)
     *
     * Here, at the end of LAYOUT, because this is the first moment the answer
     * is true — `layoutPins` above has just put every moved pin where it now
     * is, and a pin whose photograph a collaborator dragged away is exactly the
     * case this exists for. A frame later than the undo for the same reason.
     *
     * Almost always a no-op: the undo entry carried the camera it was made at,
     * that view has just been restored, and what you edited was on screen when
     * you edited it. See the module for the case where those come apart.
     */
    if (revealChanged) {
      revealChanged = false;
      if (reveal(camera, changedBounds())) dirty.camera = true;
    }
  });

  /**
   * The box round everything the last undo lit, in board space, or null.
   *
   * Read off `flashes` rather than recomputed, because that is already the
   * answer to "what did this undo change" and computing a second one would be
   * two definitions of the same thing that could disagree.
   */
  const revealBox: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const revealOne: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const changedBounds = (): Bounds | null => {
    let seeded = false;
    for (const id of flashes.items.keys()) {
      const box = scene.boundsOf(id, 0, revealOne);
      if (box === null) continue;
      widen(revealBox, box, seeded);
      seeded = true;
    }
    for (const id of flashes.pins.keys()) {
      const pin = scene.pins.get(id);
      if (pin === undefined) continue;
      // A point, not a box. A pin has no extent worth framing and the camera
      // centres on the union, so one contributes its position and nothing else.
      revealOne.minX = revealOne.maxX = pin.wx;
      revealOne.minY = revealOne.maxY = pin.wy;
      widen(revealBox, revealOne, seeded);
      seeded = true;
    }
    for (const id of flashes.strings.keys()) {
      // The pins it hangs from, not `ropes.boundsOf`.
      //
      // The rope's box is the *drape*, and a drape is transient: this is read
      // one frame after the undo, while the solver is still settling into the
      // slack that was just restored, and a mid-settle box is far bigger than
      // the one the string comes to rest in. Driven, that showed as a camera
      // that went to the right place and then sat two and a half times zoomed
      // out from what the string needed. The pins are where LAYOUT has just put
      // them and do not move again.
      const run = scene.strings.get(id);
      if (run === undefined) continue;
      for (const node of run.nodes) {
        const pin = scene.pins.get(node.pin);
        if (pin === undefined) continue;
        revealOne.minX = revealOne.maxX = pin.wx;
        revealOne.minY = revealOne.maxY = pin.wy;
        widen(revealBox, revealOne, seeded);
        seeded = true;
      }
    }
    return seeded ? revealBox : null;
  };

  /**
   * The cursor, which is the only affordance two of this board's gestures have.
   *
   * Nothing is drawn for a resize edge — "notes, cards and scraps resize from
   * their edges" and the edge is the handle — so without this the band is
   * invisible, and a drag that started 4 px inside a note's edge and made it
   * taller instead of moving it would read as the board misbehaving.
   *
   * The wheel is the same problem in a worse place. It zooms the camera unless
   * a selected segment is under the cursor, in which case it adjusts that
   * segment's sag (DESIGN section 3.4) — and until now nothing said which of
   * the two the next notch would be, so the first one was an experiment. Losing
   * that experiment is expensive: a notch meant for a string and taken by the
   * camera goes from 49% to 6% zoom in one roll, and the way back is `Ctrl`+`0`.
   *
   * `row-resize` for it — a line with an arrow either side of it, which is what
   * the gesture is: the string, and the sag going up or down. Deliberately not
   * one of `handleCursor`'s four resize cursors or its `grab`, because those
   * already mean "drag from here" on this board and this one means "roll here".
   *
   * A DOM write, so it belongs in phase 5 with the other ones, and it is written
   * only when the answer changes. `panReady` is the truce with `Navigation`,
   * which owns this same property while the space bar is down: null means "it
   * wrote something, so say it again when it hands back".
   */
  const handleFrame = emptyFrame();
  let writtenCursor: string | null = "";
  const applyCursor = (): void => {
    if (navigation.panReady) {
      writtenCursor = null;
      return;
    }
    const frame = chromeFrame(camera, scene, selection, handleFrame);
    const hover = tools.cursor;
    // The active handle wins: mid-gesture the pointer is nowhere near the edge
    // it took hold of, and a cursor that reverted would read as a dropped grab.
    const handle =
      select.activeHandle ?? (frame && hover ? handleAt(frame, hover.x, hover.y) : null);
    // The handle first, because a handle is something you are already touching
    // and the wheel is something you might do next — and the two overlap the
    // moment a selected string crosses a selected note's edge.
    const want =
      frame && handle ? handleCursor(handle, frame.angle) : tools.wheelClaimed ? "row-resize" : "";
    if (want === writtenCursor) return;
    writtenCursor = want;
    root.style.cursor = want;
  };

  loop.on("dom", () => {
    world.applyCamera(camera);
    cork.apply(camera);
    /**
     * The paper somebody is writing on can be taken away underneath them — a
     * peer's delete, an undo, a document that resynced. Closing it here rather
     * than waiting for the field to be pulled out of the document, because a
     * focused node that is removed does not reliably fire `blur`, and the one
     * thing worse than losing the note is keeping a caret that belongs to it.
     */
    const writing = items.editing;
    if (writing !== null && !scene.has(writing)) items.edit(null, "");
    items.sync(scene, dirty, culler.visible);
    pins.sync(scene, camera, dirty, hoveredPin);
    applyCursor();
  });

  /**
   * Phase 6. The committed ink, on each item's own canvas inside its rotated
   * node.
   *
   * A phase of its own rather than part of the DOM phase above, because the two
   * are woken by different things: that one writes a transform for everything
   * that moved, this one fills a bitmap for the few items somebody drew on. A
   * board where a photograph is being dragged runs the DOM phase every frame and
   * this one never — which is the whole of what "ink inside the item's
   * transform" buys (DESIGN section 6.2).
   */
  /**
   * Whether the document has this stroke *and* the canvas it belongs on is
   * showing it — the whole of DATA-MODEL section 9.2's handoff, asked of a run
   * id that arrived over awareness.
   *
   * Deliberately the same two questions the local wet/dry handoff below asks,
   * of the same two objects: a peer's mark and ours land on the same surfaces
   * through the same layers, and a ghost that retired on a weaker test than our
   * own would blink for exactly the frames the local one was written to cover.
   * The only extra step is `strokeSurface`, because a peer's run says which
   * *item* it is on and never which board tile — that is the sender's
   * bounding-box centre, and this client may hold a shorter piece of the mark.
   */
  const inkLanded = (id: string): boolean => {
    const surface = scene.strokeSurface(id);
    if (surface === null) return false;
    return surface.kind === "item"
      ? !items.awaitingInk(surface.id)
      : !boardInk.awaitingTile(surface.key);
  };

  loop.on("ink", (frame) => {
    items.paintInk(scene, dirty);
    // The cork's ink, in the same phase and for the same reason: it is a bitmap
    // filled for the few tiles somebody drew in, not a transform written for
    // everything that moved.
    boardInk.paint(scene, dirty, camera);
    /**
     * The live smudge, rubbed into the real bitmap — and it has to be here,
     * after both re-rasters and before the overlay.
     *
     * A hole cannot be previewed. `destination-out` on the wet overlay would
     * punch through the chrome and leave the ink untouched, because the ink is
     * on a different canvas; so the wet path writes to the dry surface for this
     * one tool, and the commit's full repaint from records is what makes it true
     * (`InkCanvas.rub`). Every frame of the gesture rather than once, because a
     * re-raster for any other reason wipes the hole.
     *
     * `runsInFlight` covers the drying runs as well as the live one, which is
     * exactly right: the hole has to keep being drawn until the record that
     * replaces it has reached the bitmap. And it is a list because a rub that
     * crosses off the paper is several runs like any other gesture (T-137) — the
     * piece on the photograph takes ink off the photograph and the piece on the
     * cork takes it off the cork, which is what you would expect of a rubber
     * dragged over the edge of a sheet of paper.
     */
    for (const rubbing of smudge.runsInFlight) {
      if (rubbing.item === null) boardInk.rub(rubbing.samples, rubbing.size);
      else items.rubInk(rubbing.item, rubbing.samples, rubbing.size);
    }
    // The handoff, and it is after the raster and before the overlay on purpose:
    // the frame that finally puts a committed stroke on its surface's canvas is
    // the frame that may stop drawing the wet copy of it, and neither an earlier
    // nor a later phase is both.
    //
    // Asked of whichever layer owns each surface rather than counted in frames,
    // because the answer is genuinely not a number of frames — see
    // `ItemLayer.awaitingInk`.
    //
    // *Every* surface, and the overlay copies all go together. Half a mark
    // lingering while the other half has landed would be a seam that brightens
    // for a frame, which is a worse artefact than the overlap it would save.
    const waiting =
      drying !== null &&
      drying.some((surface) =>
        surface.kind === "item" ? items.awaitingInk(surface.id) : boardInk.awaitingTile(surface.key),
      );
    if (drying !== null && !waiting) {
      drying = null;
      dried();
    }
    // And everybody else's, by the same rule in the same phase — section 9.2 is
    // one sentence about both pens. Not folded into the block above because the
    // two are the opposite way round: ours waits on a list of surfaces this
    // client committed to and then drops every overlay copy together, and
    // theirs asks per run, since a peer's ghosts arrive and land independently
    // and there is no gesture here to keep whole.
    if (provider !== null) peers.retire(frame.dt, inkLanded);
  });

  /**
   * Phase 7. Under first, then over, which is only a matter of taste — they are
   * separate canvases and the stacking is CSS. Both are cheap to *ask*: a frame
   * where the camera is still and no rope moved returns without touching either
   * context.
   */
  /** The board-space cursor, or null when the pointer is off the board. */
  const cursorBoard = (): { x: number; y: number } | null =>
    tools.cursor ? camera.screenToBoard(tools.cursor.x, tools.cursor.y) : null;
  /**
   * A run drawn on the overlay, from whichever gesture is drawing one: the
   * string tool building a run, `Alt`+drag pulling one out of a pin, or a loop
   * pulled out of the middle of an existing string.
   *
   * The loop is dashed end to end and the other two only in the leg chasing the
   * cursor, because that is the difference between them: the first two have
   * stops that were already decided, and the loop has nothing decided until it
   * is let go.
   */
  const pendingRun = (): PendingRun | null => {
    const cursor = cursorBoard();
    if (tools.current === stringTool) {
      const points = stringTool.preview(cursor);
      return points ? { points, dashed: "tail" } : null;
    }
    const loop = select.loopPreview(cursor);
    if (loop) return { points: loop, dashed: "all" };
    const pull = select.pullPreview(cursor);
    return pull ? { points: pull, dashed: "tail" } : null;
  };

  loop.on("ropes", () => {
    ropesUnder.draw(scene, ropes, camera, dirty);
    ropesOver.draw(scene, ropes, camera, dirty);
  });

  loop.on("overlay", (frame) => {
    // Before the draw, not after: a peer's cursor is sprung towards where they
    // last said it was, and the frame that moves it is the frame that has to
    // find the canvas stale (`render/presence/peers.ts`).
    if (provider !== null) peers.step(frame.dt);
    // Likewise before the draw, and for the same reason: a flash that faded
    // this frame is a different picture, and the frame it reaches zero on is the
    // frame the canvas has to clear it off.
    flashes.step(frame.dt);
    // Selection chrome is drawn here, not on the item nodes, so its width is in
    // screen pixels at every zoom (T-91). `dirty` comes along only so it can tell
    // "a selected photograph is being dragged" from "nothing has changed".
    overlay.draw(
      camera,
      scene,
      selection,
      select.marquee,
      dirty,
      select.pinCandidate,
      // The machine's hover, not a `move` the tool was handed: between clicks
      // nothing is captured, so the tool never hears about the pointer.
      // A run being drawn, by whichever gesture is drawing one — see
      // [`pendingRun`].
      pendingRun(),
      // Where the ropes hang, for haloing the selected ones, and the point on
      // one the cursor is over (DESIGN section 3.4).
      ropes,
      hoveredString,
      // > | See its threads | Hover | Every string through the pin highlights |
      // > — DESIGN section 3.3
      //
      // The same hover the pin layer uses for the eyelet ring, resolved once in
      // the layout phase and read by both.
      hoveredPin,
      // The stroke being drawn, if a pen is the tool holding the board.
      // Asked of the tool rather than tracked here for the same reason
      // `pendingRun` is: the gesture owns its own transient, and nothing about it
      // is in the scene.
      //
      // Never the smudge. That one is already on the ink canvas (the INK phase
      // above), and drawing it here as well would paint an opaque mark over the
      // hole it just made — the exact "visibly wrong" the erase tool spent a
      // task avoiding.
      wetPen()?.runsInFlight ?? NO_WET_RUNS,
      // Everybody else: their cursors, and the chrome for what they have hold
      // of. Null on a board with no wire, which costs the overlay one null check
      // and no walk at all.
      provider === null ? null : peers,
      // What the last Ctrl+Z moved, so an undo that reached somewhere you were
      // not looking is never silent (DESIGN section 7.6).
      flashes,
    );
    hud.update(frame.now);
    if (missing.count > 0 && frame.now - noticeSweptAt > NOTICE_SWEEP_MS) {
      noticeSweptAt = frame.now;
      // An item wearing a missing photograph can just be deleted, and nothing
      // announces that. This is the cheap way to notice, and it is behind the
      // count so a board with nothing missing never walks anything.
      const referenced = new Set<string>();
      for (const id of scene.itemIds()) {
        const asset = scene.cold(id)?.assetId;
        if (asset) referenced.add(asset);
      }
      missing.retain(referenced);
    }
    notice.update(missing.notice());
  });

  /**
   * Whether a gesture was holding anything on the frame before.
   *
   * `select.heldItems` empties on release, so the release itself is a *transition*
   * and cannot be read off the current state. One boolean, and it is what makes
   * the `final` grab go out — the message a peer needs to start section 9.2's
   * handoff, and the one thing a grab that merely vanished would not tell it.
   */
  let wasGrabbing = false;
  loop.on("flush", (frame) => {
    if (presence !== null) {
      const cursor = cursorBoard();
      if (cursor === null) presence.pointerGone();
      else presence.pointerAt(cursor.x, cursor.y, tools.active.id);
      // The segment a mid-string split has hold of, if any — a hint for
      // everybody else and nothing more (DATA-MODEL section 5.4). Published
      // beside the grab because it is the same kind of statement: this is what
      // I have hold of right now.
      presence.splitting(select.heldSegment);
      // The stroke under the pen, sampled every frame even though it is sent
      // every other one: the decimation that makes the window constant-size
      // (DATA-MODEL section 9.1) has to see the samples that arrive in between,
      // or a remote preview is half the resolution of the mark being made.
      // The same accessor the OVERLAY phase draws from, so a peer sees what is
      // on this client's overlay and never the smudge.
      presence.drawing(wetPen()?.runsInFlight ?? NO_WET_RUNS);
      const holding = select.heldItems.size > 0;
      if (holding) presence.grabbing(select.heldItems);
      else if (wasGrabbing) presence.released();
      wasGrabbing = holding;
      // Last, so it sends what the three lines above just staged. Every other
      // frame at most, and only when something changed (T-71).
      presence.flush(frame.index);
    }

    /**
     * Compaction, rate-limited to once a second inside `Janitor.tick` — so this
     * is a subtraction and a comparison on the frames it does nothing, which is
     * all but one in sixty.
     *
     * Two conditions on running at all, and both are about *not* collecting a
     * board this client has only half of:
     *
     *   - **Synced, if there is a wire.** `WireProvider` distinguishes connected
     *     from synced precisely because the handshake sits between them, and a
     *     connected-but-unsynced board is one whose pins may not have arrived
     *     yet. Every string on it reads as beyond repair.
     *   - **Present includes us.** `elected` refuses to act when the caller
     *     cannot say who is on the board, which is not the same as being alone.
     *     Our own id is passed explicitly rather than relied on from
     *     `getStates()`, because presence only puts this client in that map
     *     after its first publishing frame.
     *
     * The settle period inside the janitor is the real safety net for both, but
     * these cost nothing and mean it is never even asked.
     */
    if (provider === null || provider.synced) {
      swept += janitor.tick(
        frame.now,
        provider === null
          ? [board.doc.clientID]
          : [board.doc.clientID, ...provider.awareness.getStates().keys()],
        heldByAPeer,
      ).length;
    }

    // Everything downstream has consumed this frame's changes.
    dirty.clear();
    // Then, and only then, the document writes this frame's input asked for.
    // After the clear, so the dirty flags the binding sets in response belong
    // to the next frame instead of being wiped by this one.
    for (const write of queued) write();
    queued.length = 0;
  });

  /**
   * Settle the swing before framing anything.
   *
   * `contentBounds` is the box the board is *drawn* in: `boundsAt` turns an
   * item by `rot + swing` and centres it on `x + drift`, both of which phase 3
   * owns and neither of which exists until phase 3 has run once. Framing
   * before that frames every hanging item un-hung, so the opening view and
   * `Ctrl+0` a moment later disagreed by three percent of zoom on a real board
   * — and deterministically, every single time, which read as the shortcut
   * being subtly wrong rather than as the two being taken of different scenes
   * (T-135).
   *
   * Not a simulation. `binding.start()` has just resynced, so `dirty.all` is
   * up and phase 3 takes its settle branch: every item placed at its
   * equilibrium with no motion (DESIGN section 5.3, and T-110 for why an
   * arriving item never animates). `dt` of zero says so — there is no substep
   * to take, and nothing to integrate.
   *
   * Ropes need no equivalent. A rope is seeded analytically and asleep, and
   * `contentBounds` does not look at particles anyway.
   */
  torsion.step(scene, dirty, 0);

  // An empty board is the correct first thing to see. Nothing seeds it any
  // more: there is a real way to put things on it now, and a board that opens
  // holding somebody else's placeholders is a demo rather than a tool.
  // No margin argument: the opening view and `Ctrl+0` are the same view, so
  // they take the same default (T-135).
  camera.fit(scene.contentBounds() ?? { minX: -400, minY: -300, maxX: 400, maxY: 300 });
  // The zoom the board opens at is a zoom nobody gestured into, and until this
  // was here every bitmap was built for a scale of 1 — a board opened at 50%
  // spent twice the pixels it needed on ink, and one opened at 200% on a 2x
  // display drew it at a quarter of the resolution, both until the first pan.
  world.settle(camera.zoom);

  /**
   * `window.schizo` — a handle on the running board, for driving it from
   * outside the window.
   *
   * Dev builds only. `import.meta.env.DEV` is a compile-time constant, so the
   * whole block is dropped from a production bundle rather than merely being
   * unreachable in one.
   *
   * ## Why it exists
   *
   * "Does it actually work" is a question about the running application, and
   * the test suite cannot answer it. Three times now the answer has been no in
   * a way nothing else caught: the highlight on a default-thickness string
   * rasterised to a smear and made every string look flat; `Enter` never
   * reached tools at all, because `machine.ts` forwards a keydown allowlist
   * and nothing had previously ended a gesture on a keystroke; and the leg of
   * a string run chasing the cursor was simply missing, because a tool is only
   * handed `move` while a pointer is captured. Every one of those passed every
   * unit test, twice — before and after the fix.
   *
   * It also covers the gap where a capability lands before the interaction
   * that reaches it. The string ops, the simulation and the painter were all
   * finished before the tool that lets a person draw one, and without this
   * there was no way to put a string on screen and look at it.
   *
   * ## What belongs in it
   *
   * The board's own long-lived objects, and nothing that exists only to be
   * driven. It is a window onto the application, not an API for it: anything
   * here must be something the application already has and already uses, so
   * that reaching through this handle and reaching through the app cannot
   * disagree. `snapshot` is the one function rather than an object, and it is
   * a one-line call to something `crdt/doc.ts` already exports.
   *
   * Nothing in the application may read it. It is write-only from here.
   */
  if (import.meta.env.DEV) {
    (window as unknown as { schizo: unknown }).schizo = {
      board,
      scene,
      camera,
      ropes,
      dirty,
      /**
       * What the last undo lit, and how far through its fade each one is.
       *
       * Next to `dirty` because it is read from it. A flash lasts under a
       * second and is the one piece of chrome on this board that a screenshot
       * can genuinely miss, so the pixels want a reading beside them that says
       * what was supposed to be on the canvas at the time.
       */
      flashes,
      /**
       * Everybody else, as this board has them — the store the overlay draws
       * from, cursors and hold-chrome and claimed segments alike.
       *
       * Here for the same reason `flashes` is: what a peer has hold of is often
       * off screen, or is a fringe five pixels wide on a rope, and a screenshot
       * cannot say whether the claim arrived or merely was not drawn. This can.
       * Empty rather than absent on a board with no wire, which is the honest
       * answer for a board that is alone.
       */
      peers,
      /**
       * The wire, or null on a board that is alone — for the awareness channel
       * itself, which `peers` above only shows the drawn half of.
       *
       * `provider.awareness.getStates()` is the raw state of every client on
       * the board, and it is the only readout there is for a field that has
       * been published before anything renders it. That is not a hypothetical
       * gap: `wet` went on the wire in T-168 and is drawn in T-169, and without
       * this there was no way to tell a sliding window that never left the
       * machine from one that arrived and simply was not painted.
       */
      provider,
      loop,
      ops,
      tools,
      /**
       * The asset transfer, or null on a board with no wire (T-74).
       *
       * Here because the HUD cannot be trusted to answer for it: a second
       * browser window on the same board is a *background* window, and Chromium
       * throttles its rAF — so the HUD reads whatever frame it last managed,
       * which during a transfer is a number that has since moved. This is the
       * live one.
       */
      exchange,
      /**
       * What each photograph's bytes are doing (T-95).
       *
       * The HUD counts them; this says which hash is in which state, which is
       * the only way to check a transition from outside while T-75 has yet to
       * draw any of them.
       */
      assets,
      /** The document as persistence would write it — for reopening a board
       *  and checking it comes back still (Phase 3's AC-15). */
      snapshot: () => snapshot(board),
    };
  }

  loop.start();

  // `asset:ready` only ever fires for something ingested *this run*, so on the
  // second launch of a board every photograph on it would sit undeveloped
  // forever. Ask the store what it has once the document is loaded, and let the
  // answer stand in for the events that already happened.
  const reconcileAssets = async (): Promise<void> => {
    const referenced = new Set<string>();
    for (const id of scene.itemIds()) {
      const asset = scene.cold(id)?.assetId;
      if (asset) referenced.add(asset);
    }
    if (referenced.size === 0) return;
    const hashes = [...referenced];
    const present = await native.assetHas(hashes);
    hashes.forEach((sha256, i) => {
      if (!present[i]) {
        // The backfill tier: an item somewhere on this board whose photograph
        // is not on this disk. Asked for at idle priority, so it queues behind
        // anything the person is actually looking at, which `assetUrl` raises
        // as it is drawn.
        if (exchange === null) {
          // No wire, and the store has just said it does not have this. Nothing
          // is going to bring it, and this is the only place that can tell —
          // `assetUrl` sees a missing photograph but not whether it is missing
          // because it is late or because it was never here.
          assets.unavailable(sha256);
          // And nobody to name, which is a notice in its own right (DESIGN 7.5):
          // this board has no wire, so the count is the whole of what can be
          // said about it.
          missing.unavailable(sha256);
          return;
        }
        exchange.want(sha256);
        assets.requesting(sha256);
        return;
      }
      holdsAsset(sha256);
    });
  };
  void reconcileAssets();

  // Again on every (re)connection. A peer that joined an hour after this window
  // opened brought a document full of photographs with it, and nothing else
  // walks the board to notice them — `assetUrl` catches only the ones that are
  // on screen.
  provider?.on("status", (status) => {
    if (status === "synced") void reconcileAssets();
  });

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent =
    (persistence.readOnly
      ? "THIS BOARD IS NOT BEING SAVED — the document on disk could not be read, " +
        "and is being left alone rather than written over. See the console. · "
      : "") +
    `platform: ${native.kind} · paste a picture or some text, or drop a file in · ` +
    `N then click for a blank sheet · P then click for a pin · V back to select · ` +
    `drag a pin to move it, onto an item to parent it, Ctrl to keep it put · ` +
    `Alt+click a pin removes it · Alt+drag pulls a new string out of one · ` +
    `drag the middle of a string to pull a new pin out of it, click it to select · ` +
    `right-click a string for its menu · M or H to draw, right-click for ink · ` +
    (invite === null ? "" : `right-click the cork to copy an invite link · `) +
    `E rubs a whole stroke out and Shift+E smudges part of one away · ` +
    `[ and ] size the nib, Ctrl at pen-down means the cork · ` +
    `drag to move · drag the handle or R+drag to rotate · drag a note's edge to resize · ` +
    `drag the cork to marquee · Delete removes · ` +
    `Ctrl+Z undoes · space+drag pans · Ctrl+0 fit · F frame · \` for the HUD`;
  world.layers.ui.append(hint);
  hud.toggle();
}

/**
 * The phase-0 fidelity spike replaces the whole application when asked for.
 * `import.meta.env` is statically replaced, so with the variable unset this
 * branch and the module behind it are eliminated from the bundle entirely.
 *
 *   $env:VITE_SPIKE=1;      npm run tauri dev    # will-change discipline
 *   $env:VITE_SPIKE=pinned; npm run tauri dev    # the blurry control
 *   $env:VITE_SPIKE=culled; npm run tauri dev    # the discipline, with culling
 */
if (import.meta.env["VITE_SPIKE"]) {
  void import("@/spike/fidelity").then((spike) => spike.run());
} else {
  void boot();
}
