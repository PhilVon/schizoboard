/**
 * PHASE-0 FIDELITY SPIKE (T-16).
 *
 * The one question this answers, before any product code exists:
 *
 *   > Does DOM + CSS survive 500 real photographs across the full 5%-400%
 *   > zoom range, sharp and at frame rate — or do we escalate `render/items/`
 *   > to PixiJS? (DESIGN section 6.1, risk 1 in section 11.1, ADR D-2.)
 *
 * It has to be real photographs. Synthetic gradients rasterise perfectly at
 * any scale and would hand back a cheerful false pass; it is the
 * high-frequency detail in a real photo that makes a stale bitmap obvious.
 *
 * Two runs, selected by environment variable, because the interesting result
 * is a *comparison*:
 *
 *   VITE_SPIKE=1           the will-change discipline from DESIGN 6.6 —
 *                          promoted at gesture start, dropped on a debounced
 *                          gesture end, which is when the layer re-rasterises.
 *   VITE_SPIKE=pinned      the control: will-change left on permanently, which
 *                          is exactly what someone reaches for to make zoom
 *                          smooth. If the discipline is doing anything, this
 *                          run ends visibly blurry and that one does not.
 *   VITE_SPIKE=culled      the discipline again, with `render/cull.ts` deciding
 *                          which of the 500 are in the tree at all (T-27).
 *
 * Everything is scripted. There is no input to drive, the camera flies itself,
 * and the run ends holding at 400% with the numbers on screen.
 *
 * ## Why there is a third run
 *
 * The first two answered the question the spike was built for — DOM holds, and
 * the discipline is load-bearing (D-12, D-2 accepted). They also turned up
 * something worse: dropping `will-change` with 500 live item nodes costs a
 * **777 ms** frame, and the cost tracks the live node count. D-12 left one
 * question open — "whether the repaint can be made incremental rather than
 * merely smaller" — and noted that "have fewer nodes" is the designed answer and
 * should be tried first. `culled` is that answer, measured on the same rig, with
 * the same camera flight, so the comparison is a diff of one variable.
 */

import "@/spike/spike.css";

import { Cork } from "@/render/cork";
import { Culler } from "@/render/cull";
import { FrameLoop } from "@/render/loop";
import { mulberry32 } from "@/lib/seed";
import { World } from "@/render/world";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";

const PHOTO_COUNT = 500;
/** Board units. A polaroid is roughly a hand's width. */
const PHOTO_W = 300;
const COLUMNS = 25;
const CELL = 380;

/** 60fps budget. A frame longer than this is a dropped frame. */
const BUDGET_MS = 16.7;

interface Stage {
  name: string;
  /** Milliseconds. */
  ms: number;
  /** Target zoom; absent means hold. */
  zoom?: number;
  /** Board-space pan over the stage, in board units. */
  pan?: [number, number];
  /** Does this stage represent a live gesture? */
  gesture: boolean;
}

const SCRIPT: Stage[] = [
  { name: "settle 100%", ms: 800, gesture: false },
  { name: "pan at 100%", ms: 1800, pan: [2400, 900], gesture: true },
  { name: "zoom out to 5%", ms: 2600, zoom: 0.05, gesture: true },
  { name: "hold 5% (all 500 visible)", ms: 1400, gesture: false },
  { name: "zoom in to 35% (LOD edge)", ms: 1800, zoom: 0.35, gesture: true },
  { name: "hold 35%", ms: 1200, gesture: false },
  { name: "zoom in to 400%", ms: 2600, zoom: 4, gesture: true },
  { name: "hold 400% (after re-raster)", ms: 2500, gesture: false },
  // Ends here so the final resting frame has legible captions in it. Text is
  // the part of the DOM bet that WebGL would cost us most (DESIGN 6.1), so
  // "does it re-shape at the new scale or just stretch" is worth its own look.
  { name: "zoom out to 150% (caption legibility)", ms: 1600, zoom: 1.5, gesture: true },
  { name: "hold 150%", ms: 4000, gesture: false },
];

interface Sample {
  stage: string;
  dt: number;
  /** How many photographs the camera can geometrically see. */
  visible: number;
  /** How many are actually in the DOM — the number the repaint cost tracks. */
  mounted: number;
}

type Kind = "discipline" | "pinned" | "culled";

const LABELS: Record<Kind, string> = {
  discipline: "will-change discipline",
  pinned: "will-change PINNED — control",
  culled: "will-change discipline + culling (T-27)",
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[i]!;
}

interface Placed {
  /** Top-left, board units — the spike positions with left/top, not by centre. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Radians, filled in when the element is built. */
  rot: number;
}

function place(count: number): Placed[] {
  const rng = mulberry32(0x5c1201);
  const out: Placed[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % COLUMNS;
    const row = Math.floor(i / COLUMNS);
    // Jittered grid: even coverage, but nothing lines up. Mess is a feature.
    const w = PHOTO_W * (0.8 + rng() * 0.45);
    const h = w * (0.72 + rng() * 0.62);
    out.push({
      x: col * CELL + (rng() - 0.5) * CELL * 0.7 - (COLUMNS * CELL) / 2,
      y: row * CELL + (rng() - 0.5) * CELL * 0.7 - (Math.ceil(count / COLUMNS) * CELL) / 2,
      w,
      h,
      rot: 0,
    });
  }
  return out;
}

async function loadManifest(): Promise<string[]> {
  const response = await fetch("/spike/manifest.json");
  if (!response.ok) {
    throw new Error(
      "public/spike/manifest.json missing — run `node scripts/fetch-spike-photos.mjs 500` first.",
    );
  }
  return (await response.json()) as string[];
}

export async function run(): Promise<void> {
  const mode = String(import.meta.env["VITE_SPIKE"]);
  const pinned = mode === "pinned";
  const culling = mode === "culled";
  const kind: Kind = pinned ? "pinned" : culling ? "culled" : "discipline";
  const label = LABELS[kind];

  const root = document.querySelector<HTMLDivElement>("#board-root");
  if (!root) throw new Error("#board-root missing");

  const camera = new Camera();
  const world = new World(root);
  const cork = new Cork(world.layers.cork, 0x5c1201);
  const loop = new FrameLoop();

  const report = document.createElement("div");
  report.className = "spike-report";
  world.layers.ui.append(report);
  report.textContent = "loading photos...";

  const resize = (): void => {
    camera.resize(window.innerWidth, window.innerHeight);
    world.resizeCanvases(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", resize);
  resize();

  const files = await loadManifest();
  const layout = place(PHOTO_COUNT);
  const rng = mulberry32(99);

  const buildStart = performance.now();
  const fragment = document.createDocumentFragment();
  const pending: Promise<void>[] = [];
  /** Kept by index so the culled run can put them in and take them out. */
  const els: HTMLDivElement[] = [];

  for (let i = 0; i < PHOTO_COUNT; i++) {
    const spot = layout[i]!;
    const el = document.createElement("div");
    el.className = "spike-photo";
    el.style.left = `${spot.x}px`;
    el.style.top = `${spot.y}px`;
    el.style.width = `${spot.w}px`;
    el.style.height = `${spot.h}px`;
    // Nothing arrives straight (DESIGN section 3.1). Kept in radians alongside,
    // because the scene mirror the culler reads speaks radians, and the two must
    // describe the same photograph or it will cull the wrong ones.
    const radians = ((rng() - 0.5) * 8 * Math.PI) / 180;
    spot.rot = radians;
    el.style.transform = `rotate(${radians}rad)`;

    const img = document.createElement("img");
    img.decoding = "async";
    img.src = `/spike/${files[i % files.length]}`;
    pending.push(
      new Promise<void>((resolve) => {
        img.addEventListener("load", () => resolve(), { once: true });
        img.addEventListener("error", () => resolve(), { once: true });
      }),
    );

    const caption = document.createElement("b");
    caption.textContent = `no. ${String(i + 1).padStart(3, "0")}`;

    el.append(img, caption);
    els.push(el);
    // The culled run starts with an empty tree; the first frame mounts whatever
    // the camera can see. An `<img>` loads whether or not it is in the document,
    // so the wait below is the same wait in both runs.
    if (!culling) fragment.append(el);
  }
  if (!culling) world.layers.world.append(fragment);

  await Promise.all(pending);
  const buildMs = performance.now() - buildStart;

  /**
   * The scene mirror, for the culler's benefit only.
   *
   * The spike deliberately does not go through `render/items/` — it is measuring
   * the raster path, not the item views — so it builds this by hand from the same
   * layout its own elements were built from. Board units, centre-origin, radians.
   */
  const scene = new Scene();
  const dirty = new DirtySets();
  const culler = new Culler();
  if (culling) {
    for (let i = 0; i < PHOTO_COUNT; i++) {
      const spot = layout[i]!;
      scene.putItem(
        {
          id: `p${i}`,
          type: "polaroid",
          z: "a0",
          seed: i,
          assetId: null,
          createdBy: 1,
          createdAt: 0,
          text: "",
        },
        {
          x: spot.x + spot.w / 2,
          y: spot.y + spot.h / 2,
          rot: spot.rot,
          w: spot.w,
          h: spot.h,
        },
      );
    }
    dirty.everything();
  }

  /** Which indices are in the tree. Empty until the first culled frame. */
  const inTree = new Set<number>();
  let cameraVersion = -1;
  const recull = (): void => {
    if (camera.version !== cameraVersion) {
      cameraVersion = camera.version;
      dirty.camera = true;
    }
    culler.update(scene, dirty, camera);
    for (const i of inTree) {
      if (!culler.visible.has(`p${i}`)) {
        els[i]!.remove();
        inTree.delete(i);
      }
    }
    for (const id of culler.visible) {
      const i = Number(id.slice(1));
      if (inTree.has(i)) continue;
      world.layers.world.append(els[i]!);
      inTree.add(i);
    }
  };

  // Frame the whole field, then start at 100% over its middle.
  camera.centreOn(0, 0);
  camera.zoomTo(1, camera.width / 2, camera.height / 2);

  if (pinned) {
    // The control. Left on for the entire run, at the scale it was promoted.
    world.layers.world.style.willChange = "transform";
  }

  const samples: Sample[] = [];
  let stageIndex = 0;
  let stageStart = 0;
  let stageFromZoom = camera.zoom;
  let stageFromX = camera.x;
  let stageFromY = camera.y;
  let finished = false;
  // The loop clamps the dt it hands to phases at 250 ms so a backgrounded tab
  // cannot detonate the solver. That clamp is right for the solver and wrong
  // for a measurement — a stall reported as "250" could be 260 or 2000. The
  // spike times its own frames.
  let previousFrame = 0;

  const visibleCount = (): number => {
    const b = camera.visibleBounds();
    let n = 0;
    for (const spot of layout) {
      if (
        spot.x + spot.w >= b.minX &&
        spot.x <= b.maxX &&
        spot.y + spot.h >= b.minY &&
        spot.y <= b.maxY
      ) {
        n++;
      }
    }
    return n;
  };

  loop.on("input", (frame) => {
    if (finished) return;
    if (stageStart === 0) stageStart = frame.now;

    const stage = SCRIPT[stageIndex]!;
    const t = Math.min(1, (frame.now - stageStart) / stage.ms);
    // Ease so the sweep looks like a gesture rather than a jump cut.
    const e = t * t * (3 - 2 * t);

    if (stage.zoom !== undefined) {
      // Geometric interpolation: zoom is multiplicative, and a linear ramp
      // from 400% to 5% spends almost all its time below 20%.
      const target = stageFromZoom * Math.pow(stage.zoom / stageFromZoom, e);
      camera.zoomTo(target, camera.width / 2, camera.height / 2);
    }
    if (stage.pan) {
      camera.x = stageFromX + stage.pan[0] * e;
      camera.y = stageFromY + stage.pan[1] * e;
      camera.version++;
    }
    if (stage.gesture && !pinned) world.gestureTick(camera.zoom);

    const raw = previousFrame === 0 ? frame.dt : frame.now - previousFrame;
    previousFrame = frame.now;
    samples.push({
      stage: stage.name,
      dt: raw,
      visible: visibleCount(),
      // Filled in at flush, below: the cull for *this* frame has not run yet.
      mounted: culling ? 0 : PHOTO_COUNT,
    });

    if (t >= 1) {
      stageIndex++;
      if (stageIndex >= SCRIPT.length) {
        finished = true;
        // Give the debounced gesture end its 180ms and the re-raster a beat.
        setTimeout(() => {
          report.innerHTML = summarise(samples, buildMs, kind, camera);
        }, 600);
        return;
      }
      stageStart = frame.now;
      stageFromZoom = camera.zoom;
      stageFromX = camera.x;
      stageFromY = camera.y;
    }
  });

  // LAYOUT (4) — a read phase, same as in `app/main.ts`.
  loop.on("layout", () => {
    if (culling) recull();
  });

  loop.on("dom", () => {
    world.applyCamera(camera);
    cork.apply(camera);
  });

  loop.on("flush", () => {
    if (!culling) return;
    const last = samples[samples.length - 1];
    if (last) last.mounted = inTree.size;
    dirty.clear();
  });

  loop.on("overlay", (frame) => {
    if (finished) return;
    const stage = SCRIPT[stageIndex];
    report.textContent =
      `SPIKE [${label}]\n` +
      `${PHOTO_COUNT} photos · built in ${buildMs.toFixed(0)} ms\n\n` +
      `stage ${stageIndex + 1}/${SCRIPT.length}  ${stage?.name ?? ""}\n` +
      `zoom ${(camera.zoom * 100).toFixed(0)}%   frame ${frame.dt.toFixed(1)} ms\n` +
      (culling ? `in the DOM ${inTree.size} / ${PHOTO_COUNT}   ${culler.path}\n` : "");
  });

  loop.start();
}

function summarise(samples: Sample[], buildMs: number, kind: Kind, camera: Camera): string {
  const byStage = new Map<string, Sample[]>();
  for (const sample of samples) {
    const list = byStage.get(sample.stage);
    if (list) list.push(sample);
    else byStage.set(sample.stage, [sample]);
  }

  const lines: string[] = [];
  lines.push(`<b>FIDELITY SPIKE — ${LABELS[kind]}</b>`);
  lines.push(`500 photos · DOM built and decoded in ${buildMs.toFixed(0)} ms`);
  lines.push(`ending zoom ${(camera.zoom * 100).toFixed(0)}%   budget ${BUDGET_MS} ms/frame`);
  lines.push("");
  // `vis` is what the camera can see; `dom` is what is actually in the tree. In
  // the first two runs they differ by definition — every photograph is mounted
  // always — and the gap between them in the third run is the whole point.
  lines.push("stage                          vis  dom    p50    p95    max   over");
  lines.push("-------------------------------------------------------------------");

  let worstP95 = 0;
  for (const [stage, list] of byStage) {
    const dts = list.map((s) => s.dt).sort((a, b) => a - b);
    const p50 = percentile(dts, 0.5);
    const p95 = percentile(dts, 0.95);
    const max = dts[dts.length - 1] ?? 0;
    const over = dts.filter((d) => d > BUDGET_MS).length;
    const visible = Math.max(...list.map((s) => s.visible));
    const mounted = Math.max(...list.map((s) => s.mounted));
    worstP95 = Math.max(worstP95, p95);
    const cls = p95 > BUDGET_MS ? "spike-bad" : "spike-good";
    lines.push(
      `${stage.padEnd(30)}${String(visible).padStart(4)}${String(mounted).padStart(5)}` +
        `<span class="${cls}">${p50.toFixed(1).padStart(7)}${p95.toFixed(1).padStart(7)}` +
        `${max.toFixed(1).padStart(7)}${String(over).padStart(7)}</span>`,
    );
  }

  lines.push("");
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  if (memory) {
    lines.push(`js heap  ${(memory.usedJSHeapSize / 1024 / 1024).toFixed(0)} MB`);
  }
  lines.push(
    worstP95 <= BUDGET_MS
      ? `<span class="spike-good">every stage held the frame budget at p95.</span>`
      : `<span class="spike-bad">worst stage p95 ${worstP95.toFixed(1)} ms — over budget.</span>`,
  );
  lines.push("");
  lines.push("Now look at the photographs, not the numbers:");
  if (kind === "pinned") {
    lines.push("this run pinned will-change, so the layer should still be showing");
    lines.push("its 100% raster stretched to 400%.");
  } else {
    lines.push("this run dropped will-change at gesture end, so the layer should have");
    lines.push("re-rastered at 400% and be sharp.");
    if (kind === "culled") {
      lines.push("");
      lines.push("And compare the max column against the unculled run: that");
      lines.push("difference is the number T-27 exists to produce.");
    }
  }

  return lines.join("\n");
}
