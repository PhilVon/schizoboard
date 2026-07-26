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
import { createItems, deleteItems, setItemPoses } from "@/crdt/ops";
import { Origin } from "@/crdt/origins";
import { initPlatform } from "@/platform";
import { Cork } from "@/render/cork";
import { DomItemLayer } from "@/render/items/dom";
import { FrameLoop } from "@/render/loop";
import { Overlay } from "@/render/overlay";
import { World } from "@/render/world";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
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
  initialiseBoard(board);

  const scene = new Scene();
  const dirty = new DirtySets();
  const binding = new Binding(board, scene, dirty);
  binding.start();

  // --- presentation --------------------------------------------------------
  const camera = new Camera();
  const world = new World(root);
  const cork = new Cork(world.layers.cork, boardSeed(board));
  const items = new DomItemLayer(world.layers.world, (sha) => native.assetUrl(sha));
  const overlay = new Overlay(world.layers.overlay);
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

  const resize = (): void => {
    const { innerWidth: w, innerHeight: h } = window;
    camera.resize(w, h);
    world.resizeCanvases(w, h);
  };
  window.addEventListener("resize", resize);
  resize();

  // --- the nine phases (docs/ARCHITECTURE.md section 3) ---------------------

  loop.on("input", (frame) => {
    navigation.flush();
    if (navigation.gestured) world.gestureTick(camera.zoom);
    tools.flush(frame.dt);
  });

  // 2 PRESENCE  T-72   3 SIM  T-39

  loop.on("layout", () => {
    // World pin positions for items that moved. Nothing reads the DOM.
    if (dirty.all) scene.layoutPins();
    else if (dirty.items.size > 0) scene.layoutPins(dirty.items);
  });

  let selectionVersion = -1;
  loop.on("dom", () => {
    world.applyCamera(camera);
    cork.apply(camera);
    // Culling is T-27; until then every item is a candidate, which the spike
    // (D-12) says is fine up to a few hundred and expensive past that.
    items.sync(scene, dirty, null);
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

  seedDemoBoard(board);
  camera.fit(scene.contentBounds() ?? { minX: -400, minY: -300, maxX: 400, maxY: 300 }, 120);

  loop.start();

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent =
    `platform: ${native.kind} · drag to move · R+drag to rotate · drag the cork to marquee · ` +
    `Delete removes · space+drag pans · Ctrl+0 fit · F frame · \` for the HUD`;
  world.layers.ui.append(hint);
  hud.toggle();
}

/**
 * Temporary. Removed when paste lands (T-23) and there is a real way to get
 * things onto the board.
 *
 * The polaroids deliberately have no asset. That is not a placeholder for a
 * missing feature — it is the state DESIGN section 7.5 says must be fully
 * usable: an item is pinnable, stringable and annotatable before its
 * photograph has arrived, because its dimensions are in the document.
 */
function seedDemoBoard(board: ReturnType<typeof openBoardDoc>): void {
  if (board.items.size > 0) return;
  createItems(board, [
    { type: "polaroid", x: -420, y: -180, w: 300, h: 340 },
    { type: "polaroid", x: -60, y: -230, w: 260, h: 300 },
    { type: "polaroid", x: 300, y: -160, w: 320, h: 280 },
    {
      type: "note",
      x: -380,
      y: 220,
      w: 260,
      h: 200,
      text: "the string is the product\n\neverything else is in\nservice of getting string\nbetween things",
    },
    {
      type: "card",
      x: 20,
      y: 200,
      w: 300,
      h: 180,
      text: "mess is a feature.\nnothing snaps to a grid.",
    },
    { type: "scrap", x: 360, y: 210, w: 200, h: 200 },
    {
      type: "note",
      x: 640,
      y: 40,
      w: 220,
      h: 160,
      text: "nothing arrives\nstraight",
    },
  ]);
}

/**
 * The phase-0 fidelity spike replaces the whole application when asked for.
 * `import.meta.env` is statically replaced, so with the variable unset this
 * branch and the module behind it are eliminated from the bundle entirely.
 *
 *   $env:VITE_SPIKE=1;      npm run tauri dev    # will-change discipline
 *   $env:VITE_SPIKE=pinned; npm run tauri dev    # the blurry control
 */
if (import.meta.env["VITE_SPIKE"]) {
  void import("@/spike/fidelity").then((spike) => spike.run());
} else {
  void boot();
}
