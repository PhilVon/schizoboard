/**
 * Entry point. Builds the layer stack, wires the nine phases, starts the loop.
 *
 * Phase 0 (T-1): an infinite cork board that pans and zooms, one rAF driving
 * everything, and a HUD reporting what each phase costs. There is no document
 * and no scene mirror yet — those arrive with items in phase 1.
 */

import { Cork } from "@/render/cork";
import { FrameLoop } from "@/render/loop";
import { World } from "@/render/world";
import { Camera } from "@/state/camera";
import { Navigation } from "@/state/navigation";
import { host } from "@/platform/env";
import { Hud, type HudStats } from "@/ui/hud";

/**
 * Per-board texture seed. Lives in the document's `meta` map from phase 1 —
 * see DATA-MODEL. Fixed until then so the cork is stable across reloads.
 */
const BOARD_SEED = 0x5c1201;

function boot(): void {
  const root = document.querySelector<HTMLDivElement>("#board-root");
  if (!root) throw new Error("#board-root missing from index.html");

  const camera = new Camera();
  const world = new World(root);
  const cork = new Cork(world.layers.cork, BOARD_SEED);
  const loop = new FrameLoop();
  const navigation = new Navigation(camera, root);

  const stats = (): HudStats => ({
    zoom: camera.zoom,
    cameraX: camera.x + camera.width / (2 * camera.zoom),
    cameraY: camera.y + camera.height / (2 * camera.zoom),
    awakeParticles: 0, // sim/ropes.ts, T-40
    docBytes: 0, // crdt/doc.ts, T-18
  });
  const hud = new Hud(world.layers.ui, loop, stats);

  // The gesture-end re-raster, one hop: world debounces, cork regenerates.
  world.onRasterize((scale) => cork.rasterize(scale));

  const resize = (): void => {
    const { innerWidth: w, innerHeight: h } = window;
    camera.resize(w, h);
    world.resizeCanvases(w, h);
  };
  window.addEventListener("resize", resize);
  resize();
  camera.centreOn(0, 0);

  // ---- the nine phases (docs/ARCHITECTURE.md section 3) -------------------

  loop.on("input", () => {
    navigation.flush();
    if (navigation.gestured) world.gestureTick(camera.zoom);
  });

  // 2 PRESENCE  T-72   3 SIM  T-39   4 LAYOUT  T-24

  loop.on("dom", () => {
    world.applyCamera(camera);
    cork.apply(camera);
  });

  // 6 INK  T-57   7 ROPES  T-43

  loop.on("overlay", (frame) => hud.update(frame.now));

  // 9 FLUSH  T-71

  loop.start();

  devScaffolding(world, hud);
}

/**
 * Temporary. Removed when real item views land (T-24).
 *
 * Crisp-edged objects at known board coordinates, so that panning and zooming
 * have something to be measured against and so the DOM-raster-blur risk
 * (DESIGN section 11.1, risk 1) is visible the moment it appears.
 */
function devScaffolding(world: World, hud: Hud): void {
  const marks: [number, number, number, number, string][] = [
    [-40, -40, 80, 80, "0,0"],
    [400, -260, 220, 160, "400,-260"],
    [-560, 120, 300, 200, "-560,120"],
    [180, 420, 160, 240, "180,420"],
    [-900, -700, 120, 120, "-900,-700"],
    [1100, 600, 260, 180, "1100,600"],
  ];
  for (const [x, y, w, h, label] of marks) {
    const el = document.createElement("div");
    el.className = "dev-marker";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.textContent = label;
    world.layers.world.append(el);
  }

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent =
    `${host()} · space+drag or middle-drag to pan · wheel to zoom · \` for the HUD`;
  world.layers.ui.append(hint);

  hud.toggle(); // on by default while phase 0 is the whole application
}

boot();
