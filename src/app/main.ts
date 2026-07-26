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
import { boardSeed, encodedSize, initialiseBoard, openBoardDoc } from "@/crdt/doc";
import { deleteItems, setItemPoses } from "@/crdt/ops";
import { Origin } from "@/crdt/origins";
import { Persistence } from "@/crdt/persistence";
import { UndoHistory } from "@/crdt/undo";
import { Paste } from "@/app/paste";
import { initPlatform } from "@/platform";
import { variantFor } from "@/platform/types";
import { Cork } from "@/render/cork";
import { Culler } from "@/render/cull";
import { DomItemLayer } from "@/render/items/dom";
import { FrameLoop } from "@/render/loop";
import { Overlay } from "@/render/overlay";
import { World } from "@/render/world";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { isTextTarget } from "@/state/input";
import { Navigation } from "@/state/navigation";
import { Scene } from "@/state/scene";
import { Selection } from "@/state/selection";
import { ToolMachine } from "@/state/tools/machine";
import { SelectTool } from "@/state/tools/select";
import type { BoardWriter } from "@/state/tools/tool";
import { Hud, type HudStats } from "@/ui/hud";

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
   * Which items are worth having in the DOM. The spike (D-12) measured the
   * gesture-end repaint at 777 ms with 500 live nodes, so this is load-bearing
   * rather than an optimisation — see `render/cull.ts`.
   */
  const culler = new Culler();
  const loop = new FrameLoop();
  const selection = new Selection();
  const navigation = new Navigation(camera, root, {
    contentBounds: () => scene.contentBounds(),
    selectionBounds: () => scene.boundsOfMany(selection.members),
  });

  // --- interaction ---------------------------------------------------------

  /**
   * Document writes a tool asks for are *queued*, not made. They land in phase
   * 9, below, so no observer can move the scene out from under a frame that
   * phases 4 and 5 have already read (ARCHITECTURE section 3).
   */
  const queued: (() => void)[] = [];
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
    deleteItems: (ids, keepPins) => {
      const snapshot = [...ids];
      queued.push(() => deleteItems(board, snapshot, { keepPins }));
    },
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
      selection: selection.toArray(),
    }),
    restoreView: (view) => {
      camera.setView(view.x, view.y, view.zoom);
      // Undoing a paste un-creates what it selected, so a stashed selection
      // can name things that no longer exist. A selection holding a ghost
      // makes the next Delete an op that quietly does nothing, which is the
      // confusing kind of nothing.
      selection.replace(view.selection.filter((id) => scene.has(id)));
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
  const tools = new ToolMachine(select, root, {
    scene,
    dirty,
    camera,
    selection,
    write: writer,
    hitTest: (bx, by) => items.hitTest(scene, bx, by),
    // Space+drag and middle-drag belong to the camera, not to the board.
    suppressed: () => navigation.panReady,
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
      awakeParticles: 0, // sim/ropes.ts, T-40
      docBytes,
      items: scene.size,
      mounted: items.mounted,
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
    dirty.everything();
  });

  const resize = (): void => {
    const { innerWidth: w, innerHeight: h } = window;
    camera.resize(w, h);
    world.resizeCanvases(w, h);
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

  // 2 PRESENCE  T-72   3 SIM  T-39

  loop.on("layout", () => {
    // World pin positions for items that moved. Nothing reads the DOM.
    if (dirty.all) scene.layoutPins();
    else if (dirty.items.size > 0) scene.layoutPins(dirty.items);
    // And which items are near enough the viewport to be worth mounting. A read
    // phase, deliberately: the DOM phase below only consumes the answer.
    culler.update(scene, dirty, camera);
  });

  let selectionVersion = -1;
  loop.on("dom", () => {
    world.applyCamera(camera);
    cork.apply(camera);
    items.sync(scene, dirty, culler.visible);
    // Selection chrome rides on the item nodes, so it is written here with the
    // rest of the DOM rather than in the OVERLAY phase — and only when the
    // membership has actually changed.
    if (selection.version !== selectionVersion) {
      selectionVersion = selection.version;
      items.setSelected(selection.members);
    }
  });

  // 6 INK  T-57   7 ROPES  T-43

  loop.on("overlay", (frame) => {
    overlay.draw(camera, select.marquee);
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

  // An empty board is the correct first thing to see. Nothing seeds it any
  // more: there is a real way to put things on it now, and a board that opens
  // holding somebody else's placeholders is a demo rather than a tool.
  camera.fit(scene.contentBounds() ?? { minX: -400, minY: -300, maxX: 400, maxY: 300 }, 120);

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
    `drag to move · R+drag to rotate · drag the cork to marquee · Delete removes · ` +
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
