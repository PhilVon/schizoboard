// Read the persisted board off disk and print what the DOCUMENT says.
//
// Pixels cannot tell a pose write from a swing: the swing is a local visual
// offset that is never stored (DESIGN 5.5 / AC-60), so an item drawn somewhere
// new may or may not have moved in the document. This says which.
//
// Format is src-tauri/src/docstore.rs: snapshot.bin is a raw Yjs update, and
// log.bin is "SZBDLOG1" followed by [u32 len][u64 checksum][update] frames.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";

const root =
  process.argv[2] ??
  join(process.env.APPDATA ?? "", "com.philw.schizoboard", "doc");

const doc = new Y.Doc();

const snap = join(root, "snapshot.bin");
if (existsSync(snap)) {
  Y.applyUpdate(doc, new Uint8Array(readFileSync(snap)));
}

const logPath = join(root, "log.bin");
let frames = 0;
if (existsSync(logPath)) {
  const bytes = new Uint8Array(readFileSync(logPath));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8; // "SZBDLOG1"
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at, true);
    const start = at + 12;
    const end = start + len;
    if (end > bytes.length) break;
    Y.applyUpdate(doc, bytes.subarray(start, end));
    frames++;
    at = end;
  }
}

const items = doc.getMap("items");
const pins = doc.getMap("pins");
const strings = doc.getMap("strings");

const round = (n) => (typeof n === "number" ? Math.round(n * 1000) / 1000 : n);

const rows = [];
for (const [id, map] of items) {
  rows.push({
    id,
    type: map.get("type"),
    x: round(map.get("x")),
    y: round(map.get("y")),
    rot: round(map.get("rot")),
    w: round(map.get("w")),
    h: round(map.get("h")),
    text: String(map.get("text") ?? "").slice(0, 24).replace(/\s+/g, " "),
  });
}
rows.sort((a, b) => (a.id < b.id ? -1 : 1));

console.log(`frames ${frames} · items ${rows.length} · pins ${pins.size} · strings ${strings.size}`);
for (const r of rows) {
  console.log(
    `${r.id}  ${String(r.type).padEnd(8)} x ${String(r.x).padStart(10)}  y ${String(r.y).padStart(10)}  rot ${String(r.rot).padStart(8)}  ${r.w}x${r.h}  "${r.text}"`,
  );
}
console.log("--- pins");
for (const [id, map] of [...pins].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  console.log(
    `${id}  parent ${String(map.get("parent") ?? "-").padEnd(24)} lx ${String(round(map.get("lx"))).padStart(10)}  ly ${String(round(map.get("ly"))).padStart(10)}`,
  );
}
