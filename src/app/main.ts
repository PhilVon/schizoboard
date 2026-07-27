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
  setNodeSlack,
  setStringSlack,
  setStringStyle,
} from "@/crdt/ops";
import { Origin } from "@/crdt/origins";
import { Persistence } from "@/crdt/persistence";
import { UndoHistory } from "@/crdt/undo";
import { noteSizeFor } from "@/app/ingest";
import { Paste } from "@/app/paste";
import { DEFAULT_ERASER_SIZE, type InkSurface } from "@/lib/ink";
import { initPlatform } from "@/platform";
import { variantFor } from "@/platform/types";
import { Cork } from "@/render/cork";
import { Culler } from "@/render/cull";
import { BoardInkLayer } from "@/render/ink/board";
import { DomItemLayer } from "@/render/items/dom";
import { FrameLoop } from "@/render/loop";
import { Overlay, type PendingRun } from "@/render/overlay";
import { PinLayer } from "@/render/pins/dom";
import { RopeLayer } from "@/render/ropes/paint";
import { World } from "@/render/world";
import { RopeSet, type RopeHit } from "@/sim/ropes";
import { Torsion } from "@/sim/torsion";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { chromeFrame, emptyFrame, handleAt, handleCursor } from "@/state/handles";
import { isChromeTarget, isTextTarget } from "@/state/input";
import { Navigation } from "@/state/navigation";
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
import { itemMenuRows, penMenuRows, pinMenuRows, stringMenuRows } from "@/ui/boardmenu";
import { Hud, type HudStats } from "@/ui/hud";
import { ContextMenu, type MenuEntry } from "@/ui/menu";

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

  // --- presentation --------------------------------------------------------
  const camera = new Camera();
  const world = new World(root);
  const cork = new Cork(world.layers.cork, boardSeed(board));
  /**
   * Which assets this machine can actually show.
   *
   * `platform/types.ts` says `assetUrl` "returns an empty string for an asset
   * this process has never seen, which the item renders as its `unknown` state
   * rather than as an error" — and under the shell it cannot keep that promise
   * on its own, because building the URL is pure string work that knows
   * nothing about what is on disk. So the knowledge lives here, and this is
   * the local per-asset state DATA-MODEL section 9 says is never in the
   * document.
   *
   * It matters more than a contract detail. Without it an item points an
   * `<img>` at bytes that have not arrived, gets a 404, and the only thing
   * standing between the user and a broken-image icon is an error handler. With
   * it, an item with no photograph yet is simply an item with no photograph
   * yet — undeveloped film, which is what DESIGN section 7.5 asks for.
   */
  const showable = new Set<string>();
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
  const assetUrl = (sha256: string, screenPx: number): string =>
    showable.has(sha256) ? native.assetUrl(sha256, variantFor(screenPx)) : "";
  const items = new DomItemLayer(world.layers.world, assetUrl);
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

  // Awaited, not fired and forgotten: `listen` is itself a round trip, and an
  // `asset:ready` emitted before it resolves is simply lost — which would
  // strand that one photograph undeveloped for the session while every later
  // one worked.
  await native.on("asset:ready", ({ sha256 }) => {
    showable.add(sha256);
    refreshAsset(sha256);
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
     * `crdt/` may not read it. The segment's own slack does not: the op reads
     * that inside its transaction, which is what makes the `queued.push` below
     * safe — the write runs at the next flush, and by then the number the
     * gesture saw may be a peer's edit old (DATA-MODEL section 5.4).
     */
    insertPin: (stringId, index, anchor, split, settle) => {
      const at = { ...anchor };
      const cut = { ...split };
      const poses = settled(settle);
      queued.push(() => insertPinIntoString(board, stringId, index, at, cut, poses));
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
    queued.push(intent === "undo" ? () => undo.undo() : () => undo.redo());
  });

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
        ),
        held ? undefined : () => selection.replace([itemId]),
      );
      return;
    }

    /**
     * Bare cork — the one case with nothing under the cursor to name, so the
     * menu is about the string selection as it stands and moves nothing.
     *
     * Kept because a right-click *near* a string is a right-click that missed
     * by a few pixels, and a menu that vanished for it would be worse than one
     * that offers the string you are plainly pointing at. Nothing opens when
     * nothing is selected, which is the empty cork case.
     */
    open(stringMenuRows(scene, writer, [...selection.strings]));
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

  // 2 PRESENCE  T-72

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
  });

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
  loop.on("ink", () => {
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
      wetPen()?.runsInFlight ?? [],
    );
    hud.update(frame.now);
  });

  loop.on("flush", () => {
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
      loop,
      ops,
      tools,
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
  void (async () => {
    const referenced = new Set<string>();
    for (const id of scene.itemIds()) {
      const asset = scene.cold(id)?.assetId;
      if (asset) referenced.add(asset);
    }
    if (referenced.size === 0) return;
    const hashes = [...referenced];
    const present = await native.assetHas(hashes);
    hashes.forEach((sha256, i) => {
      if (!present[i]) return;
      showable.add(sha256);
      refreshAsset(sha256);
    });
  })();

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
