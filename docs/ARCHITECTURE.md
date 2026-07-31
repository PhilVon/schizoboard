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
    lod.ts            the tier the camera is at, and the one place that decides
    items/            one view per archetype, node pooling — behind an interface
    ink/              stroke geometry, per-item canvas, wet overlay, re-raster policy
    ropes/            paint.ts — one screen-space painter, instantiated per canvas
    pins/             pin DOM nodes — a DOM layer, and an export painter (T-214)
    presence/         remote cursors, drag ghosts, remote wet ink
    cork.ts

  platform/
    types.ts          the interface, and the only place a command's shape is stated
    tauri.ts          every invoke() in one module
    mock.ts           the same interface for browser dev, so the frontend runs with no shell
    index.ts · env.ts which of the two is in use, and how that is decided

  lib/                fifteen dependency-free helpers — angle, carry, cellgrid, ids,
                      ink, inkhit, material, palette, polaroid, pressure, rotate,
                      seed, slack, strokepack, textdiff. Imports NOTHING; there is
                      an eslint rule saying so, and it is what stops rule 2 being
                      laundered through here.

  styles/             base.css — chrome tokens and the print rules. Not the board.

  spike/              the Phase 0 fidelity spike (D-12), kept because its numbers are
                      still the argument for the DOM renderer

  ui/                 toolbars, panels, dialogs — framework components, NOT the board

src-tauri/
  src/
    lib.rs            every #[command], and the one generate_handler! that registers them
    assets.rs         content-addressed store, hashing, decode, variants, 30-day trash
    protocol.rs       the asset:// URI scheme handler
    docstore.rs       append-only update log, snapshots, compaction
    bundle.rs         .schizo zip read/write
    board.rs          which board this window is on, and the secret it was opened with
    print.rs          PrintToPdf through with_webview — Windows only (T-207, T-210)
    clipboard.rs      native clipboard and drag-drop
    sync/             embedded relay, mDNS discovery, asset transfer, the connect secret
    bin/relay.rs      the same relay as a headless binary, for a hosted seed (D-7)
```

### 2.1 The Scene

`state/scene.ts` is a plain mutable mirror of the document — no CRDT types, no observers, no framework reactivity. Hot fields (`x`, `y`, `rot`, `w`, `h`) live in `Float32Array`s indexed by a dense slot id; cold fields live in ordinary objects.

This exists so that `sim/` and `render/` can run at 60 fps against tight typed-array loops without ever touching Yjs, and so that either can be tested with no document at all.

`crdt/binding.ts` is the sole translator. It is the only file in the codebase that subscribes to Yjs events.

### 2.2 Why `platform/tauri.ts` is one module

Every native call goes through one file so the whole frontend can run in a plain browser against mocks. That keeps the fast dev loop fast, makes the renderer testable, and keeps a browser build technically viable if it's ever wanted.

There is no `platform/clipboard.ts` and no `platform/files.ts`, and there was never a moment where splitting them would have helped: the point of this seam is that `grep invoke src/` returns one file, and three files that each hold some of the invokes is the same seam with two more places to look. The clipboard's and the file dialog's *commands* are ordinary members of the one interface in `types.ts`.

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

**There is a Rust-side Yjs now, and the note above still holds** — which is worth saying because the two look like a contradiction. `yrs 0.27` is a dependency, scoped to the relay, because a y-websocket server has to answer a state vector with the difference and §5.1 wants the same binary usable as an always-seeding peer, which cannot seed what it does not hold. What section 4.1 was guarding against is two implementations of the **schema**, and there is still only one: the relay never opens an item, a pin or a string. Headless compaction of *meaning* would cross that line and is still not being done. `Cargo.toml` carries the argument beside the dependency.

**Bundles**, native clipboard and drag-drop, URL fetching (no CORS wall), the embedded relay, and asset transfer.

### 4.2 The frontend owns meaning

All CRDT logic, all rendering, all physics, tool state, and the *policy* of what to ingest. Everything schema-shaped stays in one language.

### 4.3 The one interface decision that matters most

**Image bytes reach the webview through a custom URI scheme, never through IPC.**

Register an asynchronous URI scheme handler so `<img src="asset://sha256/<hash>?v=display">` streams from disk with browser caching and range requests, at zero JavaScript memory cost.

Base64-ing a 12 MB photograph across the IPC boundary is the obvious first thing to try and roughly the worst available option: it inflates by a third, blocks on serialisation, and pins the whole image in JS heap.

### 4.4 IPC surface

All thirty, as `generate_handler!` registers them.

```
// commands (all async)
app_info()                 → { version, platform }

asset_ingest_bytes(bytes)  → { sha256, w, h, mime, size }
asset_ingest_path(path)    → same
asset_ingest_url(url)      → same
asset_has(hashes[])        → bool[]
asset_export(sha256, name?) → saved  // no dest: a native save dialog supplies it
asset_gc(keepSet[])        → { freedBytes }

doc_append_update(bytes)   → ()         // awaited; a failed write rejects (T-220)
doc_load()                 → { snapshot, updates[] }
doc_compact(snapshot)

// no path in either direction, for the reason `asset_export` gives below
bundle_save_as(manifest, snapshot) → { embedded, missing[], bytes } | null
bundle_open()              → { manifest, snapshot, ingested[], missing[] } | null

// export, in two halves — see the note under `asset_export` below.
// One `choose` for both routes: PDF and image are two filters on one dialog,
// and what comes back is the format the user settled on, or null for cancelled.
export_choose(title, kind) → "pdf" | "png" | "webp" | null
export_pdf_write(page)     → path         // prints the webview into it
export_image_write(bytes)  → path         // writes the composited canvas into it

clipboard_read_manifest()  → { kinds: [...] }
clipboard_read_item(kind)  → { sha256 } | { text } | { html, srcUrl }
clipboard_source_url()     → url | null   // the CF_HTML SourceURL line, Win32 direct

sync_start(config) / sync_stop() / sync_status()
sync_take_invite()         → invite | null    // what a deep link arrived carrying
board_remembered()         → { boardId, secret } | null
board_remember(boardId, secret)               // beside the document, per Q-75

peer_have_summary()        → sha256[]     // everything this machine can serve
asset_size(sha256)         → bytes        // 0 for one it does not hold
asset_chunk(sha256, index) → bytes        // raw, to put on the wire
asset_receive(bytes)                      // raw body; hash/index/total on headers
asset_commit(sha256)       → bool         // verified, or nothing written
asset_abort(sha256)

// events (Rust → frontend). Four, and these four are all of them:
asset:ready · files:dropped · deeplink:open · sync:peer-found
```

**Three events in earlier drafts of this list have no producer and never had one** — `asset:progress`, `sync:peer-joined` and `sync:peer-left`. They are declared in `platform/types.ts` and emitted by nobody, which is a different and worse thing than being unbuilt: a listener for one of them is code that compiles, runs and waits forever. `doc:persist-error` was a fourth until T-220, which found the missing hop was not the event at all — `doc_append_update` awaits the disk and a failure already rejects to a caller, so the surface was wired the wrong way round rather than unwired. The declarations are kept for now because removing an entry from a public-looking interface is its own change; what has been removed is the impression that anything emits them.

Binary payloads use raw request/response bodies, never JSON arrays. `doc_append_update` is coalesced in JS (roughly every 200 ms or 32 KB) before crossing the boundary.

**`asset_export` deliberately takes a name and not a destination.** A copy overwrites whatever is already at its path, so a path the renderer picks is a path an injected script picks — and paste ingests HTML from other people's pages. A validator is not the answer, because no rule separates the places a user may reasonably save an image from the places an attacker would like to write; both are "somewhere on this disk". A native save dialog is: the user names the file, so consent and destination arrive as the same act.

The frontend still has to pass the asset's `origName`, because the document holds it and Rust holds no schema to read it from — a dialog offering a hash is a dialog nobody recognises their own photograph in. That is the one caller-supplied string in this command, and it crosses as a *name*, which is the difference that makes it safe: a name has recognisably wrong answers where a path has none. Rust reduces it to a bare filename before the dialog sees it and takes the extension from the bytes rather than from the suggestion, so `..\..\Startup\holiday.exe` reaches the user as `holiday.jpg` in whichever directory they were already looking at.

Prefer this shape wherever the boundary is asked for a location: take the *intent* from the webview and let the native side obtain the location.

**Both exports took it too, and had to be split in two to** (T-207). `export_choose` opens the save dialog and answers only *which format* the user settled on — never where; `export_pdf_write` and `export_image_write` write into it. The path is held in shell state between the two calls and never crosses in either direction, so the pair is the same rule as above rather than an exception to it — what the webview can do with them is bounded and dull: a `write` with no `choose` finds an empty slot and fails, a second `write` finds the slot already taken and fails, and a second `choose` replaces a path nobody used with one the user has just agreed to.

One `choose` for both routes rather than one each, because PDF and image are two filters on a single dialog and it is the *dialog* that decides which of the two this is (Q-138, T-212). That is why it returns a format rather than a boolean: the caller asked to export the board and the user answered by naming a file, and the extension they picked is the answer to "as what".

It is two commands rather than one because of *ordering*, not security. The board has to be posed for the page before the print — a print lays out at the paper width and fires no `resize` — and a single command would have printed the instant the dialog closed, so the window was already zoomed out to its own bounds while somebody was still typing a filename. Asking first also makes the common case the cheap one: cancelling now moves nothing at all.

**Both bundle commands took the advice** (T-84). `bundle_save_as` was written above as `bundle_save_as(path)` and does not take one: it takes the board's title, on exactly the standing `origName` has — a suggestion `safe_stem` reduces before the dialog shows it — and the save dialog supplies the rest. `bundle_open` takes nothing at all and opens a picker. Between them and `asset_export` that is every place in the application where a file is chosen, and none of them lets the webview name one.

**There is no `bundle_recent`.** This list used to carry one, unbuilt, beside the two above — a recent-boards list, of the kind every application with a *File* menu has. Nothing in DESIGN or DATA-MODEL ever mentioned recent boards, so that line was the only evidence the feature had been wanted at all, and Q-111 changed what it would mean before anyone built it: *Open a board…* **replaces** the board in this window rather than opening a second one. A list of recently opened boards is therefore a list of one-click ways to destroy the board you are looking at — each behind the same native confirmation as the picker, and with none of the deliberateness of going and finding a file, which is the part of the gesture actually doing the protecting. Struck on Q-145 rather than left standing as an unbuilt promise; D-38 is the record.

What crosses instead is a manifest and a snapshot, framed as `[u32 le length][json][snapshot]` in one raw body, because Tauri's raw payload is all-or-nothing and a document sent as a JSON array of numbers is the mistake §4.3 already rejected for photographs. Rust reads the manifest and never the snapshot: it is handed a title, a schema version and a list of hashes, which is the whole of what a bundle is from a side that owns bytes and no schema.

**Ingestion returns as soon as the hash and dimensions are known**, so the item appears instantly at the correct size while variants generate in the background and an `asset:ready` event follows.

### 4.5 Clipboard policy

Try the web `paste` event first — it's the fast path, needs no permission, and handles inline images and text well. Fall back to native when it comes back empty or reports zero-length files, which is what happens with Explorer and Finder file copies.

Native is strictly more capable and covers the cases that otherwise silently fail: file paths, multi-image payloads, and reliable source URLs from clipboard HTML. Files dragged in from the OS arrive as paths rather than blobs and go straight into the store without ever touching JS.

### 4.6 Plugins

Planned: `fs` (scoped), `dialog`, `clipboard-manager`, `opener`, `store`, `window-state`, `single-instance`, `deep-link` (for `schizo://` invites), `updater`, `log`, `os`, `process`.

**Five are compiled in**: `opener`, `dialog` (which pulls `fs` in with it, for the scope type its own file argument needs), `deep-link`, and `single-instance` with the `deep-link` feature. The rest are not, and the list above should be read as what was planned rather than as what is there.

Two of the missing have deliberate substitutes with the reason written down beside them. `store` is `localStorage`, because a preference that failed to load must not hold up the board and because the frontend has to run in a plain browser, which is where most of this application is developed (`app/prefs.ts`). `clipboard-manager` is a direct Win32 read of `CF_HTML`, because nothing safe wraps that format and the `SourceURL:` line is the whole reason the clipboard is being read at all (`clipboard.rs`, T-97).

The one with a user-visible consequence is `window-state`: the window does not come back where you left it, and nothing else in the repo does that job. It is filed as T-233 rather than left as an unbuilt line here.

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
