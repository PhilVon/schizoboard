/**
 * The T-293 rig: what a playing video costs on this board. Findings in D-48.
 *
 *   node scripts/make-spike-media.mjs        # once, builds the film
 *   npm run dev                              # the real app, dev build
 *   node scripts/spike-video.mjs [section]   # cost | count | demote | all
 *                                            # SPIKE_URL overrides the port
 *
 * Drives the **real application** in Edge over CDP, not `src/spike/`, for D-33's
 * reason: the spike rig has never heard of `DomItemLayer`, the culler or
 * `.layer-world`, and three of D-48's findings are about exactly those. The
 * video element is injected rather than built, because nothing in the
 * application creates one yet — its ancestors, the camera transform and the
 * culler are all real, and only the placement is a stand-in.
 *
 * ## The rule this rig exists to obey
 *
 * **Everything happens in one page load.** The first two versions varied one
 * thing per `Page.reload` and produced a monotonic climb across the matrix — the
 * GPU process's cost for a board with the video element *removed* went 3.1% to
 * 19.4% of a core as the run went on, and the frame rate appeared to halve.
 * Neither is true; a long-lived Edge instance simply gets worse across reloads.
 * So every reading here is paired against a `paused` control taken seconds
 * before it, in the same page, and nothing is ever compared across reloads. A
 * future section must follow the same rule or it will measure the reload.
 *
 * Numbers are per cent of one CPU core. `SystemInfo.getProcessInfo` rather than
 * `Performance.getMetrics` because the decode runs in the GPU process and the
 * latter is renderer-only.
 */

import { spawn } from "node:child_process";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const APP = process.env["SPIKE_URL"] ?? "http://localhost:1420/";
const PORT = 9341;
const PROFILE = join(process.cwd(), "node_modules", ".cache", "spike-video-edge");
const EDGE =
  process.env["SPIKE_EDGE"] ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
/** One measuring block. Long enough that a 15.6 ms CPU-time tick is noise. */
const BLOCK = 2600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CDP ---- */

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    socket.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }

  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((res, rej) => {
      socket.addEventListener("open", res, { once: true });
      socket.addEventListener("error", rej, { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result.value;
}

async function fetchJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`no response from ${url}`);
}

/* ------------------------------------------------------- the page half ---- */

/**
 * Evaluated once in the app. Owns the board it seeds, the media element under
 * test and its own rAF probe, and nothing else — every number it returns comes
 * either from `performance` or from `window.schizo`, which `app/main.ts` exposes
 * in dev builds only.
 */
const PAGE = `
(() => {
  const S = window.schizo;
  if (!S) throw new Error("window.schizo missing - is this a dev build?");
  const PHASES = ["input","presence","sim","layout","dom","ink","ropes","overlay","flush"];
  const world = document.querySelector(".layer-world");
  const ui = document.querySelector(".layer-ui");
  const NOTE = "Cross-checked the ledger against the shipping manifest and the dates do not " +
    "line up. Ask M about the third invoice - it is the only one with no counter-signature on it.";
  let boxes = [], media = [];

  function makeOne(o, ox, oy) {
    const w = o.w ?? 960, h = Math.round((o.w ?? 960) * 9 / 16);
    let m;
    if (o.kind === "audio") { m = document.createElement("audio"); m.src = "/spike/tone.mp3"; }
    else {
      m = document.createElement("video");
      m.src = "/spike/pan" + (o.res ?? 720) + ".mp4";
      m.muted = true; m.playsInline = true;
      m.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
    }
    m.loop = true; m.preload = "auto";
    const box = document.createElement("div");
    if (o.where === "ui") {
      box.style.cssText = "position:absolute;left:" + Math.round((innerWidth - w) / 2 + ox) +
        "px;top:" + Math.round((innerHeight - h) / 2 + oy) + "px;width:" + w + "px;height:" + h +
        "px;" + (o.extra ?? "");
      box.appendChild(m);
      return { box, m, parent: () => ui };
    }
    if (o.where === "item") {
      box.style.cssText = "position:absolute;left:6%;top:14%;width:88%;height:56%;overflow:hidden;";
      box.appendChild(m);
      return { box, m, parent: () => document.querySelector('.item-case[data-kind="vhs"] .case-body') };
    }
    box.style.cssText = "position:absolute;left:0;top:0;width:" + w + "px;height:" + h + "px;" +
      "transform:translate(" + (ox - w / 2) + "px," + (oy - h / 2) + "px)" +
      (o.rot === false ? "" : " rotate(-0.14rad)") + ";transform-origin:50% 50%;" + (o.extra ?? "");
    box.appendChild(m);
    return { box, m, parent: () => world };
  }

  function area() {
    let a = 0;
    for (const m of media) {
      if (!m.isConnected || m.tagName !== "VIDEO") continue;
      const r = m.getBoundingClientRect();
      a += Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
           Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    }
    return Math.round(a);
  }
  function quality() {
    let total = 0, dropped = 0;
    for (const m of media) {
      const q = m.getVideoPlaybackQuality ? m.getVideoPlaybackQuality() : null;
      if (q) { total += q.totalVideoFrames; dropped += q.droppedVideoFrames; }
    }
    return { total, dropped };
  }

  window.__spike = {
    env: () => ({ dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight,
                  ua: (navigator.userAgent.match(/Edg\\/[\\d.]+/) || [""])[0] }),

    async board(notes) {
      const ids = [...S.board.items.keys()];
      if (ids.length) S.ops.deleteItems(S.board, ids);
      const cols = Math.max(1, Math.ceil(Math.sqrt(notes)));
      const inputs = [];
      for (let i = 0; i < notes; i++) inputs.push({ type: "note",
        x: ((i % cols) - (cols - 1) / 2) * 430, y: (Math.floor(i / cols) - (cols - 1) / 2) * 390,
        w: 330, h: 300, text: NOTE });
      // The tape itself, so the "item" placement has an item to go inside. Its
      // bytes never arrive; the face is chosen from the mime alone.
      inputs.push({ type: "polaroid", x: 0, y: 620, w: 290, h: 160, rot: 0.14,
        assetId: "v".repeat(64),
        asset: { w: 1920, h: 1080, mime: "video/mp4", size: 8122609,
                 origName: "interview-1994.mp4", duration: 10 } });
      S.ops.createItems(S.board, inputs);
      S.camera.setView(-S.camera.width / 2, -S.camera.height / 2, 1);
      S.dirty.everything();
      await new Promise(r => setTimeout(r, 1000));
      return S.board.items.size;
    },

    clear() {
      for (const b of boxes) b.box.remove();
      for (const m of media) { m.pause(); m.removeAttribute("src"); m.load(); }
      boxes = []; media = [];
      return true;
    },
    make(o) {
      this.clear();
      const n = o.count ?? 1, w = o.w ?? 960, h = Math.round(w * 9 / 16);
      for (let i = 0; i < n; i++) {
        const ox = n === 1 ? 0 : ((i % 3) - 1) * (w + 30);
        const oy = n === 1 ? 0 : (Math.floor(i / 3) - 0.5) * (h + 30);
        const made = makeOne(o, ox, oy);
        boxes.push(made); media.push(made.m);
      }
      return n;
    },
    attach() {
      for (const b of boxes) {
        const p = b.parent();
        if (!p) throw new Error("parent is not in the document - item culled?");
        if (!b.box.isConnected) p.appendChild(b.box);
      }
      return boxes.length;
    },
    async play() { await Promise.all(media.map(m => m.play().catch(() => {}))); return true; },
    pause() { for (const m of media) m.pause(); return true; },
    zoom(z) { const c = S.camera; c.setView(-c.width / 2 / z, -c.height / 2 / z, z);
              S.dirty.everything(); return z; },
    jump(x, y) { const c = S.camera; c.setView(x - c.width / 2, y - c.height / 2, c.zoom);
                 S.dirty.everything(); return true; },
    mediaState: () => media.map(m => ({ tag: m.tagName, connected: m.isConnected,
      paused: m.paused, t: +m.currentTime.toFixed(2),
      decoded: m.getVideoPlaybackQuality ? m.getVideoPlaybackQuality().totalVideoFrames : null })),

    /** Sample rAF-to-rAF deltas and the loop's own phase timings for spec.ms.
     *  kind "orbit" drives the camera round a circle, which keeps the thing
     *  under test in view for the whole block; a straight pan does not. */
    measure(spec) {
      return new Promise(resolve => {
        const cam = S.camera, d = [], phase = new Float64Array(PHASES.length);
        let n = 0, t0 = 0, last = 0, areaSum = 0;
        const q0 = quality();
        const start = { x: cam.x, y: cam.y, zoom: cam.zoom };
        const tick = now => {
          if (t0 === 0) { t0 = now; last = now; requestAnimationFrame(tick); return; }
          d.push(now - last); last = now; n++;
          for (let i = 0; i < PHASES.length; i++) phase[i] += S.loop.timings[i];
          if (n % 8 === 1) areaSum += area() * 8;
          const t = Math.min(1, (now - t0) / spec.ms);
          if (spec.kind === "orbit") {
            const a = 2 * Math.PI * spec.laps * t, r = spec.radius / cam.zoom;
            cam.setView(start.x + (Math.cos(a) - 1) * r, start.y + Math.sin(a) * r, cam.zoom);
          } else if (spec.kind === "flight") {
            // Zoom for the first 55% and hold, so the gesture ends inside the
            // block and the will-change demote lands where it can be seen.
            if (t < 0.55) cam.zoomTo(start.zoom * Math.pow(spec.to / start.zoom, t / 0.55),
                                     cam.width / 2, cam.height / 2);
          }
          if (now - t0 >= spec.ms) {
            const s = d.slice().sort((a, b) => a - b), q1 = quality();
            resolve({ frames: n, ms: Math.round(now - t0),
              hz: +(n * 1000 / (now - t0)).toFixed(1),
              p50: +s[(s.length - 1) >> 1].toFixed(1),
              p95: +s[Math.floor((s.length - 1) * 0.95)].toFixed(1),
              max: +s[s.length - 1].toFixed(1),
              over: s.filter(x => x > 16.7).length,
              jsMs: +(phase.reduce((a, b) => a + b, 0) / n).toFixed(3),
              domMs: +(phase[4] / n).toFixed(3),
              nodes: document.getElementsByTagName("*").length,
              mounted: document.querySelectorAll(".layer-world > .item").length,
              zoom: +cam.zoom.toFixed(3), tier: S.lod ? S.lod.tier : null,
              areaK: +(areaSum / n / 1000).toFixed(1),
              decoded: q1.total - q0.total, dropped: q1.dropped - q0.dropped,
              attached: media.length ? media.every(m => m.isConnected) : null,
              playing: media.length ? media.every(m => !m.paused) : null });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
  };
  return "ok";
})()
`;

/* --------------------------------------------------------- the sections ---- */

const ORBIT = { kind: "orbit", laps: 2, radius: 260 };

async function main() {
  const section = process.argv[2] ?? "all";
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  const child = spawn(
    EDGE,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--autoplay-policy=no-user-gesture-required",
      // A window that is throttled or considered occluded reports whatever
      // frame it last managed, which during a measurement is a lie.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateNativeWinOcclusion",
      "--window-size=1600,1000",
      "--window-position=0,0",
      APP,
    ],
    { stdio: "ignore" },
  );

  const version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
  const browser = await Cdp.open(version.webSocketDebuggerUrl);
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
    target = list.find((t) => t.type === "page" && t.url.startsWith(APP.slice(0, 24)));
    if (!target) await sleep(250);
  }
  if (!target) throw new Error(`the app never appeared at ${APP} — is the dev server up?`);
  const page = await Cdp.open(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");

  const rows = [];
  const cpu = async () => {
    const info = await browser.send("SystemInfo.getProcessInfo").catch(() => ({}));
    const out = {};
    for (const p of info.processInfo ?? []) out[p.type] = (out[p.type] ?? 0) + p.cpuTime;
    return out;
  };

  /** Apply `expr`, let it settle, then measure one block. */
  const block = async (label, expr, spec = { kind: "hold" }) => {
    if (expr) await evalIn(page, expr);
    await sleep(750);
    const a = await cpu();
    const r = await evalIn(page, `window.__spike.measure(${JSON.stringify({ ...spec, ms: BLOCK })})`);
    const b = await cpu();
    // A cpuTime that has gone backwards happens about twice in a full run; it
    // is left in rather than clamped, and the summaries take medians.
    r.rend = +(((b.renderer - a.renderer) * 1000 * 100) / r.ms).toFixed(1);
    r.gpu = +(((b.GPU - a.GPU) * 1000 * 100) / r.ms).toFixed(1);
    r.label = label;
    rows.push(r);
    console.log(
      `  ${label.padEnd(34)} ${String(r.hz).padStart(6)}Hz p50 ${String(r.p50).padStart(5)}` +
        ` max ${String(r.max).padStart(6)} | rend ${String(r.rend).padStart(6)}%` +
        ` gpu ${String(r.gpu).padStart(6)}% | js ${String(r.jsMs).padStart(5)}` +
        ` dom ${String(r.domMs).padStart(5)} | ${String(r.areaK).padStart(6)}K px` +
        ` dec ${String(r.decoded).padStart(4)} drop ${String(r.dropped).padStart(3)}`,
    );
    return r;
  };

  /** A placement, measured paused-then-playing so the pair is seconds apart. */
  const pair = async (name, mk, spec) => {
    await evalIn(page, mk);
    await block(`${name} · paused`, "window.__spike.attach(), window.__spike.pause()", spec);
    await block(`${name} · PLAYING`, "window.__spike.play()", spec);
  };

  try {
    for (let i = 0; i < 120; i++) {
      if (await evalIn(page, "!!(window.schizo && window.schizo.loop)").catch(() => false)) break;
      await sleep(250);
    }
    await sleep(900);
    await evalIn(page, PAGE);
    console.log(`env ${JSON.stringify(await evalIn(page, "window.__spike.env()"))}\n`);
    await evalIn(page, "window.__spike.board(0)");

    if (section === "cost" || section === "all") {
      console.log("--- what one playing video costs (bare board, 100%, still)");
      await block("nothing at all", "window.__spike.clear()");
      await pair("screen space (.layer-ui)", 'window.__spike.make({res:720,where:"ui"})');
      await pair(".layer-world, square on", "window.__spike.make({res:720,rot:false})");
      await pair(".layer-world, rotated 8deg", "window.__spike.make({res:720})");
      await pair("rotated + sepia filter",
        'window.__spike.make({res:720,extra:"filter:sepia(0.35) saturate(0.8) contrast(0.95);"})');
      await pair("rotated + clip-path",
        'window.__spike.make({res:720,extra:"clip-path:polygon(2% 0,100% 3%,98% 100%,0 97%);"})');
      await pair("rotated + mix-blend multiply",
        'window.__spike.make({res:720,extra:"mix-blend-mode:multiply;"})');

      console.log("\n--- source resolution, and drawn size");
      for (const res of [360, 720, 1080]) await pair(`${res}p source`, `window.__spike.make({res:${res}})`);
      for (const w of [320, 640, 1280]) await pair(`${w} units wide`, `window.__spike.make({res:720,w:${w}})`);

      console.log("\n--- during a gesture: .layer-world carries will-change: transform");
      await evalIn(page, "window.__spike.clear()");
      await block("orbit, no video", null, ORBIT);
      await pair("orbit", "window.__spike.make({res:720})", ORBIT);

      console.log("\n--- zoomed out to the card tier");
      await evalIn(page, "window.__spike.clear(), window.__spike.zoom(0.35)");
      await block("35%, no video", null);
      await pair("35%", "window.__spike.make({res:720})");
      await evalIn(page, "window.__spike.zoom(1)");

      console.log("\n--- off screen (AC-660), free-standing in .layer-world");
      await evalIn(page, "window.__spike.make({res:720})");
      await block("on screen, playing", "window.__spike.attach(), window.__spike.play()");
      await block("off screen, still playing", "window.__spike.jump(12000,12000)");
      await block("off screen, paused", "window.__spike.pause()");
      await block("back on screen, playing", "window.__spike.jump(0,0), window.__spike.play()");

      console.log("\n--- off screen (AC-660), inside the item the culler unmounts");
      await evalIn(page, 'window.__spike.clear(), window.__spike.make({res:720,where:"item"})');
      await block("in the tape's subtree, playing", "window.__spike.attach(), window.__spike.play()");
      console.log(`    panned away:  ${await evalIn(page,
        "window.__spike.jump(12000,12000), new Promise(r=>setTimeout(r,900)).then(()=>window.__spike.mediaState())")}`);
      await block("after the item is culled", null);
      console.log(`    panned back:  ${await evalIn(page,
        "window.__spike.jump(0,0), new Promise(r=>setTimeout(r,900)).then(()=>window.__spike.mediaState())")}`);

      console.log("\n--- and the same for audio (T-277)");
      await evalIn(page, 'window.__spike.clear(), window.__spike.make({kind:"audio",where:"item"})');
      await block("cassette playing where it hangs", "window.__spike.attach(), window.__spike.play()");
      console.log(`    panned away:  ${await evalIn(page,
        "window.__spike.jump(12000,12000), new Promise(r=>setTimeout(r,900)).then(()=>window.__spike.mediaState())")}`);
      await evalIn(page, "window.__spike.clear(), window.__spike.jump(0,0)");
    }

    if (section === "count" || section === "all") {
      console.log("\n--- how many videos before the board's frame rate halves");
      for (const where of ["world", "ui"]) {
        console.log(`  in .layer-${where}:`);
        for (const n of [1, 2, 3, 4, 5, 6]) {
          await pair(`${n} in .layer-${where}`,
            `window.__spike.make({res:720,count:${n},w:420${where === "ui" ? ',where:"ui"' : ""}})`);
        }
        await evalIn(page, "window.__spike.clear()");
      }
    }

    if (section === "demote" || section === "all") {
      console.log("\n--- the gesture-end repaint (D-33's 600-750 ms frame), 150 notes, paired");
      await evalIn(page, "window.__spike.clear()");
      await evalIn(page, "window.__spike.board(150)");
      for (let rep = 0; rep < 3; rep++) {
        for (const state of ["none", "playing"]) {
          if (state === "none") await evalIn(page, "window.__spike.clear()");
          else {
            await evalIn(page, "window.__spike.make({res:720})");
            await evalIn(page, "window.__spike.attach(), window.__spike.play()");
          }
          await evalIn(page, "window.__spike.zoom(1)");
          await sleep(900);
          await block(`rep ${rep} ${state} · out to 35%`, null, { kind: "flight", to: 0.35 });
          await block(`rep ${rep} ${state} · back to 100%`, null, { kind: "flight", to: 1 });
        }
      }
    }

    const out = join(process.cwd(), "spike-video.json");
    await writeFile(out, JSON.stringify(rows, null, 1));
    console.log(`\nwrote ${out}`);
  } finally {
    page.close();
    browser.close();
    child.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
