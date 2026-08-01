/**
 * What a `<video>` actually asks `asset://` for, and what the shell holds while
 * it answers (T-263, AC-702).
 *
 * `protocol.rs`'s own tests call `respond()` directly. They cannot answer the
 * question this script exists for, which is whether **WebView2** accepts a
 * *short* 206 — a `Content-Range` narrower than the `Range` that was asked for
 * — across its own `http://asset.localhost` mapping. That is a decision made
 * inside Chromium's media pipeline, on the far side of a boundary a Rust test
 * owns neither half of.
 *
 * It pastes a film in the way a person does rather than calling
 * `asset_ingest_path`: an asset no item refers to is exactly what the boot
 * sweep collects (`app/assetgc.ts`, 30 s after boot), and it collected the
 * first attempt's film **mid-playback** — a 404 on the fourteenth span, which
 * reads precisely like the range handler failing. The bytes come from Vite's
 * own `/spike/`, so nothing large crosses CDP.
 *
 * Needs a running instance with a devtools port. Give it its own data dir, or
 * it will paste a 48 MB film onto the human's real board:
 *
 *   $env:SCHIZOBOARD_DATA_DIR = "...\scratch"
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9444"
 *   $env:WEBVIEW2_USER_DATA_FOLDER = "...\scratch\webview"
 *   npx tauri dev --config '{"build":{"beforeDevCommand":""}}'
 *
 *   node scripts/spike-asset-range.mjs                 # long1080.mp4, 30 s
 *   PORT=9444 SECONDS=10 node scripts/spike-asset-range.mjs
 *
 * The fixture matters. `npm run spike:media` builds `long1080.mp4` at 48 MB —
 * a dozen times the response cap, so the ladder has a dozen rungs — with
 * `moov` at the end, so the element *must* read the short 206's Content-Range
 * to find the tail. A film smaller than the cap proves nothing at all.
 *
 * To watch the cap do its work, run it twice with `MAX_BODY` set to `u64::MAX`
 * in between: the ladder collapses to one 48 MB response, and the shell's
 * private bytes go from a 24 MiB blip to a 471 MiB ramp.
 */

import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const PORT = Number(process.env.PORT ?? 9444);
const VITE_PATH = process.env.VITE_PATH ?? "/spike/long1080.mp4";
const SECONDS = Number(process.env.SECONDS ?? 30);
/** Long enough that the boot sweep has already run and the ingest's own
 *  allocation is a separate feature of any memory trace taken alongside. */
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 18_000);
const OUT = process.env.OUT ?? null;

async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page =
    list.find((t) => t.type === "page" && /localhost:1420/.test(t.url)) ??
    list.find((t) => t.type === "page");
  if (!page) throw new Error(`no page on ${port}: ${JSON.stringify(list.map((t) => t.url))}`);
  // A CDP frame larger than `ws`'s 100 MiB default does not throw where you can
  // catch it: the receiver errors, the socket closes 1006, every pending call is
  // left unsettled, and node exits with "unsettled top-level await" pointing at
  // whichever line was waiting. Which looks like the *page* hanging.
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));

  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id === undefined) return listeners.forEach((fn) => fn(msg));
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (!p) return;
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
    else p.res(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression, timeout = 120_000) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout });
    if (r.exceptionDetails) throw new Error("page threw: " + (r.exceptionDetails.exception?.description ?? ""));
    return r.result.value;
  };
  return { page, send, evaluate, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

const c = await connect(PORT);
console.log("target:", c.page.url);

// `Range` is on the request and `Content-Range` on the response, and the whole
// finding is the two disagreeing by design.
const seen = new Map();
c.on(({ method, params: p }) => {
  if (method === "Network.requestWillBeSent") {
    seen.set(p.requestId, { url: p.request.url, range: p.request.headers?.Range ?? p.request.headers?.range ?? null });
  } else if (method === "Network.responseReceived") {
    const r = seen.get(p.requestId);
    if (!r) return;
    const h = Object.fromEntries(Object.entries(p.response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    Object.assign(r, {
      status: p.response.status,
      contentRange: h["content-range"] ?? null,
      contentLength: h["content-length"] ?? null,
      cacheControl: h["cache-control"] ?? null,
    });
  }
});

const pasted = await c.evaluate(
  `
  (async () => {
    const s = window.schizo;
    const before = new Set(s.scene.itemIds());
    const blob = await (await fetch(${JSON.stringify(VITE_PATH)})).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], ${JSON.stringify(VITE_PATH.split("/").pop())}, { type: "video/mp4" }));
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const fresh = [...s.scene.itemIds()].filter((id) => !before.has(id));
      const item = fresh.length ? s.board.items.get(fresh[0]) : null;
      const json = item ? item.toJSON() : null;
      if (json?.assetId) {
        const rec = s.board.assets.get(json.assetId);
        return { id: fresh[0], sha256: json.assetId, record: rec ? rec.toJSON() : null };
      }
    }
    return { failed: "no item with an assetId appeared" };
  })()
`,
);
if (!pasted.sha256) throw new Error(JSON.stringify(pasted));
console.log("pasted:", pasted.id, JSON.stringify(pasted.record));

const url = await c.evaluate(
  `window.__TAURI_INTERNALS__.convertFileSrc(${JSON.stringify(pasted.sha256)}, "asset") + "?v=display"`,
);
console.log("url:", url);

// Only now, so the paste's own traffic is not recorded. It is not what is being
// measured, and the 48 MB body it puts through the IPC scheme arrives as one
// CDP event bigger than any sane frame limit.
await c.send("Network.enable", { maxTotalBufferSize: 1e6, maxResourceBufferSize: 1e6, maxPostDataSize: 0 });

if (PAUSE_MS) {
  console.log(`idling ${PAUSE_MS / 1000}s before playing ...`);
  await new Promise((r) => setTimeout(r, PAUSE_MS));
}

console.log(`playing for ${SECONDS}s ...`);
const run = await c.evaluate(
  `
  (async () => {
    document.getElementById("t263")?.remove();
    const v = document.createElement("video");
    v.id = "t263";
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.style.cssText = "position:fixed;left:8px;bottom:8px;width:360px;z-index:2147483647;background:#000;outline:2px solid #0f0";
    document.body.appendChild(v);

    const t0 = performance.now();
    v.src = ${JSON.stringify(url)};
    const meta = await new Promise((res) => {
      v.addEventListener("loadedmetadata", () => res({ ok: true, at: +(performance.now() - t0).toFixed(1) }), { once: true });
      v.addEventListener("error", () => res({ ok: false, code: v.error?.code, msg: v.error?.message }), { once: true });
      setTimeout(() => res({ ok: false, timeout: true }), 30000);
    });

    const shot = () => ({
      ct: +v.currentTime.toFixed(3),
      readyState: v.readyState,
      frames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
      dropped: v.getVideoPlaybackQuality?.().droppedVideoFrames ?? null,
      error: v.error ? { code: v.error.code, msg: v.error.message } : null,
    });

    let playErr = null;
    try { await v.play(); } catch (e) { playErr = String(e); }
    const deadline = performance.now() + ${SECONDS} * 1000;
    while (performance.now() < deadline && !v.ended && !v.error) {
      await new Promise((r) => setTimeout(r, 250));
    }

    // Read before the seek below moves it off the end again.
    const playedThrough = { ended: v.ended, ...shot() };

    // A seek near the end is a span from the middle of the file, which the
    // sequential ladder never asks for on its own.
    const target = Math.max(0, (v.duration || 0) - 3);
    const seek = await new Promise((res) => {
      const t1 = performance.now();
      v.addEventListener("seeked", () => res({ ok: true, at: +(performance.now() - t1).toFixed(1) }), { once: true });
      setTimeout(() => res({ ok: false, timeout: true }), 15000);
      v.currentTime = target;
    });
    await new Promise((r) => setTimeout(r, 1200));

    return { duration: v.duration, size: v.videoWidth + "x" + v.videoHeight, meta, playErr, playedThrough, seekTo: +target.toFixed(2), seek, final: shot() };
  })()
`,
  (SECONDS + 90) * 1000,
);

const requests = [...seen.values()].filter((r) => r.url.includes(pasted.sha256));

console.log("");
console.log("duration", run.duration, run.size, "| metadata", JSON.stringify(run.meta), "| playErr", run.playErr);
console.log("played  ", JSON.stringify(run.playedThrough));
console.log("seek to ", run.seekTo, "->", JSON.stringify(run.seek));
console.log(`\n${requests.length} requests for this asset:`);
for (const r of requests) {
  console.log(
    `  ${String(r.status ?? "?").padEnd(4)} ${(r.range ?? "(no Range)").padEnd(22)} -> ${(r.contentRange ?? "-").padEnd(28)} ${String(r.contentLength ?? "-").padStart(9)} B`,
  );
}
const bodies = requests.map((r) => Number(r.contentLength)).filter(Number.isFinite);
if (bodies.length) {
  console.log(`\nlargest body ${(Math.max(...bodies) / 1048576).toFixed(2)} MiB over ${bodies.length} answers`);
}

if (OUT) {
  await writeFile(OUT, JSON.stringify({ url, pasted, run, requests }, null, 2));
  console.log("wrote", OUT);
}
c.close();
