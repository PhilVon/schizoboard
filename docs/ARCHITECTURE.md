# Schizoboard — Architecture

**Companion to [`DESIGN.md`](./DESIGN.md) and [`DATA-MODEL.md`](./DATA-MODEL.md).** Module boundaries, the frame loop, the native split, and the wire protocols.

---

## 1. The two rules

Everything below follows from these. Break either and the system stops being maintainable.

> **1 · Every document mutation goes through `crdt/ops/`.**
> Nothing anywhere else touches Yjs directly. Every op wraps a transaction with an explicit origin. This is what makes undo scoping, echo suppression and write batching possible at all — and it's enforceable with a lint rule, so enforce it.

> **2 · `sim/` and `render/` never import `crdt/`.**
> They read a plain in-memory scene mirror. One module translates document events into scene mutations plus dirty flags. Durable state flows exactly one way.

```
interaction → crdt/ops → Y.Doc → observer → binding → Scene → render
```

The scoped exception is **ephemeral** state — a live drag pose, a wet ink stroke — which writes straight to the Scene and to awareness, and reconciles when the document write lands (§9.2 of `DATA-MODEL.md`).

*One-way for durable state, two-way-with-reconcile for ephemeral state.* That's the whole architecture in a sentence.

---

## 2. Module layout

```
src/
  app/                bootstrap, window chrome, menus, provider wiring

  crdt/
    schema.ts         types and typed accessors — imports nothing from render/ or sim/
    doc.ts            Y.Doc, root types, schema version
    ops/              items · pins · strings · ink · z · cascade
                      ALL mutations live here; each wraps doc.transact(fn, origin)
    binding.ts        the ONLY module that reads Yjs events → Scene + dirty sets
    undo.ts
    persistence.ts    batched adapter over the native update log
    sync/             SyncProvider interface · ws · lan · relay · assets

  state/
    scene.ts          plain mirrored scene graph; hot fields in typed arrays
    dirty.ts          dirty sets: items, ropes, ink, plus coarse flags
    camera.ts
    selection.ts
    tools/            machine.ts + select · pin · string · marker · highlighter · eraser

  sim/
    verlet.ts         constraint solver, fixed-timestep accumulator
    catenary.ts       analytic rest-pose seeding
    ropes.ts          rope set allocation, sleep manager, bounds index
    torsion.ts        single-pin item swing
    tuning.ts         every tuning value, one place, bound to a debug panel

  render/
    loop.ts           THE single requestAnimationFrame
    world.ts          camera transform, DOM wrapper, will-change discipline
    cull.ts           viewport culling — uniform spatial grid, hysteresis band
    items/            one view per archetype, node pooling — behind an interface
    ink/              stroke geometry, per-item canvas, wet overlay, re-raster policy
    ropes/            paint.ts — one screen-space painter, instantiated per canvas
    pins/             pin DOM nodes
    presence/         remote cursors, drag ghosts, remote wet ink
    cork.ts

  platform/
    tauri.ts          every invoke() in one module — mockable for browser dev
    clipboard.ts
    files.ts

  ui/                 toolbars, panels, dialogs — framework components, NOT the board

src-tauri/
  src/
    assets.rs         content-addressed store, hashing, decode, variants
    protocol.rs       the asset:// URI scheme handler
    docstore.rs       append-only update log, snapshots, compaction
    bundle.rs         .schizo zip read/write
    clipboard.rs      native clipboard and drag-drop
    sync/             embedded relay, mDNS discovery, asset transfer
```

### 2.1 The Scene

`state/scene.ts` is a plain mutable mirror of the document — no CRDT types, no observers, no framework reactivity. Hot fields (`x`, `y`, `rot`, `w`, `h`) live in `Float32Array`s indexed by a dense slot id; cold fields live in ordinary objects.

This exists so that `sim/` and `render/` can run at 60 fps against tight typed-array loops without ever touching Yjs, and so that either can be tested with no document at all.

`crdt/binding.ts` is the sole translator. It is the only file in the codebase that subscribes to Yjs events.

### 2.2 Why `platform/tauri.ts` is one module

Every native call goes through one file so the whole frontend can run in a plain browser against mocks. That keeps the fast dev loop fast, makes the renderer testable, and keeps a browser build technically viable if it's ever wanted.

---

## 3. The frame

One `requestAnimationFrame`, in `render/loop.ts`. Nothing else animates independently — no CSS transitions on board content, no per-item timers.

```
frame(t):
  1. INPUT      drain coalesced pointer events → tool state machine
                (mutates ephemeral scene, queues awareness, may queue doc ops)
  2. PRESENCE   apply interpolated remote poses at (now − 100 ms)
  3. SIM        accumulator: step awake ropes and torsions whose bounds
                intersect viewport+margin; run sleep checks; apply impulses
  4. LAYOUT     recompute world pin positions for dirty items
  5. DOM        write transforms for dirty items only          ← WRITE PHASE
  6. INK        re-raster items in the dirty-ink set
  7. ROPES      clear + draw under canvas, then over canvas, in screen space
  8. OVERLAY    remote cursors, ghosts, wet ink, selection chrome
  9. FLUSH      awareness (every 2nd frame), doc ops queued this frame
```

**Strict read-then-write separation.** Phases 1–4 read and compute; phase 5 is the only place DOM is written. **No layout reads anywhere in the loop** — no `getBoundingClientRect`, no `offsetWidth`. Every geometry value comes from the Scene. A single stray read in phase 5 forces synchronous layout and costs the frame.

The dev HUD reports per-phase milliseconds, so a regression shows up as a number rather than as "it feels slower lately".

---

## 4. Native split

### 4.1 Rust owns bytes

**Asset store.** Two-level fan-out under the app data directory: `assets/<aa>/<bb>/<sha256>`. Streaming SHA-256, decode, EXIF orientation, and generated variants — a thumbnail, a display-size version, and the untouched original. Heavy decode runs on a thread pool; the UI thread never sees a multi-megabyte buffer.

**Document log.** Append-only, length-prefixed opaque frames, flushed on a batch. Rust doesn't need a Yjs implementation for this — it appends bytes. The frontend periodically emits a snapshot and Rust atomically swaps it in and truncates the log.

*(A Rust-side Yjs implementation would let the relay compact headlessly and would be reusable server-side, but it means two implementations must agree on the schema. Start frontend-driven.)*

**Bundles**, native clipboard and drag-drop, URL fetching (no CORS wall), the embedded relay, and asset transfer.

### 4.2 The frontend owns meaning

All CRDT logic, all rendering, all physics, tool state, and the *policy* of what to ingest. Everything schema-shaped stays in one language.

### 4.3 The one interface decision that matters most

**Image bytes reach the webview through a custom URI scheme, never through IPC.**

Register an asynchronous URI scheme handler so `<img src="asset://sha256/<hash>?v=display">` streams from disk with browser caching and range requests, at zero JavaScript memory cost.

Base64-ing a 12 MB photograph across the IPC boundary is the obvious first thing to try and roughly the worst available option: it inflates by a third, blocks on serialisation, and pins the whole image in JS heap.

### 4.4 IPC surface

```
// commands (all async)
asset_ingest_bytes(bytes)  → { sha256, w, h, mime, size }
asset_ingest_path(path)    → same
asset_ingest_url(url)      → same
asset_has(hashes[])        → bool[]
asset_export(sha256, name?) → saved  // no dest: a native save dialog supplies it
asset_gc(keepSet[])        → { freedBytes }

doc_append_update(bytes)               // fire-and-forget, coalesced in JS
doc_load()                 → { snapshot, updates[] }
doc_compact(snapshot)

bundle_open(path) / bundle_save_as(path) / bundle_recent()

clipboard_read_manifest()  → { kinds: [...] }
clipboard_read_item(kind)  → { sha256 } | { text } | { html, srcUrl }

sync_start(config) / sync_stop() / sync_status()

peer_have_summary()        → sha256[]     // everything this machine can serve
asset_size(sha256)         → bytes        // 0 for one it does not hold
asset_chunk(sha256, index) → bytes        // raw, to put on the wire
asset_receive(bytes)                      // raw body; hash/index/total on headers
asset_commit(sha256)       → bool         // verified, or nothing written
asset_abort(sha256)

// events (Rust → frontend)
asset:ready · asset:progress · files:dropped · doc:persist-error
deeplink:open · sync:peer-joined · sync:peer-left
```

Binary payloads use raw request/response bodies, never JSON arrays. `doc_append_update` is coalesced in JS (roughly every 200 ms or 32 KB) before crossing the boundary.

**`asset_export` deliberately takes a name and not a destination.** A copy overwrites whatever is already at its path, so a path the renderer picks is a path an injected script picks — and paste ingests HTML from other people's pages. A validator is not the answer, because no rule separates the places a user may reasonably save an image from the places an attacker would like to write; both are "somewhere on this disk". A native save dialog is: the user names the file, so consent and destination arrive as the same act.

The frontend still has to pass the asset's `origName`, because the document holds it and Rust holds no schema to read it from — a dialog offering a hash is a dialog nobody recognises their own photograph in. That is the one caller-supplied string in this command, and it crosses as a *name*, which is the difference that makes it safe: a name has recognisably wrong answers where a path has none. Rust reduces it to a bare filename before the dialog sees it and takes the extension from the bytes rather than from the suggestion, so `..\..\Startup\holiday.exe` reaches the user as `holiday.jpg` in whichever directory they were already looking at.

Prefer this shape wherever the boundary is asked for a location: take the *intent* from the webview and let the native side obtain the location.

**Ingestion returns as soon as the hash and dimensions are known**, so the item appears instantly at the correct size while variants generate in the background and an `asset:ready` event follows.

### 4.5 Clipboard policy

Try the web `paste` event first — it's the fast path, needs no permission, and handles inline images and text well. Fall back to native when it comes back empty or reports zero-length files, which is what happens with Explorer and Finder file copies.

Native is strictly more capable and covers the cases that otherwise silently fail: file paths, multi-image payloads, and reliable source URLs from clipboard HTML. Files dragged in from the OS arrive as paths rather than blobs and go straight into the store without ever touching JS.

### 4.6 Plugins

`fs` (scoped), `dialog`, `clipboard-manager`, `opener`, `store`, `window-state`, `single-instance`, `deep-link` (for `schizo://` invites), `updater`, `log`, `os`, `process`.

A plugin being initialised is not the same as the webview being able to call it. `dialog` is registered for Rust's own use and appears in no capability, so `asset_export` is the only thing in the application that can open a file dialog — a script in the webview cannot open one of its own. Prefer that shape for anything that touches the disk.

Deliberately **not** a SQL plugin — the document is the database.

Budget for a native WebSocket plugin: the webview's own WebSocket will hit TLS problems against a self-signed LAN peer, and planning for it beats discovering it.

---

## 5. Sync

### 5.1 One protocol, two modes

A transport-agnostic `SyncProvider` interface — `connect`, `disconnect`, `on(update)`, `awareness`, `status` — implementing the y-websocket wire protocol, **with the relay embedded in the application binary**. The same code runs:

- **LAN mode** — any peer hosts, advertised over mDNS; peers discover and connect directly. Zero infrastructure, works with no internet.
- **Relay mode** — the identical binary on a small server as an always-on, always-seeding peer.

Yjs supports multiple simultaneous providers, so a client attaches disk persistence, LAN and relay at once, and deduplication is free.

**The tradeoff:** we own uptime, authentication and NAT traversal, and in LAN mode the hosting peer must stay online. In exchange, no vendor dependency, no per-user cost, genuine offline-first operation, one protocol to debug, and a relay that doubles as the asset seed — which is the part that's actually hard. A hosted service would remove the operations work but still wouldn't solve assets, would still need a local provider for offline, and would make LAN-only collaboration impossible.

### 5.2 Asset transfer

Assets aren't in the document, so they need their own path — a side channel on the same connection:

```
HAVE(hashPrefixes)                          // periodic, compact
WANT(sha256, priority)
DATA(sha256, chunkIdx, totalChunks, bytes)  // 256 KB chunks
DONE(sha256)                                // full hash verified before CAS commit
NACK(sha256)                                // "I don't have it"
```

Rust does chunking, verification and the store commit. The frontend only orchestrates by hash — a chunk leaves `asset_chunk` and enters `asset_receive` without JavaScript reading a byte of it, and `asset_commit` refuses anything that does not hash to the name it arrived under.

**The relay routes these; it does not answer them.** Peers trade with each other over the same connection, addressed by Yjs client id, and the relay substitutes the sender's id so it cannot be forged. An always-seeding peer is the identical binary running the *application*, with the asset store it already has — not the relay, which holds no bytes and would have to do file I/O under the lock every other peer's frames queue behind. D-28 has the argument; `peer_want` is gone with it, because the queue cannot live in Rust when the socket belongs to the webview.

**Fetch policy is lazy and prioritised.** An asset whose item is in or near the viewport is high priority; everything else backfills at low priority with bounded concurrency. Since peers broadcast their camera over awareness, a seeder can push what someone is about to look at.

**Missing is a render state, not an error** — `unknown → requesting → transferring → ready | unavailable` — and the item stays fully usable throughout (§7.5 of `DESIGN.md`).

---

## 6. Testing

| Layer | Approach |
|---|---|
| `crdt/ops` | Unit tests against a headless `Y.Doc`. No renderer, no DOM. |
| Merge semantics | **The fuzz harness.** Two documents, randomised concurrent operation sequences, all invariants in §13 of `DATA-MODEL.md` asserted after every merge. This is the highest-value test in the project. |
| `sim/` | Golden tests: given pins and slack, the settled pose is within tolerance of the analytic catenary. Sleep must actually happen within a bounded frame count. |
| `render/` | Screenshot comparison on a fixed board at fixed zooms. |
| Perf | A benchmark board — 1000 items, 300 strings, heavy ink — with frame-time assertions in CI. |
| Native | Rust unit tests for hashing, variants, chunking and bundle round-trips. |

The fuzz harness earns priority because concurrent editing bugs are invisible in single-user testing and extremely painful in production.

---

## 7. Development

The frontend runs in a plain browser against `platform/` mocks for fast iteration, and in the Tauri shell for anything touching the filesystem, native clipboard or sync.

**The phase-0 fidelity spike comes before any product code:** 500 real photographs in the world wrapper, zoomed across the full range, proving the re-raster story and the `will-change` discipline. It settles the renderer choice while changing it is still cheap (Risk 1, `DESIGN.md`).

The dev HUD ships from phase 0 — per-phase frame timings, awake particle count, DOM node count, document size. Performance you don't measure becomes performance you can't fix.
