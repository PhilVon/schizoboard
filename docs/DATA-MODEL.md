# Schizoboard — Data Model

**Companion to [`DESIGN.md`](./DESIGN.md).** This is the contract every other part of the system depends on, which is why it lives in its own document.

---

## 1. The governing rule

> **A field is a CRDT type only if two people can meaningfully edit different parts of it at the same time. Everything else is a plain value inside a `Y.Map`, so it gets clean last-write-wins.**

Note text is a `Y.Text`, because two people can type into the same note and both edits should survive. Item position is a plain number, because two concurrent drags should resolve to one position or the other — merging them into a midpoint would put the item somewhere neither person moved it.

Applying this rule inconsistently is how CRDT documents end up with fields that merge into nonsense. When adding a field, answer the question explicitly.

---

## 2. Root structure

```js
doc.getMap('meta')      // board metadata
doc.getMap('items')     // itemId   → Y.Map
doc.getMap('pins')      // pinId    → Y.Map
doc.getMap('strings')   // stringId → Y.Map
doc.getMap('assets')    // sha256   → Y.Map   (metadata only — never bytes)
doc.getMap('boardInk')  // tileKey  → Y.Map<strokeId, Y.Map>
```

**Keyed maps, not arrays.** Constant-time lookup, no index churn when something is deleted, and concurrent creation never contends over positions. Ordering is an explicit `z` field (§7), never array position.

**`boardInk` is tiled** into 2048-unit cells, keyed by the floor-divided coordinates of each stroke's bounding-box centre. Tiles give culling, observer granularity and future lazy loading a natural unit. A stroke larger than a tile is assigned to its centre tile; the renderer culls by the stroke's own bounds anyway, so tiles are only a coarse bucket.

### `meta`

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | number | Drives migration (§10) |
| `title` | string | |
| `corkSeed` | number | Deterministic cork texture variation |
| `createdAt` | number | Epoch ms |
| `boardEpoch` | number | Reserved for ageing, and **not read**. §4.7 of DESIGN ages each item from its own `createdAt` against the wall clock (Q-105), so there is no board-wide reference point to keep. Written on `initialiseBoard` and left alone: removing it would be a schema change to delete a field that costs one number. |

---

## 3. Items

```js
items: {
  [itemId]: Y.Map {
    type, x, y, rot, w, h, z, seed,
    assetId,
    text:    Y.Text,
    style:   Y.Map,
    strokes: Y.Map<strokeId, Y.Map>,
    createdBy, createdAt
  }
}
```

| Field | CRDT type | Rationale |
|---|---|---|
| `type` | plain string | `'polaroid' \| 'note' \| 'scrap' \| 'card'`. Immutable after creation. Two of the four are never written: a scrap is a `note` with no text in it, and `card` was struck as an archetype on Q-179. Both stay accepted, because `readItem` drops an item whose type it does not know. |
| `x`, `y` | plain number | Board coordinates of the item's **centre**. LWW is exactly right — two concurrent drags must resolve to one of them, never a midpoint. |
| `rot` | plain number | Authored rotation in radians. The physics swing is a **local visual offset** and is never stored here. |
| `w`, `h` | plain number | Intrinsic size in board units. **Present even when the asset is missing**, so layout never reflows when bytes arrive. |
| `z` | plain string | Fractional index (§7). |
| `seed` | plain number | Drives all deterministic per-item variation: scatter rotation, paper grain offset, edge raggedness, ageing, handwriting jitter. Assigned once at creation, never changed. |
| `assetId` | plain string \| null | SHA-256 hex. |
| `text` | **`Y.Text`** | Note body or polaroid caption. Character-level concurrent editing. |
| `style` | **`Y.Map`** | `paperStock`, `tint`, `tapeStyle`, `fontFamily`, `torn` — the five `lib/style.ts` defines and `setItemStyle` can write. A `Y.Map` so two people adjusting different properties don't clobber each other. This row also listed `fontSize` and `agingEnabled` until a re-survey found neither had ever existed: no reader, no writer, and nothing in DESIGN asking for a per-item text size or a per-item ageing switch. They are struck rather than left as a promise. |
| `strokes` | **`Y.Map`** | Nested deliberately — see below. |
| `createdBy`, `createdAt` | plain | Provenance and tie-breaking. |

**`crop` was struck (T-240, Q-190).** It was here from the beginning as `{sx, sy, sw, sh}` and nothing ever wrote one: `createItems` set it to `null`, the clipboard round-tripped it faithfully, `readItem` validated it — and `state/scene.ts`'s `ItemCold`, the only item record a painter reads, never carried the field at all. So it was inert from the document to the screen rather than merely unproduced, and §3.4 of DESIGN has never asked for a cropping gesture. It is struck rather than reserved because nothing is lost by striking it: a `crop` key left on an item by an older build is simply ignored on read, which is not true of an unknown `type` (see the row above — that is why `card` had to stay). The photograph a polaroid frame trims to fit is a different thing entirely and is not stored: it is `object-fit: cover` at draw time (`render/items/items.css`).

**Why `strokes` is nested inside the item.** Ink dies with the item it was drawn on, and undoing a delete must restore the ink atomically. Nesting gives both for free: deleting the item's map deletes the strokes with it, and one undo entry restores everything. Pins can't work this way (they're referenced by strings and can outlive the item), which is why they're top-level and need explicit cascade code (§8).

---

## 4. Pins

```js
pins: {
  [pinId]: Y.Map {
    parent,      // itemId | null
    lx, ly,      // item-local un-rotated coords if parented; board coords if free
    kind, color,
    createdBy, createdAt
  }
}
```

| Field | CRDT type | Notes |
|---|---|---|
| `parent` | plain string \| null | `null` means free-floating in the cork. **The single source of truth for ownership.** |
| `lx`, `ly` | plain number | Interpretation depends entirely on `parent`. When parented, these are item-local and **un-rotated**, which is why rotating an item transports its pins with no work. |
| `kind` | plain string | `'pushpin' \| 'thumbtack' \| 'nail' \| 'tape'`. The first three are pushed into the board and hold the item up; **`tape` is stuck to the paper only** and holds a string to it without holding it to the wall, so it does not count toward the item's physics (§2.2). A build that has never heard of a kind falls back to `pushpin`, so it draws the wrong object rather than losing the anchor. |
| `color` | plain string | |

**Re-parenting is a two-field write inside one transaction:** set `parent`, convert `lx/ly` into the new frame. That is the entire drag-a-pin-onto-a-note feature at the data layer.

**Do not add an `item.pinIds` array.** Denormalising ownership means a concurrent item-delete and pin-add can leave the two views disagreeing. `pin.parent` is authoritative; the reverse index `Map<itemId, Set<pinId>>` is **derived locally** and rebuilt from observers.

---

## 5. Strings

```js
strings: {
  [stringId]: Y.Map {
    nodes: Y.Array<Y.Map { nodeId, pin, slackAfter }>,
    color, thickness, material,
    layer,       // 'over' | 'under'
    closed,      // bool
    createdBy, createdAt
  }
}
```

| Field | CRDT type | Notes |
|---|---|---|
| `nodes` | **`Y.Array` of `Y.Map`** | The ordered run. See below. |
| `color` | plain string | Default is the cotton red, not a pure red. |
| `thickness` | plain number | |
| `material` | plain string | `'string' \| 'yarn' \| 'wire'` — affects sag stiffness and texture. |
| `layer` | plain string | `'over'` draws above items and collides with them; `'under'` draws beneath and doesn't. |
| `closed` | plain bool | Loops the last node back to the first. |

### 5.1 Why slack lives on the node

**This is the single most important schema decision for strings.**

The obvious model — `pins: Y.Array<pinId>` plus `slack: Y.Array<number>` — desynchronises the instant two clients insert at different indices. The arrays end up different lengths, with slack values attached to the wrong gaps, and there is no way to recover the intent.

Making each element a `Y.Map` node that carries its own reference *and* its own slack makes concurrent insertion correct by construction. Hub pins still work, because the node holds a **reference** to a pin rather than being one — any number of nodes across any number of strings may point at the same pin.

### 5.2 Slack is a ratio

```
restLength(i) = chord(P_i, P_i+1) × (1 + slackAfter_i)
```

Scale-invariant, and it makes the mid-string split (§5.3) jump-free without special maths.

Constraints:

- `slackAfter` must be **strictly greater than zero**, clamped to a small minimum. At rest length equal to the chord the solver has no slack to absorb error and the rope jitters visibly.
- Typical range is 0.05 to 0.3. Presets `1`–`9` map across this range.

**`slackAfter` on the terminal node of an open string is unused and undefined.** When `closed` is `true` it becomes the wrap-around segment. State this explicitly or someone will write a bug against it.

### 5.3 Insertion and removal

**Inserting a node** at index *i*, splitting the segment at arc-length fraction *t*:

- Insert the new node so the run reads `… P_i, P_new, P_i+1 …`.
- Split the slack so the two child rest lengths **sum to the parent's**, apportioned by *t*.

Anything else changes the total sag at the instant of insertion, which reads unmistakably as a bug.

**Removing a node** in the middle: the neighbouring segments merge, with rest lengths summed and converted back to a ratio against the new chord. Removing a terminal node just drops it. A string left with fewer than two valid nodes deletes itself.

### 5.4 Concurrent insertion into the same segment

Two clients splitting the same segment simultaneously both compute their split from the same prior state, so the total rest length changes once. Accepted:

- Read the prior state **inside** the transaction.
- Take an advisory lock on the segment over awareness, purely as a UX hint — never as a correctness mechanism.
- Accept the one-time sag change in this rare conflict. The result is always valid; it just sags slightly differently than either user expected.

---

## 6. Strokes

Identical shape whether nested under an item or under a board-ink tile.

```js
stroke: Y.Map {
  tool, color, size, opacity, seed,
  bbox: [x0, y0, x1, y1],
  z,
  pts: Uint8Array,         // packed
  page                     // optional; absent for a mark on the object itself
}
```

| Field | Notes |
|---|---|
| `tool` | `'marker' \| 'highlighter' \| 'erase'` |
| `seed` | Deterministic texture variation along the stroke |
| `bbox` | In the stroke's own coordinate space. Used for culling and hit-testing without unpacking `pts`. |
| `z` | Ordering within the item or tile |
| `pts` | Packed input points (§6.1) |
| `page` | Which page of the item's document the mark is on, one-based. **Absent** for a mark on the object itself, which is every stroke on a photograph, on a sheet of paper, on the cover of a shut case file, and on bare cork. Never present on board ink. |

**Coordinate space** is item-local for item strokes, board for board ink. It is decided at pen-down and never changes.

### 6.1 Point packing

On pen-up, in one transaction:

1. Simplify with Ramer–Douglas–Peucker, epsilon around 0.4 units at 100% zoom.
2. Quantise to eighths of a unit.
3. Delta-encode `(dx, dy, dPressure)`.
4. Varint-pack into a `Uint8Array`.

Roughly 3–4 bytes per point against 50-odd for JSON floats. Yjs stores `Uint8Array` natively in its binary update format, so this costs nothing extra on the wire.

**Store input points, never the generated outline.** The outline is about ten times the data and can't be re-tuned if stroke parameters change later.

### 6.2 One stroke, one record

Everything up to pen-up is local and ephemeral (§9). The commit is a single `Y.Map` insertion — which makes a stroke atomic for undo, deletion and hit-testing.

**Erasing deletes stroke records.** The smudge eraser is itself stored as a normal stroke with `tool: 'erase'`, rendered with `destination-out`. Ink is never rasterised and flattened; that would destroy both undo and merge.

### 6.3 The page a mark is on

A case file is the only object on this board with two faces: a kraft cover when
it is shut, and one page of the document inside it when it is open. So it is the
only object for which "where the ink is" needs a second answer, and `page` is it
(T-278). Marker on an open page is redaction.

The rule the reader, the pen, the rubber and the raster all follow is one
sentence: **a mark is drawn when the surface it was made on is the surface you
are looking at.** A shut folder shows its cover, an open one shows the page, and
a photograph shows everything — through the rule rather than as an exception to
it.

Three things it is not:

- **It is not the reader's position.** Which page *you* are on is deliberately
  local and never on the wire, for the reason the camera came off awareness. This
  is a different fact about a different thing: where a mark was made, which is a
  property of the mark and as durable as its own coordinates.
- **It is not written unless it is a page.** A board of ordinary ink produces
  byte-identical records to the build before this one, and a key that is absent
  is also a key an older build cannot misread.
- **It does not redact the text.** Page text is a derived local index read from
  the file's own bytes (§2.6), and no ink reaches it — so `Ctrl+F` still finds a
  name under a black bar on this machine. That is the honest answer rather than a
  gap: the file is never written back to, and the *export* — the thing you hand
  to somebody else — does carry the bar with no text under it. Q-279.

The **wet** stroke carries the page too (§9.1), because a folder open here may be
shut on the peer watching, and a run whose face is not the face they are looking
at has to be drawn nowhere rather than across a kraft cover.

---

## 7. Z-ordering

Fractional indexing. `item.z` is a base-62 string key; the total order is `(z, clientId, itemId)` so concurrent identical keys still sort deterministically and identically on every peer.

`bringToFront` generates a key after the current maximum. `sendToBack` generates one before the minimum.

**The known hazard is key growth.** Two clients repeatedly bringing items to front generate ever-longer keys, and a rebalance rewrites every item — a huge update that conflicts with everything in flight.

Mitigations:

- Append four random base-62 characters to every generated key. Concurrent generations then essentially never collide, and growth stays bounded in practice.
- If a rebalance is ever genuinely needed, make it an explicit user-invoked *compact layers* operation, guarded by an advisory lock, executed in one transaction, and **untracked by undo**.

Strings don't participate in item z-order — they're on two canvas layers selected by `layer`.

---

## 8. Cascades

**Every cascade runs in a single transaction, or undo is not atomic.**

**Deleting an item:**
1. Its `strokes` map goes with it (nested — automatic).
2. Delete every pin whose `parent` is this item.
3. Remove those pins' nodes from every string that references them.
4. Delete any string left with fewer than two valid nodes.

**Deleting a pin:**
1. Remove its nodes from every string.
2. Merge slack across each removal (§5.3).
3. Delete any string left with fewer than two nodes.

**`Shift+Delete` on an item:** re-parent its pins to `null`, converting their coordinates to board space, then delete only the item. Everything else survives.

### 8.1 Dangling references are tolerated, never repaired on read

A pin whose parent has vanished renders as **free-floating at its last known board position**, computed locally with no write. A string node pointing at a missing pin is skipped at render time. A string with fewer than two valid nodes is hidden.

Repairing on read causes write storms in a shared session — every client racing to fix the same inconsistency — and makes undo incoherent. Instead, a single elected client (lowest present client id) compacts a few seconds later under a maintenance origin that undo doesn't track.

---

## 9. Awareness (ephemeral state)

One state object per client, flushed at most every other frame. Never persisted; dropped on disconnect, which is correct.

```js
{
  user:      { id, name, color },
  cursor:    { x, y, tool },
  selection: { items: [...], strings: [...], pins: [...] },
  grab:      null | { kind, ids, poses: [...], seq, t, phase },
  wet:       [ { id, item, page?, tool, color, size, opacity, base, pts: [...] }, ... ],
  locks:     { segments: [...] }
}
```

**`selection` is by kind**, where earlier drafts of this section wrote a flat `[itemId, …]`. The document predates pins and strings being selectable at all (T-119, T-121), and a peer drawing what somebody else has selected needs to know *which chrome* to draw — an outline round a photograph, a highlight along a rope and a ring on a pin are three different marks, and a flat list of ids would have the receiver guessing which by looking each one up.

**`impulse` is gone.** This list carried `[ { kind, id, wx, wy, ix, iy, t } ]` for the pluck — a peer's tug on a string, sent so the other end rang too. The pluck was removed under T-148 and D-24 (accepted, Q-53): the exact chain solve made the rope four times stiffer, so the same kick bought a fifth of the swing and turned round inside one frame, which is a shimmer rather than a travelling wave. `verlet.ts`'s `nudge` was the only impulse primitive on the board and the pluck was its only caller, so there is nothing left that would produce this field.

**`cam` is gone** (T-226, Q-171). It carried `{ x, y, zoom }` every other frame on one sentence: that it lets a seeding peer push assets a collaborator is about to look at, before they ask. Nothing ever consumed it. The asset exchange is *pull-only by construction* — `exchange.ts` drops unsolicited `DATA` outright, because a peer being helpful is a peer interleaving two streams into one file — so the push path is not a reader bolted onto this field but a new direction of travel plus a relaxed receive guard on the one boundary that guard exists for. Three numbers every other frame were never the cost; a stated justification that is not true was. Putting the field back is four lines, and belongs to whatever builds the offer path.

**Panning is not a change.** With `cam` off it, nothing in this object moves when the camera does — `cursor` is in board coordinates — so a peer scrolling around a board with a still hand now publishes nothing at all.

### 9.1 Wet ink over a last-write-wins channel

Awareness has no append semantics, so naively sending the whole in-progress polyline grows without bound.

Instead send a **sliding window**: a `base` index plus the last 64 points. The receiver keeps everything it has ever seen for that stroke id and splices. This is self-healing across dropped updates as long as the window covers the gap — 64 points at 30 Hz is about two seconds — and the payload is constant-size.

Points are decimated to roughly one per six screen pixels before sending. The remote render is a preview, not an archive; the real stroke arrives on commit.

**`page` is optional and absent when there is none** (T-278) — the one field here that is not always sent, because nearly every stroke anybody draws is on no page at all and this is four characters of JSON thirty times a second that would say nothing. It is on the wire for the same reason `item` is: without it the receiver cannot know which surface to draw the ghost on. A folder open on the sender's board may be shut on the receiver's, or open at a different page, and a run whose face is not the face they are looking at is drawn *nowhere* rather than across a kraft cover. A `page` that is present and not a positive integer drops the whole run rather than falling back to the object — unlike a bad colour there is no nearly-right answer, because the two candidates are different surfaces.

### 9.2 The handoff race

`wet` clearing (awareness) and the committed stroke arriving (document) land in arbitrary order.

**Rule: keep rendering the ghost, keyed by stroke id, until the document contains that stroke id.** Correct in both orderings — no flash, no double-draw.

The same rule applies to drags: hold the awareness pose until the document position matches within epsilon, or a 250 ms grace period expires.

### 9.3 Remote motion smoothing

Buffer `(pose, remoteTime, localReceiveTime)` samples and render at `now − 100 ms`, interpolating between the two straddling samples. Extrapolate at most 80 ms across a gap, then freeze. This turns a 20 Hz update stream into 60 fps motion.

**The interpolated pose — not the raw sample — drives the rope anchor.** Feed raw samples in and the rope visibly jitters at the update rate. Velocity for the swing comes from the derivative of the interpolation, so velocity is never transmitted.

### 9.4 What never goes on awareness

Anything durable. Awareness is dropped on disconnect by design, so anything that must survive a reconnect belongs in the document.

---

## 10. Assets

```js
assets: {
  [sha256]: Y.Map { w, h, mime, size, origName, addedBy, addedAt, duration?, pages? }
}
```

**Metadata only. Bytes never enter the document.**

Because the measurements are here, an item renders at its correct size — frame, caption, tape, pins, shadow — from the instant it exists. Nothing reflows when the bytes arrive. *Which* measurement does that work depends on what the file is: a photograph's size is `w`/`h`, and a cassette has no pixel box at all — the object on the wall is a cassette, and what its J-card needs from this record is `duration`. So `readAsset` requires a box only of the kinds that are supposed to have one, and a boxless record that is not a photograph is a usable record rather than an absent one.

`duration` (seconds — a film or a cassette) and `pages` (a document) are written **only when the machine that ingested the file could measure one**. `pages` is *measured* for a PDF, which states its own pagination, and *derived* for a document that states none — a text file is paginated onto a fixed grid of characters by a rule that reads nothing but the bytes (T-298, `src-tauri/src/text.rs`). That rule is deliberately blind to the typeface, the sheet and the item scale: this number crosses the wire ahead of the file, a peer draws the folder's thickness from it without ever holding the bytes, and every page reference a quote will one day carry is a place in the pagination. A page number that moved with a design value would silently rewrite stored citations, so the pagination is a function of the file for the same reason the hash is. An absent key and a key holding `null` read identically, so nothing writes the null: a photograph costs no bytes on the wire to say it has no running time, and a later build that learns to measure something this one could not fills the key in without touching anything beside it, because `Y.Map` is per-property LWW. A stored zero reads back as nothing, deliberately — a J-card reading `0:00` claims the tape is empty, which is worse than saying nothing.

**There is no `kind` key.** Which of the objects a record becomes — photograph, case file, tape, cassette, or none of them — is derived from `mime` on read and never stored. Every record already on every board was written before any of this existed, so a record without a kind has to be classifiable anyway; storing one as well would be a second statement of a fact the mime already makes, and two writers of one fact can disagree where a derivation cannot. The cost, stated plainly: a mime this build has never heard of is unfamiliar here permanently, and a later peer knowing what it is buys this one nothing.

Local per-asset state, **never** in the document:

```
unknown → requesting → transferring(pct) → ready | unavailable
```

And so is **what a case file says**. Page text, transcripts and any other
extracted content are a derived local index (D-46 section 2) — it is bytes, and
§2.6 of DESIGN settled where bytes go. `app/textindex.ts` holds one entry per
document hash, in memory, built by reading the file this machine already has:
never written down, never on the wire, and thrown away with the window. A
machine holding none of the bytes has no index, which is the intended state and
not a degraded one — it is the same machine that cannot show you the
photographs. Content addressing is what makes that safe rather than fragile: an
entry keyed on a hash stays true for as long as that hash exists, so losing all
of it costs time and nothing else.

Measured, because the boot cost is the whole of the choice (Q-271): a real
multi-page PDF is about 8.5 ms to open and 11 ms a page to take the text off, so
a case file is roughly 215 ms of background work and a 100-page one is five
seconds. It is read when the folder appears rather than when somebody first
searches, one document at a time.

Garbage collection refcounts from `assets` union the set of referenced `item.assetId`s, keeps a 30-day trash tier, and never collects on a peer that may be the only holder without first confirming another peer has it.

---

## 11. Undo

```js
new Y.UndoManager(
  [items, pins, strings, boardInk],
  { trackedOrigins: new Set([LOCAL_USER, DRAG_THROTTLE, INK_COMMIT]),
    captureTimeout: 400 }
)
```

`UndoManager` tracks only the `null` origin by default, so **every origin must be registered explicitly** — forgetting this silently produces an undo stack that ignores most of the application.

| Origin | Tracked | Notes |
|---|---|---|
| `LOCAL_USER` | yes | All direct user edits |
| `DRAG_THROTTLE` | yes | Crash-safety writes during a drag; merged into the same entry by `captureTimeout` |
| `INK_COMMIT` | yes | One stroke, one entry |
| remote | no | Not local, by definition |
| `MIGRATION`, `JANITOR`, `ASSET_GC` | no | Maintenance must be invisible to undo |
| physics | — | **Does not exist.** Physics never writes. |

**Undo is origin-scoped**, so it reverts your operations rather than the last thing that happened. It can still surprise — if someone moved an item after you did, your undo restores your prior value and their move is lost. Flash-highlight affected items on undo so this is never silent.

Call `stopCapturing()` on pointer-up, tool change and selection change. Explicit boundaries beat time-based grouping.

**Camera and selection** aren't in the document, but are stashed in each undo entry's metadata and restored on the way back, so undo returns you to where you were.

Cap the stack at around 200 entries.

---

## 12. Persistence and migration

**On disk:** an append-only log of opaque document updates plus a periodic snapshot. Compaction writes a fresh snapshot and truncates the log.

**Bundle format** — `.schizo`, a zip containing:

```
manifest.json      schemaVersion, title, asset list
snapshot.bin       document state
assets/<sha256>    the bytes
```

**Export always embeds assets.** A board you hand to someone is never half a board.

**Migration** is driven by `meta.schemaVersion`, run under a maintenance origin that undo doesn't track, by the first client to open a document at a lower version, guarded by an advisory lock so ten simultaneous joiners don't all migrate at once.

**Prefer additive migrations.** In a CRDT, destructive migrations are genuinely dangerous: an old client that reconnects can resurrect the old shape, and the merge will accept it.

### 12.1 A document from a *higher* version opens read-only

The paragraph above is about a document older than the build reading it. The other direction had no rule at all and needed one, because it fails silently in both halves (T-224, Q-170).

**What a future document does today.** An item whose `type` this build does not know reads as null and is skipped by the binding, so it is *invisible while remaining perfectly intact* — nothing deletes it on read (§8.1) and compaction re-emits it verbatim. That is the tolerant behaviour §8.1 asks for, and on its own it is fine. What is not fine is that `referencedAssets` builds the asset keep-set through the same reader: a future item's photograph is in no keep-set, so the collector (§10) is free to reclaim its bytes. Open a version-2 board on a version-1 build, wait for the sweep, and the pictures can go for good with the items still pointing at them.

**The rule.** When `meta.schemaVersion` is higher than the build's, the document is **sealed**: it opens, it renders, it keeps syncing and it keeps being written to disk, and *this build never writes to it*. The seal is one check in `mutate`, so every op is downstream of it; the routes above — gestures, keys, menus, paste, the clipboard's cut, undo, the janitor and the asset sweep — are closed separately so that a board you may not edit looks like one rather than like one that has stopped responding. Reaching the seal is a bug, so it throws rather than declining quietly.

**A peer can seal a board mid-session**, by raising `meta.schemaVersion` on a document already open here. It is watched, not merely checked at boot.

**Additive migration is still the policy**, which is what makes this the conservative answer rather than the obvious one: a version-2 board is usually perfectly editable by a version-1 build. It is refused anyway because editing around an item you cannot see is a mistake nothing announces — not to the person making it, and not to the person whose item it was.

**A bundle carries the same version and is refused the same way.** Rust deliberately does not judge `manifest.schemaVersion` (`bundle.rs`), on the grounds that migration is the frontend's; the frontend now reads it before `replaceWith`, because past that line the board being replaced is already gone.

---

## 13. Invariants

The fuzz harness (Risk 3 in `DESIGN.md`) runs two documents through randomised concurrent operation sequences and asserts all of these after every merge:

1. No numeric field is ever `NaN` or infinite.
2. Every `slackAfter` is greater than zero.
3. No string survives with fewer than two valid nodes.
4. Every node's `pin` either resolves or is skipped cleanly at render.
5. Every pin's `parent` either resolves or the pin renders free-floating.
6. Merging never produces an item with zero or negative dimensions.
7. A stroke's `bbox` always contains its unpacked points.
8. Cascades leave no orphaned strokes.
9. Every `z` key is a valid fractional index and the total order is identical on both documents.
10. A stroke's `page`, when it has one, is a positive integer — and a stroke on board ink never has one.
