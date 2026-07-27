// Replay the append-only document log and say what actually changed, when.
//
// Why this exists: pixels cannot tell a pose write from a swing. A swing is a
// local visual offset that is never stored (DESIGN 5.5 / AC-60), and an item
// can also be drawn somewhere new because the camera re-fitted on boot. So
// "that item has moved" read off two screenshots is a hypothesis, and this is
// what settles it — T-149 was filed off pixels as "the app moved a note during
// a paste" and turned out to be the human dragging it in another window.
//
// Format is src-tauri/src/docstore.rs: snapshot.bin is a raw Yjs update, and
// log.bin is "SZBDLOG1" followed by [u32 len][u64 checksum][update] frames.
//
//   node scripts/replay-doc.mjs                 every frame, and what it touched
//   node scripts/replay-doc.mjs 2000 2029       just that range of frames
//   node scripts/replay-doc.mjs --item <id>     one item's pose history
//
// Reading the shape matters as much as the numbers. A run of consecutive
// single-item [x:update,y:update] frames is a DRAG — the throttle writes about
// every 300 ms — and a wobbling path that goes out and comes back is a hand. A
// physics leak would be one write, or every item at once.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";

const args = process.argv.slice(2);
const itemAt = args.indexOf("--item");
const item = itemAt >= 0 ? args[itemAt + 1] : null;
const range = args.filter((a, i) => i !== itemAt && i !== itemAt + 1 && /^\d+$/.test(a)).map(Number);
const from = range[0] ?? 0;
const to = range[1] ?? Infinity;
const root =
  args.find((a) => a.includes("\\") || a.includes("/")) ??
  join(process.env.APPDATA ?? "", "com.philw.schizoboard", "doc");

const doc = new Y.Doc();
const snap = join(root, "snapshot.bin");
if (existsSync(snap)) Y.applyUpdate(doc, new Uint8Array(readFileSync(snap)));

const frames = [];
const logPath = join(root, "log.bin");
if (existsSync(logPath)) {
  const bytes = new Uint8Array(readFileSync(logPath));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at, true);
    const s = at + 12;
    const e = s + len;
    if (e > bytes.length) break; // a frame the app is still writing
    frames.push(bytes.subarray(s, e));
    at = e;
  }
}

const round = (n) => (typeof n === "number" ? Math.round(n * 1000) / 1000 : n);
const items = doc.getMap("items");
const poseOf = () => {
  const map = items.get(item);
  return map ? { x: round(map.get("x")), y: round(map.get("y")), rot: round(map.get("rot")) } : null;
};

const seen = [];
for (const name of ["items", "pins", "strings", "boardInk"]) {
  doc.getMap(name).observeDeep((events) => {
    for (const e of events) {
      const keys = [...e.changes.keys.entries()].map(([k, v]) => `${k}:${v.action}`);
      const id = typeof e.path[0] === "string" ? e.path[0] : "";
      seen.push(`${name}${id ? "/" + id.slice(0, 6) : ""}${keys.length ? ` [${keys.join(",")}]` : ""}`);
    }
  });
}

console.log(`${frames.length} frames${item ? `, tracking ${item}` : ""}`);
frames.forEach((f, i) => {
  seen.length = 0;
  const before = item ? poseOf() : null;
  Y.applyUpdate(doc, f);
  if (i < from || i > to) return;
  if (item) {
    const now = poseOf();
    const changed = !before !== !now || (before && now && (before.x !== now.x || before.y !== now.y || before.rot !== now.rot));
    if (!changed) return;
    const d = before && now ? ` (dx ${round(now.x - before.x)} dy ${round(now.y - before.y)} drot ${round(now.rot - before.rot)})` : "";
    console.log(`${String(i).padStart(4)} ${before ? JSON.stringify(before) : "-"} -> ${now ? JSON.stringify(now) : "gone"}${d}`);
    return;
  }
  const uniq = [...new Set(seen)];
  console.log(String(i).padStart(4), uniq.slice(0, 6).join(" | ") + (uniq.length > 6 ? ` +${uniq.length - 6}` : ""));
});
