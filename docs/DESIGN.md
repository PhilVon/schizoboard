# Schizoboard — Design Document

**Status:** draft · **Version:** 0.1 · **Audience:** whoever builds this

> A board. Some photographs. Notes in a hand that got shakier as the night went on. And red string, going everywhere, because that's the part where you finally see it.

---

## Table of contents

1. [Vision & non-goals](#1-vision--non-goals)
2. [The board model](#2-the-board-model)
3. [Interaction specification](#3-interaction-specification)
4. [Art direction](#4-art-direction)
5. [Physics](#5-physics)
6. [Rendering architecture](#6-rendering-architecture)
7. [Data model & collaboration](#7-data-model--collaboration)
8. [Application architecture](#8-application-architecture)
9. [Performance plan](#9-performance-plan)
10. [Roadmap](#10-roadmap)
11. [Risks & open questions](#11-risks--open-questions)

Companion documents: [`DATA-MODEL.md`](./DATA-MODEL.md) (the schema contract) and [`ARCHITECTURE.md`](./ARCHITECTURE.md) (module boundaries and protocols).

---

## 1. Vision & non-goals

### 1.1 What it is

Schizoboard is an infinite corkboard for organising information that hasn't decided what shape it is yet.

You know the board. It's in every conspiracy film: a wall of photographs and clippings and index cards, half of them annotated in marker, all of it connected by red string that someone ran between pushpins at three in the morning. It's a genuinely good thinking tool, and it survives in fiction because it works — it lets you hold a mess in your hands, move it around, and find the shape by feel rather than by deciding the structure up front.

Every digital tool that gestures at this idea sands it down. Mind-mappers force a tree. Whiteboards give you rectangles and arrows. Note apps give you a list. All of them ask you to know the structure before you have it. The corkboard doesn't: you pin things up, you look at them, and the connections come later.

Schizoboard is that board, rendered with enough physical fidelity that it feels like a place rather than a diagram. Photographs arrive as polaroids. Text arrives on paper. You can scribble on any of it with a marker. And the string sags, and swings when you move a photo, because the moment it stops behaving like string it becomes an arrow and the whole thing collapses back into a flowchart.

### 1.2 Who it's for

People holding more threads than working memory allows:

- Investigative and long-form journalists mapping people, events and money.
- Researchers assembling a literature review or an argument before it has an outline.
- Writers working out a plot or a character web.
- Anyone doing a genealogy, an incident post-mortem, a competitive landscape, or a case file.

The common thread is that the *relationships* matter more than the items, and the structure is discovered rather than known.

### 1.3 The design pillars

Four commitments. Everything in this document is downstream of these.

**Physical, not skeuomorphic.** The difference matters. Skeuomorphic means drawing a leather texture on a calendar. Physical means the string sags, the photo swings on its pin, and the paper is lit from the same direction as everything else. We're not decorating a diagram; we're simulating a small volume of the world with two-and-a-bit dimensions.

**The string is the product.** It's the thing the name is about. Everything else — items, pins, ink — is in service of getting string between things. It gets more design attention, more interaction surface and more simulation budget than anything else, and §3.4 specifies its behaviour exhaustively rather than gesturing at it.

**Nothing blocks thinking.** Paste and it appears. Drag and it moves. No dialogs, no "choose a type", no naming things before you have them. The tool should never make you stop and answer a question. A photo whose file hasn't finished transferring is still fully usable — you can pin it, string it and annotate it before you can see it.

**Mess is a feature.** Items sit at slight angles. Nothing snaps to a grid. There's no auto-layout and there will never be a "tidy up" button. A board that looks organised is a board that has stopped being useful for the thing this tool is for.

### 1.4 Non-goals

Stated plainly, because each is a thing someone will eventually ask for and the answer is no.

| Not | Because |
|---|---|
| A whiteboard | No shape libraries, no connectors, no sticky-note grid. Miro exists. |
| A mind-mapper | No enforced hierarchy, no auto-layout, no radial expansion. The structure is the user's to discover. |
| A project tracker | No status, no assignees, no due dates, no columns. |
| A presentation tool | Boards are for thinking in, not for showing. Export exists for taking a picture of your thinking; it is not a slide deck. |
| A document editor | Note text is short-form. No tables, no headings, no styles beyond a handful of paper and pen choices. |
| A web app | It's a desktop app. This buys the filesystem, the native clipboard, real image decoding and LAN peer discovery — see §8. |
| An alignment tool | No axis lock, no rotation steps, no aspect-ratio lock, no snapping, no guides — "mess is a feature" (§1.3), and the only thing any of them is ever used for is lining things up. The single `Ctrl`+drag on the board keeps a pin in its item (§3.3); it does not constrain a direction. |
| Infinitely scalable | Designed for boards of hundreds to a few thousand items. A board with 50,000 items is a database, and you should use one. |

### 1.5 The test

Every feature proposal gets asked: *does this help someone find a connection they didn't already know about?* Pinning, stringing, moving things next to each other and drawing on them all pass. Tagging, filtering, search-and-hide and auto-arrange mostly don't — they help you *retrieve* what you already know is there, which is a different tool.

Search exists, but as a way to fly the camera to something, never as a way to filter the board down. You must always be looking at the whole mess.

---

## 2. The board model

Five kinds of thing. That's the whole model.

```
Board
├── Items      — the things on the board (photos, notes, scraps)
├── Pins       — what holds items to the board, and what string attaches to
├── Strings    — ordered runs of pins, simulated as rope
├── Ink        — strokes, belonging either to an item or to the cork
└── Assets     — image bytes, referenced by hash, never inline
```

### 2.1 Items

An item is a physical object lying on the board. Three archetypes, sharing one structure:

| Archetype | Created by | Looks like |
|---|---|---|
| **Polaroid** | Pasting or dropping an image | White frame, thick bottom border, handwritten caption area |
| **Note** | Pasting text | Lined or plain paper, handwritten face, ragged or torn edge |
| **Scrap** | The note tool with no text | Blank paper. Exists purely to be drawn on |

They differ only in styling and defaults. Every archetype can hold text, can hold ink, can hold an image, and can be pinned. A scrap is not a special type in the code — it's a note that happens to have no text yet, which is exactly what a blank piece of paper is.

**There was a fourth row here, and it was struck on Q-179.** *Card — explicit creation — index card, ruled, slightly stiffer paper.* An index card is a **stock**, not an archetype: everything you can see about one comes from `paperStock: "index"` — the 20px ruling, the red margin, the die-cut edge at a third of a unit of rag, the colour — and every sheet on this board already offers that stock on the Paper strip of its right-click menu. What the `card` *type* bought on top of that was one line of code choosing that stock by default, which is not an archetype's worth of difference. It followed the scrap the paragraph above describes, and for the same reason.

`card` stays in the schema's type union, and that is not an oversight. `readItem` rejects a type it does not know, so striking it would make a board that holds one lose the item rather than keep a sheet of paper — and a board somewhere does hold one. It renders as index stock, it cannot be made, and nothing in this document promises it.

Items have a position, a rotation, an intrinsic size, and a z-order. They do **not** have a parent, a group, or a container. There is no nesting. Things are next to each other or they aren't.

### 2.2 Pins — the primitive

**This is the load-bearing idea of the whole design.** Nearly everything in the brief resolves through it.

A pin is a small object pushed into the board. It is in exactly one of two states:

- **Parented** to an item, storing its position in that item's *local, un-rotated* coordinate space. It travels and rotates with the item automatically, with no bookkeeping.
- **Free**, pushed straight into the cork, storing board coordinates.

Re-parenting — the thing you do when you drag a pin off the cork and onto a photograph — is a two-field write: set `parent`, convert the coordinates into the new frame. **That two-field write is the entire "drag a pin onto a note" feature.** It falls out of the representation rather than needing a mechanism.

Three consequences worth stating separately:

**Strings attach to pins, never to items.** So pin-to-pin works, multi-pin runs work, and a pin hosting six different strings works — all with no special cases, because a string just holds pin ids and a pin doesn't know or care how many strings reference it.

**Pin count is the item's physics.** Zero pins and the item lies loose on the cork. One pin and it hangs, swinging gently on a torsion spring and settling to equilibrium. Two or more and it's rigid. The user never sets a physics mode; they add and remove pins, and the behaviour follows. This turns "items get one pin by default, add and remove as you see fit" from bookkeeping into something you can feel.

**Tape is the exception, and it is the exception because it is not pushed into the board** (Q-286). A quote card's thread is *taped* to the page it came out of rather than pinned through it — you cannot push a pin through a sheet that is lying inside a folder, and the thing that actually holds a thread to paper is tape. It is a `kind` of pin in the schema, because everything else about it is a pin: a string runs to it, it drags, it cuts, and §3.4's grammar applies unchanged. What it does not do is hold the paper up, so it is not counted here. Without that exception a folder you quote from stops hanging the moment the card arrives, and an open one leaps across the board as its turn pivot changes under it.

**And that count is geometric, not parental.** A pin holds every item it is actually stuck through, whoever's frame its coordinates are stored in — so a photograph dragged over a pin in the bare cork hangs from it, and a pin in the overlap of two items holds both. The two states above are about the *frame*: `parent` says whose local space the pin's numbers are in, and therefore what the pin travels with, and it stays singular for exactly the reason this section gives. What it never was is the answer to "what does this pin hold", which is a question about where the pin *is*. Before the two were separated an item with a pin plainly sitting on it lay flat, because the pin named something else.

A pin therefore belongs to one frame and holds however many items it is pushed through. **And the frame it belongs to is the topmost item it is stuck through** — so slide the top photograph a little way and the pin goes with it, leaving the paper underneath behind. That is what a pin through two sheets does: it is in the one nearest you, and moving that one takes it along.

Which means `parent` stops being something the user sets and becomes something geometry decides. The two states above are untouched — a pin is still in exactly one frame, and the re-parent is still the same two-field write — but nobody has to perform it any more. Drag an item until a pin in the cork ends up inside it and the pin has been adopted; drag the item off again and the pin is handed back to whatever is still underneath, or to the cork. The rule is the same one the eye uses, so it never has to be explained: the pin belongs to the paper you can see it in.

Three things make that safe to do automatically rather than merely tempting. It is decided by the **same order the renderer paints in**, so the answer can never disagree with the picture. It is a change of frame and not of position — the pin's board coordinates are identical either side of it, so nothing moves on the frame it fires. And it happens on the **release**, on the machine whose gesture caused it, inside the same undo entry as the move that caused it: one `Ctrl+Z` puts back the pose and the frame together. A pin whose home is decided by where things are must not become a pin that argues with a collaborator about it, so the peer who moved something decides and everyone else takes the answer off the wire.

**Pins outlive items.** `Shift+Delete` removes an item but leaves its pins free-floating in the cork, so the web of string survives with a hole in it. Evidence removed, thread remains. Nearly free to implement, because it's just a re-parent to `null`.

### 2.3 Strings

A string is an **ordered run of pins** — two or more — plus how much slack to leave in each gap.

```
string:  [ pin A ]──segment──[ pin B ]──segment──[ pin C ]
              slackAfter        slackAfter
```

Each segment simulates as an independent rope pinned at both ends. That gives multi-pin runs for free, keeps the solver simple, and means moving one pin only wakes the two segments adjacent to it.

Slack is a **ratio**, not a length: `restLength = chord × (1 + slackAfter)`. Scale-invariant, and it makes inserting a pin mid-string produce no visible jump in sag — see §3.4 and §5.4, since getting that wrong is the single most likely way to make this feature feel broken.

Each string has a `layer`: `over` or `under`. Real boards have both — string you ran and string that a later photograph got pinned on top of. See §6.2.

### 2.4 Ink

A stroke belongs to whatever it is over:

- Over an item → that piece lives on that item, in **item-local coordinates**. It's drawn into the item's own canvas, inside the item's transform, so it rotates and moves with the item automatically. Draw a circle around a face and it stays around that face forever.
- Over the cork → that piece lives on the board.

That single rule makes "ink travels with the photo" free rather than a feature.

**A line that runs off the paper is broken at the edge**, and each piece is glued to what it is actually over — one gesture, several stroke records, one undo entry. The crossing point belongs to both pieces so the marks meet rather than leaving a gap. It is what a real pen does on a real board: drag the photograph afterwards and its half of the line goes with it while the cork's half stays put.

Holding `Ctrl` as you start forces board space **for the whole gesture** and there is no hand-over, which is how you draw an arrow across two photographs — or mark the cork behind one.

Two pens plus erasers:

- **Marker** — opaque, pressure and velocity varying width, slight taper.
- **Highlighter** — translucent, drawn with `multiply` blending, flat cap, near-constant width. Overlapping passes of the same colour must not compound into black, which requires drawing each stroke to its own buffer and compositing once (§6.5).
- **Eraser** — deletes whole strokes by default. A `Shift+E` smudge eraser paints a `destination-out` stroke for partial rubbing-out.

### 2.5 Coordinate spaces

Three, and confusing them is the most likely source of bugs, so they get names.

| Space | Units | Used for |
|---|---|---|
| **Board** | Board units (1 = 1 px at 100% zoom) | Item positions, free pins, board ink, rope particles |
| **Item-local** | Item units, origin at item centre, **un-rotated** | Parented pins, item ink |
| **Screen** | CSS pixels | Pointer input, rope canvas drawing, all UI |

The un-rotated part of item-local is what makes pins and ink survive rotation for free. Rope particles simulate in board space and are transformed to screen space at draw time, so line widths stay crisp at every zoom without scaling (§6.4).

### 2.6 Assets

Image bytes are **never** in the document. Images are hashed with SHA-256, stored once in a content-addressed store, and referenced by hash. Pasting the same photograph twice costs nothing the second time.

The document holds `{sha256, w, h, mime, size}` — and because the dimensions are in the document, an item renders at its correct size, with its frame, caption, tape, pins and shadow, from the instant it exists. Nothing reflows when the bytes arrive. See §7.5.

---

## 3. Interaction specification

Every interaction below states its input, its result, and its undo. Where undo says "standard", it means the action is a single tracked transaction that undoes atomically.

### 3.1 Getting things onto the board

**Paste is the primary verb.** `Ctrl+V` and the board figures it out:

| Clipboard holds | Result |
|---|---|
| Image bytes | Polaroid at the paste point, at natural aspect ratio, capped to a comfortable size |
| Plain text | Note, sized to the text, up to a max width then wrapping |
| A URL | Note showing the URL; if it's an image URL, fetched natively (no CORS wall) and made a polaroid |
| HTML with an `<img>` | The image is fetched and made a polaroid; this is what "copy image from a web page" actually puts on the clipboard, and handling it is not optional |
| File paths (Explorer/Finder copy) | Each image file becomes a polaroid; handled natively, since the web clipboard event can't see these |
| Multiple images | A loose fan at the paste point, slightly overlapping, each at its own angle — not a grid |
| A piece of this board | The paper itself — seeds, style, pins, ink and the strings between them (§3.9's `Ctrl+C`) |

The last row is a different kind of clipboard and is the reason `Ctrl+C` needs saying at all: copying two notes and pasting them gives you two more notes rather than the sentences they had on them, and the strings between what you copied come with it. It arrives held, so putting it down and moving it is one gesture in two halves. `Ctrl+D` is the same thing with no clipboard in between — a copy down and to the right of the original, which is where a second sheet on a pile would sit. Which of the two clipboards a `Ctrl+V` means is decided by whichever was copied to last, and ARCHITECTURE §4.5 is how.

Paste point is the cursor if it's over the board, otherwise the viewport centre. Dragging files in from the OS behaves identically. Undo: standard, one entry for the whole paste even when it creates twenty items.

Everything created this way gets **one pin**, placed at the top centre, and a small random rotation — between about −4° and +4°, seeded per item so it's stable. Nothing arrives straight.

### 3.2 Moving things

Drag an item to move it. Drag its rotation handle, or hold `R` and drag, to rotate. There is no resize handle on a polaroid — a photograph is the size it is — but every sheet of paper resizes from its edges.

Nothing snaps to anything. There is no grid, no alignment guide, no distribution tool. This is deliberate and it is not a missing feature.

**And no held-modifier constraints.** No modifier holds a drag to an axis, a rotation to fixed steps, or a resize to its aspect ratio. All three are the same request — make my hand tidier than it is — and the answer to all three is the one above. The only `Ctrl`+drag on the board is the pin one in §3.3, which keeps a pin in the item it is already in and has nothing to do with alignment. See §1.4.

While an item is dragged, its shadow lifts and softens, it scales up by about 2%, and it gains a slight lag-and-catch-up rotation in the direction of travel — the item is being *carried*, not teleported. On release it settles. If it has exactly one pin, it swings (§5.5).

Undo: standard, with the whole drag as one entry.

### 3.3 Pins

| Action | Input | Result |
|---|---|---|
| Pin tool | `P` | Next click places a pin |
| Place on an item | Click an item with the pin tool | Parented pin at the click point |
| Place on cork | Click empty cork with the pin tool | Free-floating pin |
| Add without switching tools | Item context menu → *Add pin* | Pin at the click point |
| Move a pin | Drag it | Follows the cursor; candidate items highlight with a ring |
| Re-parent | Drop it over an item | Parents to that item; travels with it from now on |
| Un-parent | Drag it off onto cork | Becomes free-floating |
| Constrain | Hold `Ctrl` while dragging | Stays within the current parent; no re-parenting |
| Remove | `Alt`+click, or context menu | Strings through it heal (§3.4) |
| See its threads | Hover | Every string through the pin highlights |
| Follow the thread | Double-click | Selects the entire connected component of pins, strings and items |

Removing the last pin from an item is legal — it lies flat on the cork. Real boards have loose photographs.

Undo: standard. Re-parenting is one entry. Pin removal is one entry including the string healing.

### 3.4 String — the full grammar

This is the feature the product is named for, so it gets specified completely.

**Making string**

| Action | Input | Result |
|---|---|---|
| String tool | `S` | Enters stringing mode |
| Basic run | Click pin A, click pin B | String joining them |
| Extend | Keep clicking pins | Each click appends a node to the run |
| Finish | `Enter`, `Esc`, or double-click | Ends the run |
| **To a bare item** | Click an *item* rather than a pin while stringing | A pin is created there automatically and the run continues |
| To bare cork | Click empty cork while stringing | A free pin is pushed in and the run continues |
| Close a loop | `Shift`+click the first node | Loops the run back; the last node's slack becomes the wrap segment |
| Quick pull | `Alt`+drag from a pin, in any tool | Pulls a new string out without switching tools |

The "click an item and it makes its own pin" path is the fast path and it must exist. In practice most stringing is *this photo to that note*, and making the user place a pin first would double the interaction cost of the primary verb. Pins show a small eyelet highlight on hover so the pin-precise path stays discoverable.

**Inserting a pin mid-string — the headline gesture**

1. Hover a string. The nearest point on the rope highlights, tracking your cursor along the curve.
2. **Drag.** A new pin is born at that point on the string, free-floating, and follows your cursor. The string now runs *through* it — you're physically pulling a loop of string out to a new position.
3. Drop it on a photo or note → it parents to that item and travels with it from then on.
4. Drop it on bare cork → it stays free, pushed into the board.
5. `Esc` mid-drag → the whole thing reverts, string unchanged.

A plain click without dragging selects the string instead.

The critical detail: when the string splits at that point, **the slack must split proportionally** so the two new segments together sag exactly as the original did. Get this wrong and the string visibly jumps at the moment of insertion, which reads unmistakably as a bug. See §5.4.

**Editing string**

| Action | Input | Result |
|---|---|---|
| Adjust one segment | Wheel over a selected segment | Slack up or down; the sag responds live |
| Adjust the whole string | `Alt`+wheel | All segments together |
| Slack presets | `1`–`9` with a string selected | Taut through to heavily draped |
| Toggle taut | Double-click a segment | Snaps between taut and default slack |
| Tuck behind | Context menu → *Tuck behind* | Flips `layer`; the string now runs behind items instead of over them |
| Restyle | Context menu | Colour (red is default — also blue, green, yellow, black, white), thickness, material (string / yarn / wire) |
| Cut | `Ctrl`+`Alt`+click a string, **in any tool** — the scissors — or context menu → *Delete* | String removed; its pins stay where they are |

**There is no pluck.** This table used to carry one — click and release on a
taut string and a travelling wave ran down it, "purely for joy" — and it was
built, shipped and then removed. D-24 is the decision record; the short version
is that solving the rope exactly (D-23, T-147) put the tension up to what the
analysis says it should be, and a transverse wave travels at the root of
tension. The same kick then bought a fifth of the swing and turned it round
inside a single frame, so what a 60 Hz display showed was not a string ringing
but noise. The kick can be made harder; it cannot be made slower without making
the rope wrong again, and a correct rope was worth more than the gesture.

**Removing a pin from a string.** A pin in the middle of a run: the two neighbouring segments merge into one, with the slack summed so the total sag is preserved. A pin at either end: that node is dropped. A string left with fewer than two nodes deletes itself. All of it is one undo entry.

Undo: every string operation is standard and atomic, including the cascades.

### 3.5 Drawing

| Tool | Key | Behaviour |
|---|---|---|
| Marker | `M` | Opaque, width varies with pressure (pen) or velocity (mouse) |
| Highlighter | `H` | Translucent multiply, flat cap, near-constant width |
| Eraser | `E` | Deletes whole strokes under the cursor |
| Smudge eraser | `Shift+E` | Partial rub-out |

Colours live in a small palette per tool — marker in black, red, blue, green; highlighter in yellow, pink, green, blue. Size is `[` and `]`.

The rule from §2.4 applies: **a stroke belongs to whatever it is over.** Draw on a photo and it's the photo's ink; run off the edge and the part on the cork is the board's, as one gesture broken at the edge into several records and one undo entry. `Ctrl` at pen-down forces board space for the whole gesture and turns the hand-over off.

Ink appears with essentially no perceptible latency, because the in-progress stroke is drawn on a dedicated overlay at screen resolution while the committed strokes sit undisturbed underneath (§6.5).

Undo: one *gesture*, one entry — including the several records a stroke that crossed an edge becomes. Erasing a stroke is one entry.

### 3.6 Text

Click into a note or a polaroid's caption area to edit. Type. Click away.

**The note un-rotates to 0° while you edit** — animated over about 120 ms — and rotates back on blur. This is not a stylistic choice: caret placement, text selection and IME composition all misbehave inside a CSS-rotated element, across every engine. It also reads correctly as picking something up to write on it.

Text renders in a handwritten face by default, with slight per-character baseline and rotation jitter so it doesn't look typeset. Jitter is seeded per character index so it's stable across re-renders — text that shimmers when you scroll past is worse than no jitter at all. A clean typeface is available per item for anyone pasting something they actually need to read.

**The jitter is a drift, not noise.** Building it as an independent value per character is the obvious reading of the paragraph above and it does not work: at an amplitude small enough to look natural it is invisible, and at any amplitude you can see it reads as a ransom note, because the eye is not looking for movement but for a letter that has moved away from *both* its neighbours. So most of the amplitude is a slow wander — letters move together over about four characters — and only a letter's slant varies on its own, that being the part of a real hand which genuinely does. The two were rendered side by side on the same note before this was written (T-81).

Undo: text edits are character-level and merge into sensible entries by typing pause.

### 3.7 Navigation

| Action | Input |
|---|---|
| Pan | Space+drag, middle-drag, or two-finger scroll |
| Zoom | Wheel (at cursor), pinch, `Ctrl+=` / `Ctrl+-` |
| Fit board | `Ctrl+0` |
| Actual size | `Ctrl+1` |
| Frame selection | `F` |
| Search | `Ctrl+F` — flies the camera to a match, and inside a case file opens it at the page. **Never filters or hides.** |
| Next / previous match | `Enter` / `Shift+Enter` while the field is open |
| Close the search | `Escape` |
| Open a case file | `Enter` on a selection of exactly one, or the item menu's *Open* — flies the camera the way search does |
| Play a cassette | The same `Enter`, the same *Open* — but nothing opens, nothing is covered and the camera does not move. Again to stop |
| Shut it | `Escape`, or `Enter` again. **Selecting something else does not** — an open document is worked *against*, so a click on the board must not shut it |
| Turn a page | `←` / `→` while a case file is open, **in any tool** — including with a pen or a rubber in hand, because redacting page four of a fifty-page filing must not be four keystrokes a page (T-278). Refused while a pointer is down, since a mark's page is fixed at the press. Clamped at both ends rather than wrapping, and the header says which page you are on out of how many — the pair a citation carries. Where you have got to is **local**: it never enters the document and never reaches a peer, for the reason a playhead does not. The set uses the same two keys to step a tape and they do not collide — it is the one modal on this board and takes its keys before anything else sees them, so only one of the two can ever be up |
| Watch a tape | `Enter` on a video puts it on the set instead: `Space` plays, `←` / `→` step 5s, with `Shift` 30s. `Escape` shuts it. **Nothing else reaches the board while it is on** — including `Ctrl+X`, `Ctrl+C`, `Ctrl+V` and a file dragged in from the OS, none of which is a keydown by the time it arrives, and all of which used to (T-324) |

Zoom range is **15% to 400%**. The board is unbounded in every direction.

**A thousand-page filing is three pages of memory** (T-279, Q-276). One sheet is drawn however long the document is, and the reader holds the page you are on and the one either side — the culling rule the board already runs, one level down: keep what is near, let go of the rest. It **fetches** those neighbours rather than merely keeping them, which is a page ahead of what anybody asked to see. That is not for the speed, which was never a problem — a cold page is 6 to 11 ms, under a frame either way — but so that a turn never passes through the state where the sheet is blank and its header says how thick the folder is instead of which page you are on. What it is for is the memory: before the window, reading a 200-page scan end to end held all 199 pages and 77 MiB of lifted JPEG to draw one of them, and a thousand-page one — a court record rather than an edge case — would have held 388 MiB.

**A picture on a typed page comes with it** (T-329, Q-203, Q-289). A report's chart is not chrome and dropping it left the reader the caption and a blank space, so a figure is lifted with the page and drawn on the sheet. It is **re-flowed with the text rather than pinned to its box on the original page**: the lines have been re-set (D-46 §4), so a figure holding the PDF's geometry would be the one thing on that sheet still claiming it, and it would come down on top of lines that have moved out from under it. So it goes where it was in the *reading* — after the last line above it, before the first below — which keeps a caption with its figure and never hides a word. It is as wide a share of the sheet's measure as it was of the page's, and it keeps its own proportions. A figure this build cannot lift **holds its place and says why**, the same rule a page that cannot be read already follows, and for the same reason: a blank space where an exhibit was is the failure the whole arrangement exists to stop.

**And the tape a quote hangs from belongs to the page, not to the folder** (T-330, Q-291). A quote card's thread is *taped* to the sheet it came out of rather than pinned through it (§2.2), and tape on page four of a filing is inside the folder when it shuts and under the sheet on show when you have turned past it. The same second answer a mark needed, asked of a pin, and it produces two rules and not three states: a **tape** is drawn, exported and grabbable only while its page is the page on show — a shut folder shows no page, so no page it holds is on show, and "shut" needs no case of its own — and the **gap of a thread that ends at a put-away tape** is drawn on the `under` layer whatever §6.2 says about the rest of its string.

That second rule is the whole of the request and the cheap reading is wrong. Not drawing the tape's thread would leave a card on the cork joined to nothing; what actually happens to a thread taped inside a folder is that it *goes under the folder*, so the card is still visibly threaded to where it came from and the string disappears into the thing it came out of. And it is the **gap** rather than the string, because a thread with a pin pulled out of the middle of it (§3.4) has a half that never went near the folder — tucking that too would hide it behind every note between the folder and the card. It is the first thing on this board that is true of one gap of a run rather than of a whole one.

The three ways the answer changes — the folder opens, the folder shuts, the reader turns — are **none of them document edits**, so the two layers that draw off it have to be woken by something other than a write. That is the same argument the redaction above already makes about its bitmap, one layer down the stack.

**Marker on an open page is redaction** (T-278). Nothing new is held: ink already
belongs to whatever it is over, in that thing's local space, so a black bar over
a name travels with the document, survives shutting the folder, and comes back
when you turn to that page again. The one addition is that a stroke records which
page it was on — a case file is the only object on this board with two faces, and
"where is this mark" needs a second answer only for it. A shut folder shows what
was drawn on its kraft, an open one shows the page, and a photograph shows
everything, all through one sentence rather than three special cases. The pen and
the rubber follow the page as it turns, and the writable paper is the A4 sheet
standing in the folder rather than the kraft around it.

**It is a mark rather than an edit** (Q-279), and both halves of that are
deliberate. We never write back to the file (§1.4), so the words under the bar
are still in the file and still in the local page index — `Ctrl+F` will find a
redacted name on your own machine and open the folder at the page you covered it
on. What *is* redacted is the thing you hand to somebody else: ink is drawn into
an image or PDF export, and an open case file exports with its page showing, so
the bar is on the artifact and there is no text under it. A board that quietly
edited the evidence to make its own search agree would be the worse of the two.

**The one modal, and why a tape gets it when a document does not** (T-276, Q-197). A film covers the screen. Nothing else in this application ever has — every other surface is a corner-anchored strip that takes no press it did not ask for — and the exception is not a concession to how video is usually shown. It is the line the two activities were always on either side of. Reading is done *against* the wall: you pull a quote out onto the board and look back at the page, so a document that covered the board would break the loop it exists for. Watching is linear, full-attention and done once, and there is nothing to look back at — a board visible behind a film is a board you are not using, and a stylised CRT is the picture that says which of the two you are doing.

What comes with taking the screen, stated because a modal is where every one of these is usually got wrong: the board behind is **not** re-laid-out, re-fitted or re-tiered on the way in or out, and the camera does not move at all — shutting the set puts you back exactly where you were. Leaving it **stops the tape**, because a recording nobody is watching is not one worth decoding. None of its chrome reaches an export. And a click outside the picture does **not** shut it, for the same reason it does not shut a folder: the playhead is local, is written down nowhere, and a stray press must not cost you your place in a two-hour interview. The way out is on the set itself.

One thing plays at a time, and where the playhead is stays on this machine — it is a fact about the window looking at the tape, not about the board, and it never goes on the wire (§7.4's argument, applied to media).

**And the third object takes over nothing at all** (T-277, D-46 §4). Press play on a cassette where it hangs — `Enter` on it, or the menu's *Open* — and it plays. No overlay, no camera move, nothing shut, nothing covered: the board is exactly as usable as it was, and the object goes on being an item you can drag, pin, string and draw on while it plays. That is the strongest reading of §1.1's *nothing blocks thinking* anywhere in this feature, and it is why a cassette player was the one of the three surfaces not built. The readout is the object: the tape wound between the two spools is the position (T-268), moving from the element's own clock, and Q-275 settled that those spools are the *whole* readout — a cassette shell has no meter on it, the meter is on the deck, and this board has no deck. Pressing again stops it and leaves the tape where it stopped; putting a film on the set stops it too, because that is the one place "carry on working" would mean two recordings out of one pair of speakers.

The consequence worth writing down, because it reaches the renderer: **a playing item is not culled** (D-50). A media element removed from the document is paused by the user agent, so the culler exempts it exactly as it has exempted the note being written on since T-179 — unmounting the one ends the sentence you were in the middle of, unmounting the other ends the recording. A cassette *paused* half way through is an ordinary item again and may be culled like anything else; its position is held by the player rather than by the view, so it comes back where it was.

**What "flies" means, and what search is allowed to do** (T-85, Q-150, Q-151). The camera *eases* to a match over about 300ms rather than jumping, and it is the only camera move on the board that does. That is a §2.3 decision rather than a decorative one: the board earns its keep on spatial memory — you know roughly where a thing is because you put it there — and a teleport spends it, six times over if you step through six matches. `reveal` (§7.6, after an undo) rightly still jumps: it moves only when something is *already* off screen, and its job is to show you a change rather than to carry you. Any pan, zoom or other camera move cancels a flight in progress; the hand always outranks it.

The match you arrive at flashes, one at a time, in the same amber §7.6 uses. Flashing *every* match was considered and rejected and still is: eleven items pulsing at once is the board sorting itself for you, which is the thing §2.5 rules out, and it stops the flash meaning "this one".

**Every other match wears a faint border instead** (T-236, Q-176), for as long as the search is open. It is the flash's box in the flash's amber at less than half the weight, and the distinction between the two is the whole design: a pulse is an *event* and says "here, now", and a standing hairline is a *fact* and says "and those". So the answer has a shape you can see without anything competing with the one you were carried to — and without a result list, without anything dimmed, and with every item exactly where it was and exactly as visible. The weight was chosen off a ladder of four rather than by feel; `render/overlay.ts` records what each rung looked like.

Off-screen matches get nothing. A tick at the viewport edge pointing at each of them was the third option on Q-176 and is the one that changes what search *is*: this marks what is already in front of you, and the field's count ("3 of 7") stays the entire summary of what is not.

Refining a query does not move you: as long as the match you are reading still matches, the camera stays on it. Search is the one shortcut handled *before* the text-field bail, because the thing it opens is itself a text field.

**And it looks inside the case files** (T-286, D-46 §5). A folder matches on what is *in* it as well as on its label, and arriving at one **opens it at the page** — the same turn and the same flight the *Open* gesture makes (§3.7's floor, at the page's type size rather than the board's hand). That is search doing the one thing §1.5 permits, finding a connection you did not know was there, rather than the thing it forbids: it still flies to an object on the cork, there is still no result list, and a folder that matched on page forty is one match rather than forty. The pages themselves are a derived local index and never enter the document (D-46 §2), so a machine holding none of the bytes searches labels and finds nothing inside — the same machine that cannot show you the photographs either. A tape is never opened by a search: a recording has no page, and starting a film because somebody typed a third character would be the loudest thing on this board happening by accident.

The field says what it could not look inside (Q-273): "3 of 7 · 1 folder part-scanned". A scanned page is an image of paper, there is no OCR (D-46 §6), and so it can never match — the count alone would let that read as a board with nothing to say on the subject. It is said of the folders that **matched**, not of the board, so it bears on the answer in front of you rather than standing as a warning about filings the query has nothing to do with.

A flight lands at a zoom the match can be **read** at (Q-153) — `READING_ZOOM` in `render/lod.ts`, the zoom at which the board's 19-unit handwriting is drawn at 10.5 screen pixels. It is a *floor and not a target*: search from 100% and nothing about the zoom changes. It exists because searching from a fitted board otherwise carries you to a flat card — §6.6 stops drawing per-glyph text below 35%, so "the match" at that zoom is a rectangle, and arriving somewhere you cannot read is close to not having arrived. This is the one place the camera takes a zoom decision on your behalf, and it only ever zooms *in*. A match too large to fit at that zoom is fitted instead: an item filling the viewport is one whose place you can no longer be in any doubt about, which is what the search was for.

The floor was 5% and was raised, and it is a performance decision as much as a product one (T-204). 5% is the zoom at which every item on a five-hundred-item board is on screen at once, and §6.6's measurements say that having them all mounted — not the act of mounting them — is what costs. Capping how far out the camera goes is the lever that finally puts *every* stage where the camera is holding still inside frame budget, at every zoom. It costs exactly one thing: `Ctrl+0` and `F` on a board larger than 15% can frame will centre it and show most of it rather than all of it — a board over roughly 8,500 by 5,700 units, about 28 by 19 pasted photographs.

### 3.8 Selection and deletion

Click to select, `Shift`+click to add, drag on empty cork for a marquee, `Ctrl+A` for everything visible. Double-clicking a pin selects the whole connected component, which is how you grab an entire thread of an investigation and move it somewhere else.

Both bulk gestures take **free pins** as well as items — a free pin is a thing on the board in its own right, and `Shift+Delete` is forever making more of them. Parented pins are not members: they travel inside their paper already, and the paragraph below is why counting them twice would shear the web. A pin is a point for this, so it is in if its position is.

`Delete` removes the selection, including its pins and any strings that drop below two nodes.

`Shift+Delete` removes the items but **leaves their pins free-floating in the cork**, so the string web keeps its shape with a hole where the evidence was.

Group rotation transports parented pins for free — they're in item-local space — but free pins inside the selection have their board coordinates transformed as leaves of the same transform. Miss that and rotating a selection visibly shears the string web.

Undo: standard, whole selection as one entry, cascades included.

### 3.9 Keyboard map

```
Tools           V select · P pin · S string · N note · M marker · H highlighter · E eraser
Navigation      Space+drag pan · wheel zoom · Ctrl+0 fit · Ctrl+1 100% · F frame · Ctrl+F find
Editing         Ctrl+V paste · Ctrl+C copy · Ctrl+X cut · Ctrl+Z undo · Ctrl+Shift+Z redo
                Delete remove · Shift+Delete remove but keep pins · Ctrl+D duplicate
Modifiers       Ctrl+drag keep a pin in its item · Alt+drag pull string · Alt+click remove pin
                Shift+click extend selection · Ctrl at pen-down force board ink
Strings         1–9 slack presets · Alt+wheel whole-string slack · Enter/Esc end run
                Ctrl+Alt+click a string cuts it, in any tool — the scissors; the pointer says so
Search          Ctrl+F find · Enter next match · Shift+Enter previous · Esc close
Case files      Enter opens the selected document, tape or cassette · item menu → Open
                Esc or Enter again shuts it · clicking away does not (T-273)
                Left/Right turn a page in an open one, in any tool (T-321, T-278)
                marker on an open page is redaction — it stays on that page (T-278)
                a quote's tape stays on its page too; its thread goes under the
                sheet on show, and under the folder when it is shut (T-330)
The set         a tape takes the screen, and only a tape (T-276)
                Space play/pause · Left/Right 5s · Shift+Left/Right 30s · Home to the start
```

### 3.10 The tool drawer and the tool info bar

Everything in the table above was, until Phase 10, the *only* way to reach any of it. That is a reasonable state for a board being built by the person who wrote the table, and an unreasonable one for anybody else: seven tools and about thirty modifiers, none of which is suggested by anything on screen. §3.4's scissors is the sharp case — `Ctrl`+`Alt`+click was chosen precisely because nothing can press it by accident, and the cost of that is that nothing suggests it either.

Two pieces of chrome answer it, and they are one piece of furniture: **which tool you are holding**, and **what it does**.

**The drawer** is a rail of the seven tools down the left edge, vertically centred. Each button is a glyph with its key letter under it at half opacity, because the rail's job is to teach the keyboard rather than to replace it — somebody who finds the drawer finds the shortcuts. It holds the seven and nothing else: not the pens' colours and sizes, which the context menu and the bracket keys already own, and not undo, fit or actual size, which are history and camera rather than tools. A drawer holding all three would stop being a statement about what is in your hand.

**The info bar** is bottom left, where the old hint line was, and it is per tool. It leads with the tool, its key and its plain verb; then the gestures that need nothing held; then either the *chips* — `hold Shift · Ctrl · Alt` — or, while one of those is down, the gestures that key unlocks. Underneath, a quieter standing line for the camera, the search and undo, which belong to no tool.

**The chips are the whole idea.** Two thirds of what a tool implements sits behind a modifier, and a gesture you are not holding the key for is one you are not about to make — so at rest the bar names the keys and says nothing about what is behind them, and holding one is what asks the question. They name *keys*, not combinations, which gives the state that teaches the scissors: on the pin tool, holding `Ctrl` lights its chip and reveals nothing, so `Ctrl` is visibly half of something, and pressing `Alt` finishes the sentence.

**The handle at the foot of the rail is the only toggle, and it puts both away.** No new keyboard shortcut, which is deliberate: the table in §3.9 is what this board can be learned from, and a binding that is not in it is a binding nobody can find. `state/tools/machine.ts` deleted `KeyB` on exactly that ground. A cork-menu row was the third option and was declined as one more row for something the handle already says. Whether the drawer is open is remembered per machine — a taste, like §4.7's ageing, and stored the same way.

Neither panel takes a press it did not ask for. The bar is inert entirely; the rail takes clicks on its buttons and nothing else, and no button is in the tab order — a focused button would eat `Space`, which is the pan, and `Delete`, which is the erase.

---

## 4. Art direction

"High visual fidelity" is unactionable as a brief, so this section is specific. The governing principle: **fidelity comes from baking, not from per-frame effects.** Pre-rendered shadows, textures and sprites look better *and* cost nothing, where live blurs and filters look worse and cost everything (§9.4).

### 4.1 The single light

One global light direction, roughly from the upper left, about 30° off vertical. Every shadow in the application agrees with it — items, pins, string, the cork's own surface variation. Nothing else creates a sense of a real surface as cheaply, and nothing else breaks it as fast as one element lit from the wrong side.

Shadow colour is never black. It's a desaturated warm brown drawn from the cork, at low alpha.

### 4.2 Cork

A seamless cork texture, tiled, with a large-scale low-frequency noise overlay at low opacity to break up the repeat — tiling artefacts on a background are the single most common way this kind of app announces that it's cheap.

Over the top: a very slight vignette anchored to the viewport, and a broad soft light gradient anchored to the *world*, so panning moves across a surface that isn't uniformly lit. The cork also carries faint accumulated pinholes near where pins are, which is a lovely detail that costs one extra sprite layer.

**This sentence used to say "near where pins are *and have been*", and the second half was struck on Q-178.** Nothing on this board remembers a pin that is gone: `deletePins` is a hard `Y.Map` delete, there is no `deletedAt` and no tombstone a renderer may read, and the local mirror drops its empty sets on purpose so a board pinned and unpinned all afternoon does not accumulate them. The three ways to give it a memory were a document field that only ever grows (§11.1's fifth risk, by name), a local record that would make two people looking at one board see two different corks, or a hash of position — which would be a pattern rather than a history and would put holes where nobody ever worked. So the layer draws around the pins that are there, and does it as a patch of near misses rather than one mark per pin, because the hole a pin is standing in is a hole you cannot see.

The board is unbounded, so the texture is generated from a per-board seed and tiles indefinitely.

### 4.3 Polaroids

The classic frame: white border, thick at the bottom, very slightly off-white and warmer at the edges. The photograph sits slightly inset with a fine inner shadow, so it reads as being *behind* the frame rather than printed on it.

Over the image: a subtle gloss gradient, a hint of vignette, and optional aging (§4.7). The caption area at the bottom takes handwriting, and is empty by default — most photographs on a real board are uncaptioned.

Every polaroid is rotated a few degrees, seeded per item. Optional tape at one or two corners, slightly translucent, with its own small shadow and a barely-visible torn edge.

Tape is not only a print's, though this is where it is written down: §2.1 says the archetypes differ only in styling and defaults, and a note taped to a board is as ordinary as a photograph taped to one. It is also not decoration — tape is one of the two things that hold a sheet down, so a taped corner does not curl (§4.4).

**Nothing pinned is taped.** The two are alternatives, not layers; nobody tapes down a photograph they have already put a pin through. That is what tape is *for* here — a taped item is one that would otherwise be held by nothing at all, which is exactly the item whose corners would all be curling. It follows that pulling the last pin out of something makes tape appear on it, and putting the pin back takes it away: the same answer the curl gives to the same gesture, at the corners the item's seed always meant.

Two strips go on as a pair, across the top or diagonally opposite, because two adjacent down one side is a thing nobody does and it looks like it.

**"Its own small shadow" is not a cast one.** Every other shadow in this application is an offset copy of a silhouette, and that is the shadow of something held *above* a surface — tape is the one object here stuck flat to one, and drawn that way it read as a plank lying across the corner. What tape has is a cross-section: a shine along the edge nearer the light and a hairline of its own thickness along the edge away from it, with nothing in between, because the middle is in contact. The light decides only which way up that profile is drawn.

### 4.4 Notes and scraps

Paper stock varies: white, cream, yellow legal, graph, index card. The index card is a stock here and nothing more — §2.1 records why it stopped being an archetype. Each has its own grain texture at low opacity, its own edge treatment, and its own slight colour variation across the sheet.

Edges are the tell. A machine-cut rectangle reads as a UI element; a torn or slightly irregular edge reads as paper. Notes get a subtly ragged edge by default, generated from the item seed, and a "torn" style with a proper rough tear on one side.

Which side, and whether there is one at all, turned out to belong to the stock rather than to a coin flip — this section's own first line says each stock has its own edge treatment, and T-80 took it literally. A legal pad is gummed at the head, so every sheet leaves it torn along the top; graph paper comes out of a book and tears down the left against the wire; an index card is die-cut and is very nearly straight. That is worth more than a random minority of torn notes, because the edge and the ruling then agree about what the object is. `style.torn` keeps the job DATA-MODEL gives it — overriding a default rather than being the only source of one.

Two things separate a tear from a cut, and both are in the geometry rather than in the shading: the run has to be irregular in *both* axes — vertices at uneven intervals, each off the line by its own amount — and the torn lip has to show the fibre inside, which is lighter and flatter than the sized face of the sheet. Evenly spaced vertices are a sawtooth however deep they go, which is the same finding §7.5's torn photograph had already written down.

Paper curls very slightly at unpinned corners — implemented as a gradient and a shadow, not geometry — which is why a one-pin note looks like it's hanging and a four-pin note looks flat.

"Unpinned" is not a property a corner has; it's a distance, so the curl is a falloff on how far the nearest pin *through the sheet* is, in board units rather than as a fraction of it — paper stiffness is physical, and a pin flattens about so much paper around it whether the sheet is a scrap or a poster. That is also what makes the four-pin case fall out rather than be arranged.

All of it is on the paper, and for two versions it was not. A corner that lifts on the light side of a sheet casts **onto the sheet**, and one on the far side casts onto the cork, so the shadow had a layer of its own over the top, unclipped, to reach both. What killed that layer is that an unclipped shadow has to draw its own boundary, and a cast shadow's boundary is the sheet's edge slid along the light — a hard line, with nowhere to soften, since it starts at the corner where the flap is still touching. Slid along the light it lands *inboard* at three corners out of four, on flat paper, where it reads as a grey rectangle laid over the sheet. Only the corner the light runs off carries both of its bounds clear of the paper. Clipped to the sheet, the silhouette is the only boundary and none of ours is ever visible. The price is the shadow a corner throws onto a *neighbouring* note, which the item's own nine-slice already half carries, and which is small on something that curls "very slightly".

All four corners are lit *differently*, and this is where §4.1 bites hardest. A flap at the top left tips into the light and its face brightens; the one at the bottom right tips away and darkens. A first version gave every corner the same bright tip and the same blob of shadow — including one sitting up-light of the corner, which is a shadow on the wrong side — and it read as four smudges rather than as four folds.

**Nothing about a lifted corner is round.** A sheet bends about a *line*, so every contour of equal height across the corner is a straight line parallel to that fold, and the shape is a triangle whose other two sides are the paper's own edges. It was built out of radial gradients centred on the corner for two versions, so the shading was a disc and the fold was an arc. That survived review while a note sat alone on cork, where a brown disc on brown cork is camouflage, and failed the moment two notes overlapped and a disc landed on a white sheet — worst at the bottom pair, which is the fully-curled pair on anything hanging off one pin.

Four diagonal directions replace it exactly — eight gradients, a lit flap and a dark one each, the dark one also carrying the roll foot and the cast shadow. A colour stop on a 45° gradient *is* a straight line across the corner at a fixed distance from it, at any aspect ratio, and a band that has faded out by its last stop needs no mask to be a triangle — the sheet's own box already clips it to one. That last property is the whole reason the shading can live on the paper and stay honest, and the reason the cast shadow could not live anywhere else.

The tone falls from the tip toward the fold and there is no crisp line anywhere in the figure. That direction is the curl: the corner is furthest off the paper at its tip and flush with it where it goes flat. Two separate versions were rejected for putting a hard edge in — a sharp crease at the fold, which read as a folded panel stuck onto the sheet, and a hard-bounded cast shadow, which read as a rectangle laid over it. The shape reads because its contours are straight and parallel, not because anything is crisp; every edge that is actually visible has to be the paper's own.

Everything is anchored on the corner of the *paper*, not of the item's box. Those differ by a couple of units on an ordinary sheet and by most of a centimetre on a torn head, and a fold centred on the box has its highlight clipped away by the very silhouette it belongs to — the fold and the edge visibly disagree, which is what a first version of this looked like and what Phil named on sight.

### 4.5 Pins

Pushpins are the default: a coloured spherical head with a specular highlight positioned per the global light, a visible metal shaft where it meets the surface, and its own small hard shadow. Thumbtacks and nails are alternatives.

Pins render above items and above string, because they're physically on top of both. The string's attachment point is drawn *under* the pin head, so the string genuinely appears to pass beneath it.

Pin head diameter stays within a range in *screen* space as you zoom out, so pins remain visible and clickable on a zoomed-out board rather than vanishing. This is a deliberate break from strict physical scaling and it's worth it.

### 4.6 String

The most important surface in the application.

Rendered as a three-pass stroke along the simulated polyline — plus a fourth for a fibre with fuzz, which this list predates and §3.4's yarn needs:

1. **Shadow** — offset along the light direction, a desaturated warm brown at low alpha (§4.1, never black), wider than the string. The *same* shadow everywhere, including where the string lies on top of an item.

   This last part is a reversal. The plan was for the shadow to widen and soften where a string is lifted onto a photograph, and it was built and then taken out again after looking at it: §6.4 forbids `shadowBlur`, so a canvas shadow here is an offset stroke and nothing else, and the only way to say *softer* is to say *wider*. A wider hard-edged stroke disappears into mottled brown cork and becomes a solid grey bar on white paper — so the pass meant to read as a string lifted a paper's thickness off the board read as a stripe ruled along the top of the note. The lift is not lost, only the shadow of it: an `over` string draws above the item layer, so it is visibly on top of what it crosses.
2. **Body** — the main colour, full width, round joins and caps.
3. **Highlight** — a brighter tint at reduced width, offset perpendicular to the light by about a pixel.

Three `stroke()` calls, and it reads as a lit cylinder. Twist and fibre come from a subtle repeating variation along the length rather than from simulation.

The twist is the **third pass, dipping**: the highlight is dashed with a nick half a pixel wide, once per turn of the ply, so the specular dims and recovers along the string instead of running flat. Light on a twisted cord really does behave that way. It costs nothing — a dash is context state, so it is set once per batch and adds no `stroke()` call and no path walk; 300 strings redrawn every frame measure 0.50 ms with it and 0.50 ms without.

**Half a pixel is the whole idea.** A gap that clears a pixel is one the rasteriser can actually empty, and then the highlight stops dimming and starts *breaking* — which is a dashed line, the one thing this has to stay away from. Under a pixel it can only ever be partial coverage, so what lands is a modulation. Driven on a ladder at 100%, the peak-to-trough brightness of a 6 px string's highlight goes 2.6 with no twist, 18 at a fifth of a pixel, 43 at a half, 60 at 0.8 and 76 at 2.2 — and the pictures either side of the half are the argument: by 0.8 a thick string is visibly ticked, and by 2.2 it is a rope drawn as a dashed line. It is also constant rather than a fraction of the width, because a fraction makes the interruption grow with the string until it is a break, and the *pitch* already carries everything that ought to scale.

Being sub-pixel is what lets every spun string carry it, at every rung of the thickness ladder. The pitch is a multiple of the string's **drawn** width — the twist of a real cord is a fact about its diameter, so fat wool takes a long lazy turn — and it inherits §6.4's screen-space rule with the width: driven at 40%, 100% and 250%, an 11 px pitch measures 11 px at all three. It has a floor, because below about four and a half pixels a repeat stops reading as a rhythm and starts reading as a *dotted line*, the nick coming round too often to be anything but overall beading.

**Wire has no twist, and that is not a shortfall.** Metal is the one fibre here whose highlight really is continuous, and the drawing agrees emphatically: wire's specular is the brightest thing on the board and its width sits on the `HIGHLIGHT_MIN` floor, so it is a near-white line a pixel wide on dark cork — the highest contrast anywhere — and a nick invisible on cotton reads as a row of beads on it. Driven, it was the one string of six that anybody would have picked out. It is left alone, and on a board where five strings have gained a texture it is the one that measures pixel-identical to before.

**The cap is the part that is easy to get wrong.** A round cap does not stop at the end of its dash; it puts a semicircle of half the line width past it, at both ends of every gap. So a gap narrower than the highlight is filled in by the two dashes either side of it and the twist is not drawn at all — worst on the widest strings, where a top-rung yarn's 5.6 px highlight swallowed a 2.2 px gap whole. The dashed pass is butt-capped and every other pass is not. It was written the other way first, and no unit test could see the difference; what caught it was sampling the pixels of a driven board and finding twelve of them flat where a groove should have been.

Default red is not a pure red — it's a slightly desaturated, slightly dark cotton red, because saturated red on brown cork vibrates unpleasantly. A taut string is very slightly thinner than a slack one.

### 4.7 Ageing and wear

Boards accumulate. Items gain, slowly and subtly: paper yellowing at the edges, occasional coffee rings, dog-eared corners, small creases, faint fading on photographs. Ageing is deterministic from the item's seed and its age, never random per render, and it is always subtle enough that nobody consciously notices it — they just find that an old board feels older.

**Wall-clock, and per item.** This section said board time for a long while and §11.2 asked whether board time was needed; Q-105 settled that it is not. What an explicit board clock buys is that a board left in a drawer for a year does not lurch when it is opened. What it costs is a clock *in the document*: a periodic write forever, ticking at double speed with two windows open, on a field every peer has to agree about. That is a great deal of machinery standing between a sheet of paper and the fact that it is old, in aid of a jump that happens once, to a board nobody was looking at, over a change nobody is meant to notice anyway.

Per item is the half that matters more. An old board is not uniformly old — it has a note pinned up two years ago and one added this morning, and the second one being crisp is what makes the first one read as old rather than making the whole board read as sepia.

**Two mechanisms, because there are two kinds of ageing here.** Paper ages by having things *added* to it: light and air darken the fibres from the edges in, a hand puts a fold in it, a mug leaves a ring. Those are overlays on the sheet. A photograph ages by *losing* something — the dyes go, cyan first, so a print warms and its blacks lift, and the white card around it goes cream. That one is a filter, and painting it as an overlay instead is how a photograph ends up with a beige rectangle over it: a warm wash lands on the shadows as well as the highlights and turns black to brown.

**Yellowing accrues; a coffee ring happens.** Both come off the same monotone number, so the discrete marks are per-sheet thresholds, seeded, spread past the top of the range — which is how "occasional" is spelled. Wear is asymptotic and a board lived with for a year sits around 0.6, so a threshold band running past 1 leaves about a quarter of a well-used board ringed and no two sheets acquiring one on the same day.

**A crease lies along an axis of the sheet.** Nobody folds a note corner to corner, and a uniform angle over the half circle — which is the obvious reading of "small creases" — puts a long straight line across a note at thirty-odd degrees, which reads as a scratch on the lens rather than as a fold. A few degrees off the axis, because a hand made it.

It is also drawn three times, and the third one is the interesting one. A fold is a shallow V, so one flank turns into the light and the other away from it, and which is which changes when the sheet is turned — §4.1 again, and the same trap the curl fell into. But the lit pair goes to *nothing* when the fold runs square across the light, and the crease is still there: the fibres along a fold are broken, and broken fibres are darker than the sized face of the sheet whichever way they point. So under the signed pair there is an unsigned line. The same split §4.4's curl already makes, where the flap's tip is signed and the crease at its base is not.

Ageing can be turned off entirely for anyone who finds it precious — from a right-click on the cork. A *local* preference and not a document field: two people on one board may legitimately disagree about wanting to watch their paper go brown, and a `meta` flag would let one of them decide for the other. Turned off, the renderer is handed a clock on which nothing is older than this morning, which is a picture it has no way to tell from a board that is new, and no reason to want one.

It costs nothing measurable. Two extra gradient layers per sheet and one per print, and on a board of 300 sheets all old enough to carry every mark above, neither the raster nor the DOM phase moved: 34.9 ms against 34.6 for a viewport capture, 1.1 ms against 1.0 for a full re-bind of everything mounted, both inside their own run-to-run spread. A board with nothing old on it pays less than that — the layers are `display: none` until an item has any wear at all.

### 4.8 Typography

Handwriting for note text, captions and annotations — a decent hand for body text, plus a rougher marker-style face for annotations. Per-character jitter in baseline, rotation and size, seeded by character index so it's stable (§3.6).

**Whatever face is chosen is set glyph by glyph.** A transform does not apply to an inline box, so a letter that leans has to be one — which means no kerning between letters and no joins across them. A *connected* hand therefore comes apart, and this asked for one until T-81 measured what that costs. Kerning is turned off on the whole surface rather than only where the boxes are, because the editor's caret lives in a plain `<textarea>` that can never have them, and two different sets of advances mean the words re-wrap the moment you click into a note.

UI chrome is the opposite: a clean, quiet, neutral sans, low contrast, staying out of the way. The board is the loud part. Toolbars are dark, translucent, and float over the cork without pretending to be physical objects — a fake wooden toolbar would be skeuomorphism, which §1.3 rules out. §3.10's drawer and info bar are the two that exist, and they are in that idiom rather than in the paper-slip one the notice and the confirmation use: those two are things somebody left on the board, and these are pieces of the application.

---

## 5. Physics

Subtle, cheap, and almost always asleep.

### 5.1 Principles

**Physics never writes to the document.** Not particle positions, not swing angles, not settled rotations, not sleep flags. Every physical quantity is transient or derived. This one rule is what makes multiplayer simulation safe (§7.4) and it has no exceptions.

**Everything sleeps.** A board at rest costs nothing. Simulation is a transient response to disturbance, not a continuous background process.

**No physics engine.** Matter.js, Rapier and friends would add a megabyte of dependency to deliver *worse* rope: general rigid-body solvers give stretchy, springy joint chains, and fifty strings at twenty links each means a thousand bodies and a thousand joints in a broadphase, for something that is about 150 lines of arithmetic done properly.

### 5.2 Rope simulation

Verlet integration with position-based constraint projection.

Each segment between adjacent pins is an independent chain of particles. Per frame, at a fixed timestep:

1. Integrate: `next = pos + (pos − prev) × damping + gravity × dt²`
2. Solve the distance constraints. A chain's constraints form a **tridiagonal** system, so it is solved directly — one forward pass and one backward one — rather than relaxed toward a solution. This step said "several iterations, each pass moving both particles halfway to satisfaction" until T-147; see D-23 and the note below for the bug that forced the change, and §3.4, which has referred to "solving the rope exactly" since.
3. Re-pin the endpoints to their pins' current world positions.

There is no fourth step. This list carried "resolve item collisions if the string is on the `over` layer" for a long time, and §5.6 now opens by saying there is no rope-item collision: draping was built and scrapped (D-22). An `over` string draws above the item layer and passes over what it crosses, so the solver has three steps and no seam for a fourth.

Working numbers, to be tuned: particles spaced 10–14 board units, so 12–20 per segment; 6 constraint iterations; damping around 0.98; gravity tuned by feel rather than by physical accuracy.

Fixed timestep of 1/120 s with an accumulator and a cap of four substeps per frame, so behaviour doesn't change with frame rate and a stalled tab doesn't explode on resume.

> **Tuned, and one of those numbers was wrong — see D-17.** Six constraint iterations leaves a rope settled **23% longer than its own rest length**, hanging 19 board units below the analytic pose, because position-based dynamics holds a load by holding a violation and the error is therefore permanent rather than transient. Iterating harder barely helps; halving the timestep quarters it. Shipped: sixteen micro-steps inside each fixed 1/120 s step, two passes of the direct solve each — `ROPE_ITERATIONS` is now how many Newton steps that solve takes, not how many relaxation sweeps. The fixed step, the accumulator and the four-substep cap above are unchanged — those are what framerate independence is measured in.
>
> Step 3 also went the other way round in the end. Re-pinning *after* the passes leaves the link next to each pin stretched by however far that pin moved, every frame; the endpoints are seated on their pins *before* projection and never integrated, which is the same statement made as infinite mass.

### 5.3 Rest, wake and sleep

**Ropes are seeded analytically, not simulated into place.** On load or creation, solve the catenary for the segment's chord and rest length, evaluate it at the particle positions, and mark the rope **asleep immediately**. A board opens perfectly still. Simulating from a straight line instead produces a whip-crack across every string every time the file opens, which looks like a bug and takes half a second to settle.

**Wake** on: an endpoint moving more than a hair this frame; a topology change; or a slack change.

**Sleep** when the largest particle movement stays under about 0.05 px for 12 consecutive frames. Cache the pose and stop stepping. A sleeping rope is one polyline draw and no simulation at all.

This is the entire scalability story for string. A board with 500 strings has, in normal use, between zero and four awake at any moment.

### 5.4 Slack, and the mid-string split

Rest length is derived: `restLength = chord × (1 + slack)`.

Two constraints on slack, both of which produce visible artefacts if violated:

- **It must be greater than zero.** At rest length equal to the chord the solver has no slack to absorb error and the rope jitters visibly. Clamp to a small minimum.
- **If the user drags pins further apart than the rest length**, don't let the solver fight it. The string goes taut and stays taut; it does not tug at the item, because §5.7 is one-way and always was.

**Splitting on insertion.** When a pin is inserted at some point along a segment, the two new segments must together sag exactly as the one did. Since slack is a ratio, the split is by arc-length proportion: each child takes the same ratio, adjusted so the sum of the child rest lengths equals the parent's. Do it any other way and the sag changes at the instant of insertion, which every user will read as a bug.

**Merging on removal** is the same in reverse: the merged segment's rest length is the sum of its parts, converted back to a ratio against the new chord.

### 5.5 Item swing

The mechanic that makes pin count feel like something.

An item with **exactly one pin** hangs from it. Its rendered rotation is `authoredRotation + θ`, where `θ` is a torsion spring: it accelerates toward the hanging equilibrium given the offset between the pin and the item's centre of mass, damps, and decays to rest. Drop the item and it swings, twice or three times, and settles.

An item with **two or more pins** is rigid — no `θ`, no swing.

An item with **zero pins** lies flat and doesn't move.

`θ` is never stored and never synced. It is a local visual offset, recomputed from scratch, and the equilibrium rotation is a pure function of pin geometry — so no client ever needs to write it down.

### 5.6 Draping — built, and scrapped

**There is no rope-item collision.** An `over` string draws above the item layer
and passes over whatever it crosses; an `under` string draws beneath it. That is
the whole of the interaction between string and paper.

This section used to specify the opposite — that an `over` string could not sag
through an item and came to rest along its top edge — and that was built in full
and then removed. D-22 is the decision record; the short version is that the
stylisation cost far more than it returned:

- **Nearest-edge ejection**, the only formulation that is stable, does not
  produce draping. It produces *repulsion*: a string crossing a note is pushed
  down and around it, clinging to the underside and running up the far side, and
  held **32% past its own rest length** while it does so.
- **Top-edge-only ejection**, which is what this section actually asked for, is
  not stable. Ejecting upward is discontinuous at an item's left and right
  edges — one particle is lifted the height of the paper and its neighbour a
  link away is untouched — and the rope tears apart there. Every variant tried
  (depth-limited, rate-limited, one-way) either failed to settle or failed to
  catch, and the ones that passed did so on fitted constants with no margin.
- **Catching only a string that sags onto an item** is stable and almost never
  fires, because a rope is *seeded at its rest pose* rather than dropped. A
  string is placed inside an item; it never falls onto one.

Underneath all three is the same thing: a hard non-penetration constraint sitting
next to a hard distance constraint, in a solver that has no way to trade them off
against each other. Getting it right needs a different solver, not another
constant — and this is visual flair, so it does not get one.

What did come out of the exercise and stays: the string's shadow is the warm
brown of §4.1 rather than black (it had been black since the painter was
written), and `lib/cellgrid.ts` — the uniform grid the draping pass wanted to
share with culling — remains a `lib/` primitive.


### 5.7 String does not pull back on items

**One-way, and that is final**: items drive string, string does not drive items. There is no flag, and there is nothing behind one.

This section used to describe the reverse as worth pursuing behind a flag — a taut string exerting a capped, heavily damped torque on a **single-pin** item, so a photo pulled tight by a thread hangs slightly askew toward it, called here "the detail that would most make the board feel physically coupled". It was scheduled to be prototyped in phase 3 precisely because item → rope → torque → item is a feedback loop and feedback loops oscillate, so it was worth knowing early whether it was viable.

The prototype never happened. Phase 3 closed without it, nobody recorded a decision either way, and it survived unbuilt and unstruck until two of the six surveyors behind D-41 found it independently. It is struck now, on the judgement that it is **fundamentally redundant** rather than on the oscillation risk — the board already reads as coupled, because an item carries its pins, a pin carries its strings, and a string re-hangs the moment either end moves. What this would have added is a second-order effect on top of a first-order one that is already doing the work.

Worth knowing rather than re-deriving: the risk was never the reason this did not ship, so a future argument for it should be about whether it adds anything visible, not about whether it can be made stable. The four mitigations that were listed here — cap the torque, single-pin items only, disable while either endpoint is held by anyone, and a global off-switch — are a reasonable design if anyone ever revisits it.

### 5.8 Tuning constants

All physics constants live in one module with a debug panel bound to them. Feel is found by fiddling, not by derivation, and the fiddling needs to be fast.

---

## 6. Rendering architecture

### 6.1 The choice: hybrid DOM, not WebGL

At the target scale — hundreds to low thousands of items, a few hundred visible at once — DOM plus CSS is comfortably within its envelope, and it hands us text editing, `mix-blend-mode`, rotation, hit-testing and accessibility for free. All four are substantial bespoke work in WebGL. tldraw ships a DOM renderer with a 4000-shape ceiling and aggressive culling; that's the same shape of problem.

What DOM is genuinely bad at is a continuously-simulated rope with per-frame geometry. So the rope gets canvas, and everything else gets DOM.

The escalation path is real and pre-planned: if we exceed roughly 1500 simultaneously visible items, or want normal-mapped fibre on the string, `render/items/` swaps to PixiJS v8 behind an interface that already exists. That is one directory, not a rewrite.

### 6.2 The layer stack

```
┌─────────────────────────────────────────────┐  UI chrome (DOM)
├─────────────────────────────────────────────┤  Pins (DOM) — hit targets
├─────────────────────────────────────────────┤  Overlay canvas — cursors, ghosts, wet ink
├─────────────────────────────────────────────┤  ropes-over canvas
├─────────────────────────────────────────────┤  World wrapper (DOM)
│    └── item nodes, each holding:             │    ONE camera transform lives here
│         image · paper texture · ink canvas   │    all inside the item's rotation
├─────────────────────────────────────────────┤  ropes-under canvas
├─────────────────────────────────────────────┤  Board ink (DOM) — tile canvases
└─────────────────────────────────────────────┘  Cork background          same camera transform
```

**Two rope canvases, not one.** Real boards have string running behind photographs that were pinned on top of it later, and a single overlay forces every string above or every string below. A per-string `layer` field plus one extra clear-and-draw buys that back. It is purely a question of which canvas draws the string — nothing in the simulation reads it (§5.6).

**One camera transform.** The world wrapper carries a single `translate` + `scale`. Items position themselves inside it in board coordinates and never know about the camera. The rope and overlay canvases are full-viewport, in screen space, and apply the camera per-point at draw time.

**Board ink is a second layer under the same camera.** A mark on the cork belongs below the string and below the paper, and a child of the world wrapper cannot be drawn below a sibling of it — so board ink gets its own transformed layer, carrying the same `translate` + `scale` written from the same numbers in the same statement. It is one camera at two depths of the stack, not two cameras. Its content is one canvas per 2048-unit `boardInk` tile, mounted and evicted by viewport like everything else that holds a bitmap.

**Ink inside the item's transform** is the trick that makes annotation free: because each item's ink canvas is a child of the item's rotated node, ink follows the item through every move and rotation with no maths at all.

### 6.3 The frame

One `requestAnimationFrame` loop for the entire application. Nothing else animates independently.

```
1. INPUT      drain coalesced pointer events → tool state machine
2. PRESENCE   apply interpolated remote poses (rendered ~100 ms in the past)
3. SIM        step awake ropes and swings within the viewport margin; sleep checks
4. LAYOUT     recompute world pin positions for dirty items
5. DOM        write transforms for dirty items only          ← the only write phase
6. INK        re-raster items in the dirty-ink set
7. ROPES      clear and draw the under canvas, then the over canvas
8. OVERLAY    remote cursors, drag ghosts, wet ink, selection chrome
9. FLUSH      awareness (every other frame), document ops queued this frame
```

Strict read-then-write separation. **No layout reads anywhere in the loop** — every geometry value comes from the in-memory scene, never from the DOM. One stray `getBoundingClientRect` in phase 5 forces a synchronous layout and costs the frame.

A dev HUD reports per-phase milliseconds, so a regression is visible immediately rather than as vague sluggishness.

### 6.4 Drawing the string

Rope particles simulate in board space and are transformed to screen space at draw time — two multiplies and two adds each. Drawing in screen space means line widths are absolute and crisp at every zoom, with no scaling and no compensation.

Strokes batch by colour and width into as few paths as possible. Sleeping ropes keep a cached `Path2D`, so an idle board of 500 strings is a handful of path fills.

The string's shadow is a **second offset pass at lower alpha** — never `shadowBlur`, which is brutally slow on canvas and would dominate the frame on its own.

### 6.5 Drawing ink

Each item has its own canvas, sized to the item's **ink bounding box** rather than the item, growing in power-of-two steps. Most items have no ink and therefore no canvas at all.

**Wet and dry.** The in-progress stroke draws to a screen-resolution overlay so that latency is as low as the platform allows; the committed strokes underneath aren't touched. On pen-up the stroke is committed and the item's own canvas re-rasters once.

Stroke geometry comes from `perfect-freehand`, which turns an input polyline into an *outline polygon* that gets filled — not a stroked line. Marker uses meaningful thinning and an opaque fill; highlighter uses near-zero thinning, a flat cap and `multiply` composition. Crucially, each highlighter stroke composites as a unit so that a single stroke crossing itself doesn't darken at the crossing.

The unit is the **record**, not the gesture, and after §2.4's hand-over those are not always the same thing: a highlighter that runs off a photograph, comes back onto it, and then crosses the part it drew first will deepen where the two pieces overlap, because they are two records and two fills. Measured at roughly 11/255 against 4/255 for an uncrossed stroke. It is left as it is — after a hand-over the pieces genuinely are separate strokes, the case needs three coincidences at once, and the alternatives are worse: merging the pieces would draw a straight segment across the surface they crossed, and compositing the whole gesture to one buffer is impossible when the pieces are on different canvases by construction.

Input uses coalesced pointer events, which recover every sample the OS delivered between frames — the difference between a smooth curve and a visible polygon on a fast stroke. Pressure branches on pointer type: a real pen reports real pressure, while a mouse always reports exactly 0.5, so mouse and touch use velocity-derived simulated pressure instead. Getting this wrong produces dead, uniform lines and is a very common mistake.

**Input points are stored, never the generated outline.** The outline is ten times the data and can't be re-tuned later.

### 6.6 Zoom and level of detail

**One LOD tier**, about removing the things that cost most at small scales:

- **Below 35% zoom** — items become simplified cards: flat paper, baked shadow, and writing laid down as a single text node rather than one transform box per character. Ink renders at quarter resolution.

**Detail varies with zoom; structure does not.** That is the rule, and it is why there is one tier here rather than the two this section used to have. What LOD may change is *how much of a thing is drawn*. What it may never change is *what exists, or where it is*. A board zoomed out is the same board: every item, every pin and every string is where you left it, drawn as faithfully as its size on screen can carry, and nothing appears or disappears because you moved the camera.

There was a second tier, at 15% and then briefly at 20%: "items are flat coloured rectangles, string draws as straight one-pixel chords with no sag, pins hide, board ink comes from tile thumbnails". Every clause of it is gone, and by four different routes (Q-121):

- **Flat rectangles** measured *identical* to a flat card, everywhere, once the glyph boxes were gone — and what the clause amounted to in practice, hiding the writing, cost a visible pop as the text came back a frame after the note it belonged to.
- **Straight chords** and **hidden pins** are refused by the rule above: both are structure, not detail. A string that stops sagging has changed shape, and a pin that hides has stopped existing — and a board where things vanish as you pull away from it is not a simpler board, it is a different one.
- **Board ink from tile thumbnails** was already true and never was work. Every tile rasters at `devicePixelRatio × zoom` (§6.5), so at the zoom floor a tile's canvas *is* a thumbnail by construction.

An empty tier is a promise the code is not keeping, so it is out of the code as well as out of this section: `render/lod.ts` names two tiers, not three.

The first tier originally said "text swapped for a pre-rasterised snapshot", on the grounds that live text layout is by far the largest cost when many items are visible. **That reason did not survive being measured** (D-33, Q-115). With 500 notes of real prose at 5% zoom the median frame is 194.5 ms — seven frames in a second and a half — and writing the text as one plain node takes that to 7.0 ms. Writing *no text at all* measures the same as writing it plainly, everywhere, within run-to-run noise. So the cost was never the layout; it was the 73,000 `inline-block` glyph boxes the handwriting jitter (§3.6) needs, against 7,100 nodes without them. A raster would have bought nothing over a plain node, at the price of a canvas per texted item, a re-raster on every keystroke, and a reimplementation of word wrapping the browser does for free.

Two things follow, and both are in the tiers above rather than assumed:

- **What costs is paint, not tree size.** Every variant measured had the same node count — `display: none` leaves a node where it is — and they differed by 375 ms against 104. So the flat card is a stylesheet keyed on one attribute, and the item layer's pooling, binding, hit-testing and ink canvases are untouched by LOD entirely. The exception is the handful of properties the view writes *inline* from an item's stock and seed — the silhouette clip path, the ruling, the sheet tint — which a stylesheet cannot reach and which are therefore switched where they are written.
- **A second, coarser tier for items buys nothing.** A flat rectangle measures the same as a flat card. That is what emptied the bottom tier of the one clause the consistency rule above had not already refused.

**Detail arrives during a gesture and only leaves at rest**, and the asymmetry is deliberate (T-203). Changing tier on the frame the camera *stops* meant that zooming in held flat cards through the whole motion and then popped a hundred and forty sheets into full detail at the one moment nothing else on screen was moving — a change of appearance timed as badly as it can be. Detail now arrives while the board is in motion, which is where it cannot be watched arriving, and it arrives at a budget of a few items a frame: a tier rise catches far more items mounted than survive the gesture, and rebinding all of them at once measured at 493 ms against 49 ms for the sweep. Losing detail stays at the settle, where the frame is already repainting the world for the re-raster, and where a board simplifying as you pull away from it is not something anybody minds.

The zoom-blur trap deserves its own note, because it is the most likely way this app ends up looking cheap: a DOM subtree under a CSS `scale()` rasterises at its pre-scale resolution, so zooming in gives you a blurry stretch of the old raster until something forces a re-render. `will-change: transform` makes this permanent by pinning a cached layer at a stale scale — and it's exactly the property people reach for to make zoom smooth.

The rule, and it is a hard rule: **`will-change` goes on at gesture start and comes off on a debounced gesture end**, at which point the world layer is forced to re-rasterise and ink canvases re-raster at `devicePixelRatio × zoom`. Never leave it on at steady state.

---

## 7. Data model & collaboration

Full schema in [`DATA-MODEL.md`](./DATA-MODEL.md). This section is the reasoning.

### 7.1 Why CRDT from day one

Multiplayer was decided up front specifically so the schema could be collaborative from the first commit. Retrofitting a CRDT means rewriting every mutation in the application, and the shape of the document — what merges, what's last-write-wins, what's atomic — is not something you can add later without touching everything.

Yjs. The document binds in phase 1 and persists locally; only the *network* waits until phase 7. Nothing is rewritten when sync arrives.

### 7.2 The shape

Five root maps, keyed by id: `items`, `pins`, `strings`, `assets`, `boardInk`, plus `meta`.

Keyed maps rather than arrays: constant-time lookup, no index churn on delete, and concurrent creates never contend for positions. Ordering is an explicit fractional z-index, not array position.

The rule applied throughout: **a field is a CRDT type only if two people can meaningfully edit different parts of it simultaneously.** Note text is a `Y.Text`, because two people can type in the same note. Position is a plain number, because two concurrent drags should resolve to one of the two positions, not merge into a nonsensical midpoint.

Strings deserve their specific shape: the run is an array of **nodes**, each holding its pin reference *and* its own slack. Slack in a parallel array desynchronises the instant two clients insert at different indices — the arrays end up different lengths with slack attached to the wrong gaps. Putting slack on the node makes concurrent insertion correct by construction.

### 7.3 Keeping the document small

Three measures, all necessary:

**Drags don't write per frame.** The live pose goes over the ephemeral channel; one transaction is written on release. A throttled write every 300 ms guards against a crash losing work, merged into the same undo entry. It said half a second as an illustration, and half a second is the one figure that cannot work: DATA-MODEL §11 fixes the undo manager at `captureTimeout: 400`, so every write would land 100 ms outside the window and a three-second drag would become seven undo entries rather than one.

**Strokes commit as one record.** Everything up to pen-up is local and ephemeral. On release the stroke is simplified, quantised, delta-encoded and packed into a byte array — roughly 3–4 bytes per point against 50-odd for JSON floats. One stroke is one document entry, one undo step, one delete.

**Erasing deletes strokes.** The default eraser removes whole stroke records, which is tiny and merges cleanly. Rasterising and flattening ink would destroy both undo and merge, and is never done.

### 7.4 Ephemeral state, and why physics isn't synced

Cursors, selections, live drag poses and in-progress strokes travel over an ephemeral awareness channel, not the document. They vanish on disconnect, which is correct. Camera positions travelled here too and no longer do (T-226, Q-171) — nothing drew them and the seeder they were published for does not exist.

**Rope state is never synced at all**, and this is the key scaling decision. A segment with fixed endpoints, a fixed rest length, gravity and damping has a unique stable attractor — the catenary. Replicate the *inputs* — pin positions, slack, topology — and every client independently converges to the same visible result within a fraction of a second. Consistency by convergence rather than by replication.

So when someone else drags a photograph, your client sees their interpolated position over awareness, moves the item, and *your* rope simulation wakes and swings in response. Nobody transmits a particle.

What may legitimately differ between two screens: the exact swing amplitude mid-drag, sub-pixel rope shape while moving, which frame a rope fell asleep on. What may not: topology, positions, ink, and the final settled pose. The divergence is acceptable precisely because nothing in the product ever reads physics state back — there's no scoring, no collision-driven logic, nothing persisted.

Remote motion is smoothed by rendering about 100 ms in the past and interpolating between samples, which turns a 20 Hz update stream into 60 fps motion. The interpolated pose — not the raw sample — drives the rope anchor, or the rope visibly jitters at the sample rate.

### 7.5 Assets

Bytes never enter the document. Images are hashed, stored once in a content-addressed store, and referenced by hash; the document carries only dimensions, type and size.

Because the dimensions are in the document, **an item is fully formed and fully usable before its bytes arrive.** It renders at the right size with its frame, caption, tape, pins and shadow from the moment it's created. You can pin it, string it, annotate it and caption it while the photograph is still transferring — ink and topology are in the CRDT and arrive first. Annotations can genuinely precede the photograph.

The waiting state is treated as an art direction opportunity rather than an error: an undeveloped-film look, grain and a faint chemical wash, animating gently while the transfer runs. A photo that no connected peer holds gets a torn-photograph treatment and a retry, plus a board-level notice naming who to ask.

### 7.6 Undo

One undo manager per client, tracking local operations only. Undo reverts *your* actions, not the last thing that happened on the board — the correct multiplayer semantic and the only one that isn't infuriating in a shared session.

It can still surprise: if someone moved an item after you did, your undo restores your earlier value and their move is lost. That's inherent. The mitigation is to flash-highlight what changed so it's never silent.

Camera and selection aren't in the document, but "undo takes me back to where I was" still matters, so they're stashed alongside each undo entry and restored on the way back.

Cascades must be atomic. Deleting an item deletes its ink, its pins, those pins' string nodes, and any string left with fewer than two nodes — all in one transaction, or undo restores half a board. Dangling references are *tolerated and rendered gracefully*, never repaired when read: a pin whose item vanished renders as free-floating, a string node pointing at a missing pin is skipped. Repair-on-read causes write storms in a shared session, so a single elected client compacts a few seconds later.

### 7.7 Sync

A transport-agnostic provider interface, implementing the y-websocket protocol, **with the relay embedded in the application binary**. The same code runs two ways:

- **LAN** — a peer hosts, advertised over mDNS. Zero infrastructure, works with no internet, ideal for two people at a table.
- **Relay** — the identical binary on a small server as an always-on, always-seeding peer.

Multiple providers attach simultaneously — disk, LAN, relay — and deduplicate for free.

Assets move as a side channel on the same connection: peers advertise what they hold, request what they need, and transfer in verified chunks, prioritised by what's near the *asking* peer's own viewport — a request carries its priority, and a holder serves what it is asked for in the order it was asked. Pushing what someone is about to look at before they ask would be a second direction of travel and is not built (T-226, Q-171); the camera that would have driven it is no longer on the wire.

**The tradeoff, stated plainly:** we own uptime, authentication and NAT traversal, and in LAN mode the hosting peer has to stay online. In exchange: no vendor dependency, no per-user cost, genuine offline-first operation, one protocol to debug, and a relay that doubles as the asset seed — which is the part that's actually hard.

### 7.8 The file

A `.schizo` bundle: a zip containing a manifest, a document snapshot and the assets. **Export always embeds assets**, so a board you hand to someone is never half a board.

**Opening one replaces the board in that window, and what it opens is a new board.** The window mints a fresh board id, so it is no longer in the room the replaced board was in — anybody connected stays on the old board, nothing of it merges back in, and the invite that reached them no longer reaches here (Q-114). That is not a detail of implementation: a document with peers is not one client's to replace, and the honest version of "replace" is to leave rather than to overwrite what everybody else is holding.

### 7.9 The picture

Two more exports beside the bundle, and they answer a different question. A `.schizo` *is* the board — reopenable, everything on it, the thing to send someone who is going to work on it. A PDF or an image is what it **looked like** — §1.4's picture of your thinking, for someone who is only going to read it, and the only sense in which this application exports anything to be shown.

**What an export covers is a region, not a cutout** (Q-127). With nothing selected it is the whole board; with something selected it is the bounds of that selection — and whatever else falls inside those bounds comes too. The menu row says which, because a right-click on bare cork leaves a selection standing and "the board" would otherwise be a lie in exactly the case nothing on screen corrects.

**The PDF is vector, and the handwriting is why** (Q-128). The webview prints the live document, so a note arrives as embedded, subsetted, selectable text in the right face — sharp at any magnification, where a bitmap of the same note is pixels forever. One page, exactly the shape of the board: not A4, not tiled. Backgrounds are forced on, because a print drops them by default and the cork, the paper colours, the ruling and the ageing are all CSS backgrounds.

**The image is composited, not printed** — six painters into one canvas, in the order §6.2 stacks them. Cork, board ink and both rope passes already draw themselves at any camera, so an export camera costs them nothing. The other two had to be written: the items rasterise through `foreignObject`, and the pins draw from the same sprite bake the screen uses, last, because a pin is physically on top of what it holds. PNG by default because lossless is what someone who has not thought about it wants, with WebP offered beside it in the same save dialog for someone who has seen the file size (Q-138) — a whole-board PNG measured 456 MB.

**Neither carries chrome.** No dev HUD, no tool drawer, no info bar, no fps counter. This is not automatic: the first PDF this project produced printed all of it.

Three things an export must force that the screen never does, each of which was invisible until a rendered page was looked at:

- **The camera fits the page, not the window.** A print lays the document out at the paper width and fires no `resize`, so a board fitted for the window sits in the corner of a mostly empty page with its ropes cut off at the old width.
- **The detail tier is held at full.** A whole-board zoom is a few per cent, and §6.6's tier draws flat paper there — so an export otherwise comes out as sheets with no ruling, no ageing and no curl, however large the file.
- **The font travels inside the file** — the image route only, since Chromium embeds it for the PDF. `items.css` loads the woff2 by relative URL and a `data:` SVG cannot resolve one, so the writing silently falls back to whatever cursive the machine has: a different hand, wrapping differently, in every note, in a file that otherwise looks correct.

**The PDF is Windows only, and the menu says so by having one row fewer** (Q-139). Printing a document to a file is WebView2's `PrintToPdf`; the cross-platform alternative is a system print dialog, which chooses its own paper and never says when it finished — so it is neither the same file nor one an export could put the board back after. The image needs no such thing: it composites in the renderer and the shell only writes bytes. So on macOS and Linux the image *is* the picture, and there is no row offering a PDF that cannot arrive.

**A board too big to draw is scaled, never dropped.** An image is drawn at twice board scale and a PDF at one — the PDF gains nothing from being laid out larger, since its text is already vector and its photographs would only resample further from their stored size. From there each has its own ceiling: 268 megapixels for a canvas, 200 inches a side for a page. Past either, the export camera zooms out until it fits, rather than handing back a blank file that opens.

---

## 8. Application architecture

Full detail in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

### 8.1 Why desktop

Tauri v2 — Rust shell, TypeScript frontend. The web platform can't deliver several things this design depends on:

- **Real clipboard access.** Copying an image from a web page usually yields HTML with a remote URL rather than bytes, and fetching it in a browser hits CORS. Copying files from Explorer or Finder is invisible to the web clipboard event entirely. Both work natively.
- **Real image handling.** Decoding, EXIF orientation and downscaling a 40-megapixel photograph belongs on a native thread pool, not on the UI thread.
- **A real filesystem**, so a board of 300 photographs isn't fighting browser storage quotas.
- **LAN peer discovery**, which has no browser equivalent.

### 8.2 The split

**Rust owns bytes.** The content-addressed asset store, hashing, decode, EXIF, thumbnail and display variants. Document updates appended to a log on disk with batched flushes. Bundle open and save. Native clipboard and drag-drop. URL fetching. The sync relay and the asset transfer protocol.

**The frontend owns meaning.** All CRDT logic, all rendering, all physics, tool state, and the policy of what to ingest. Everything schema-shaped lives in one language.

The single most important interface decision: **image bytes reach the webview through a custom URI scheme, not through IPC.** An `asset://` protocol streams from disk with browser caching and range requests at zero JavaScript memory cost. Base64-ing a 12 MB photograph across the IPC boundary — which is the obvious first thing to try — is roughly the worst available option.

Ingestion returns as soon as the hash and dimensions are known, so the item appears instantly at the correct size while variants generate in the background.

### 8.3 Module boundaries

```
crdt/      schema, ops (every mutation), binding, undo, persistence, sync
state/     scene mirror, dirty sets, camera, selection, tool state machine
sim/       verlet, catenary, rope set, torsion
render/    the rAF loop, world transform, items, ink, ropes, pins, presence
platform/  every Tauri call, in one mockable module
ui/        toolbars, panels, dialogs — not the board
```

Two rules make this hold together:

**Every mutation goes through `crdt/ops/`.** Nothing anywhere else touches the document directly. This is what makes undo scoping, echo suppression and write batching possible at all, and it's enforceable by lint.

**`sim/` and `render/` never import `crdt/`.** They read a plain in-memory scene mirror, with hot fields in typed arrays. One module translates document events into scene mutations and dirty flags. Durable state flows one way: interaction → ops → document → observer → scene → render. Ephemeral state is the scoped exception: it writes straight to the scene and awareness, and reconciles when the document write lands.

`render/items/` sits behind an interface specifically so the PixiJS escalation stays contained.

---

## 9. Performance plan

Budget: 60 fps with 300 visible items and 100 awake ropes; under 8 ms per frame at 1000 visible items.

### 9.1 Culling

A uniform spatial grid over board space. Item bounds are rotation-expanded and shadow-padded, tested against the viewport expanded by 20%.

Off-screen items **return their DOM node to a pool and are removed** — at high counts, removal genuinely beats hiding — with a hysteresis band so items hovering at the edge don't thrash. `content-visibility` and containment on item nodes buy a good deal for free.

### 9.2 Simulation budget

A rope simulates only if its bounds, expanded by maximum sag, intersect the viewport margin; otherwise it force-sleeps at its cached pose. A global cap on awake particles, prioritised by on-screen area, means a pathological board degrades gracefully instead of dropping frames.

Nearly all ropes are asleep nearly always (§5.3). This is the whole story.

### 9.3 Ink

Ink canvases are sized to the ink, not the item, and most items have none. Off-screen canvases are evicted — strokes are the truth and canvases are a cache, so returning to an item just re-rasters. Re-raster happens at `devicePixelRatio × zoom` on debounced zoom-end, with the stale bitmap stretched in the interim.

### 9.4 Shadows

**No `box-shadow` or `filter: drop-shadow` on items.** `drop-shadow` is CPU-rasterised and catastrophic across hundreds of nodes; `box-shadow` is acceptable when static but interacts badly with rotation and can't be animated. Everything uses pre-baked nine-slice shadow sprites per archetype and elevation, positioned by the same transform as the item. Zero filter cost, and better art direction control than a blur radius gives you anyway.

String shadows are a second offset stroke pass, never `shadowBlur`.

### 9.5 Instrumentation

A dev HUD showing per-phase frame timings, awake particle count, DOM node count and document size, with a hard alert if the document passes 25 MB. Performance problems that aren't measured become "it feels slow lately", which is unfixable.

---

## 10. Roadmap

Each phase produces something runnable and demonstrable on its own.

| Phase | Slice |
|---|---|
| **0** | Tauri shell, infinite pan/zoom cork, camera and world transform. **Plus the fidelity spike:** 500 real photographs, zoom in and out, prove the re-raster story. This de-risks §6.1 before any product code exists. |
| **1** | Items. Paste an image → polaroid; paste text → note; blank scrap. Drag, rotate, select, delete. One default pin. Document bound and persisting to disk. |
| **2** | Pins. Add, remove, drag, re-parent. Single-pin swing. |
| **3** | **String.** Pin-to-pin, live rope with sag, catenary seeding, wake and sleep. Multi-pin runs. |
| **4** | Mid-string pin insertion and drag-to-note, with proportional slack splitting. Slack control, colours, hub pins, over/under layers. |
| **5** | Ink. Marker and highlighter, item-local strokes, wet/dry split, erasers. |
| **6** | ~~Draping. Rope-item collision and lift shadows.~~ Built and scrapped — see §5.6 and D-22. |
| **7** | **Multiplayer over the wire.** Relay, presence, asset transfer, placeholder states. |
| **8** | Polish. Ageing and wear, tape, handwritten captions, image and PDF export, bundle import/export. |

The schema and document binding land in phase 1. Only the network waits for phase 7 — which is the entire reason multiplayer was decided up front.

Phase 3 is the first phase where the app is recognisably the product. Phase 4 is where it becomes the thing in the brief.

---

## 11. Risks & open questions

### 11.1 The five that matter

**1 · DOM raster blur at zoom.** The most likely way this ends up looking cheap, and the thing that would force the WebGL escalation. *Mitigation:* the phase-0 spike settles it before any product code; the `will-change` discipline in §6.6 is a hard rule; `render/items/` stays behind an interface. Also decide the Linux tier early — its webview compositor is meaningfully weaker than Windows' or macOS's.

**2 · Rope jitter under remote drags.** The interpolation buffer is fiddly: too much delay feels laggy, too little jitters the rope at the sample rate. *Mitigation:* the interpolated pose drives the anchor, never the raw sample; a debug overlay drawing both (`Alt`+backquote, dev builds only); and a guaranteed fallback of critically-damped spring anchors, which are jitter-proof if slightly less responsive.

**3 · Concurrent mid-string insertion.** Two people splitting the same segment at once, both computing their split from the same prior state. *Mitigation:* slack on the node rather than in a parallel array; a renderer that tolerates invalid nodes rather than crashing; cascades in single transactions; and a fuzz harness running two documents through randomised concurrent operation sequences, asserting that no string survives with fewer than two valid nodes, no slack goes negative, and nothing ever becomes `NaN`.

**4 · The photograph that never arrives.** In LAN mode an asset can exist only on a peer who has since left. *Mitigation:* first-class placeholder states that keep the item fully usable; a recommended seeding relay; export that always embeds; and a board-level notice naming which peer holds what's missing.

**5 · Document growth.** Ink-heavy boards accumulate tombstones. *Mitigation:* binary packed strokes, stroke-deletion as the default eraser, periodic snapshot compaction, a bounded undo stack, and document size on the dev HUD with a hard alert.

### 11.2 Open questions

- ~~**Does the string pulling back on items (§5.7) survive contact with reality?**~~ **Answered by being struck, not by being tried.** The phase 3 prototype this asked for never happened and nobody recorded a decision either way, which is how it survived to be found again by two of D-41's surveyors. Struck on Q-157 as fundamentally redundant — §5.7 now says one-way is final and gives the reasoning.
- **How much ageing is too much?** Still needs a real board and a week of living with it — but no longer needs a week to be *looked* at. T-79 built the ladder: one seed at five ages, five seeds at one age, and a sheet turned four ways to check the fold against the light. A single value is unjudgeable and the ladder is what showed the first crease was drawn as a scratch.
- ~~**Is `under` string discoverable?**~~ **Answered on T-50: declined**, with the human agreeing in writing. Tucking a string behind a photo is a lovely detail nobody may ever find, and the candidate answer here was to make it happen automatically when a photo is dropped on top of a string. It is addressed instead by the context menu's *Tuck behind* row — discoverable by being in the menu rather than by being automatic, which is also the answer that never surprises anybody.
- ~~**What's the right handwriting face?**~~ **Answered (Q-101): Patrick Hand**, chosen out of four rendered on the same board rather than from samples. The jitter half was already answered (§3.6, T-81): it is expressed in `em`, so it holds up at every size by construction, and below about half zoom the text is illegible with or without it — which is the LOD tiers' problem, not the jitter's. `public/fonts/README.md` carries what changing the face would cost.
- ~~**Should search do anything beyond flying the camera?**~~ **Answered (Q-176): it marks them all, faintly.** T-85 had already settled the half the pillar cares about — nothing is filtered and nothing is hidden. The unsettled half was "matches" *plural*, and the answer is that the camera still flies to one and flashes it, and every other match wears a faint border for as long as the search is open (T-236, §3.7). A third option — ticks at the viewport edge pointing at matches off screen — was declined as the wrong scope: this marks what is already in front of you rather than becoming a device for finding what is not.
- ~~**Do we need an explicit "board time" for ageing,** or is wall-clock adequate?~~ **Answered (Q-105): wall-clock is adequate**, and per item rather than per board. §4.7 has the reasoning and what it costs.

---

*Companion documents: [`DATA-MODEL.md`](./DATA-MODEL.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md)*
