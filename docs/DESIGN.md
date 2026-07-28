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

An item is a physical object lying on the board. Four archetypes, sharing one structure:

| Archetype | Created by | Looks like |
|---|---|---|
| **Polaroid** | Pasting or dropping an image | White frame, thick bottom border, handwritten caption area |
| **Note** | Pasting text | Lined or plain paper, handwritten face, ragged or torn edge |
| **Scrap** | The note tool with no text | Blank paper. Exists purely to be drawn on |
| **Card** | Explicit creation | Index card, ruled, slightly stiffer paper |

They differ only in styling and defaults. Every archetype can hold text, can hold ink, can hold an image, and can be pinned. A scrap is not a special type in the code — it's a note that happens to have no text yet, which is exactly what a blank piece of paper is.

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
| **Item-local** | Item units, origin at item centre, **un-rotated** | Parented pins, item ink, crop rectangles |
| **Screen** | Device pixels | Pointer input, rope canvas drawing, all UI |

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

Paste point is the cursor if it's over the board, otherwise the viewport centre. Dragging files in from the OS behaves identically. Undo: standard, one entry for the whole paste even when it creates twenty items.

Everything created this way gets **one pin**, placed at the top centre, and a small random rotation — between about −4° and +4°, seeded per item so it's stable. Nothing arrives straight.

### 3.2 Moving things

Drag an item to move it. Drag its rotation handle, or hold `R` and drag, to rotate. There is no resize handle on a polaroid — a photograph is the size it is — but notes, cards and scraps resize from their edges.

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
| Cut | Scissors modifier, or context menu → *Delete* | String removed; its pins stay where they are |

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

Undo: text edits are character-level and merge into sensible entries by typing pause.

### 3.7 Navigation

| Action | Input |
|---|---|
| Pan | Space+drag, middle-drag, or two-finger scroll |
| Zoom | Wheel (at cursor), pinch, `Ctrl+=` / `Ctrl+-` |
| Fit board | `Ctrl+0` |
| Actual size | `Ctrl+1` |
| Frame selection | `F` |
| Search | `Ctrl+F` — flies the camera to a match. **Never filters or hides.** |

Zoom range is roughly 5% to 400%. The board is unbounded in every direction.

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
```

---

## 4. Art direction

"High visual fidelity" is unactionable as a brief, so this section is specific. The governing principle: **fidelity comes from baking, not from per-frame effects.** Pre-rendered shadows, textures and sprites look better *and* cost nothing, where live blurs and filters look worse and cost everything (§9.4).

### 4.1 The single light

One global light direction, roughly from the upper left, about 30° off vertical. Every shadow in the application agrees with it — items, pins, string, the cork's own surface variation. Nothing else creates a sense of a real surface as cheaply, and nothing else breaks it as fast as one element lit from the wrong side.

Shadow colour is never black. It's a desaturated warm brown drawn from the cork, at low alpha.

### 4.2 Cork

A seamless cork texture, tiled, with a large-scale low-frequency noise overlay at low opacity to break up the repeat — tiling artefacts on a background are the single most common way this kind of app announces that it's cheap.

Over the top: a very slight vignette anchored to the viewport, and a broad soft light gradient anchored to the *world*, so panning moves across a surface that isn't uniformly lit. The cork also carries faint accumulated pinholes near where pins are and have been, which is a lovely detail that costs one extra sprite layer.

The board is unbounded, so the texture is generated from a per-board seed and tiles indefinitely.

### 4.3 Polaroids

The classic frame: white border, thick at the bottom, very slightly off-white and warmer at the edges. The photograph sits slightly inset with a fine inner shadow, so it reads as being *behind* the frame rather than printed on it.

Over the image: a subtle gloss gradient, a hint of vignette, and optional aging (§4.7). The caption area at the bottom takes handwriting, and is empty by default — most photographs on a real board are uncaptioned.

Every polaroid is rotated a few degrees, seeded per item. Optional tape at one or two corners, slightly translucent, with its own small shadow and a barely-visible torn edge.

### 4.4 Notes, cards and scraps

Paper stock varies: white, cream, yellow legal, graph, index card. Each has its own grain texture at low opacity, its own edge treatment, and its own slight colour variation across the sheet.

Edges are the tell. A machine-cut rectangle reads as a UI element; a torn or slightly irregular edge reads as paper. Notes get a subtly ragged edge by default, generated from the item seed, and a "torn" style with a proper rough tear on one side.

Paper curls very slightly at unpinned corners — implemented as a gradient and a shadow, not geometry — which is why a one-pin note looks like it's hanging and a four-pin note looks flat.

### 4.5 Pins

Pushpins are the default: a coloured spherical head with a specular highlight positioned per the global light, a visible metal shaft where it meets the surface, and its own small hard shadow. Thumbtacks and nails are alternatives.

Pins render above items and above string, because they're physically on top of both. The string's attachment point is drawn *under* the pin head, so the string genuinely appears to pass beneath it.

Pin head diameter stays within a range in *screen* space as you zoom out, so pins remain visible and clickable on a zoomed-out board rather than vanishing. This is a deliberate break from strict physical scaling and it's worth it.

### 4.6 String

The most important surface in the application.

Rendered as a three-pass stroke along the simulated polyline:

1. **Shadow** — offset along the light direction, a desaturated warm brown at low alpha (§4.1, never black), wider than the string. The *same* shadow everywhere, including where the string lies on top of an item.

   This last part is a reversal. The plan was for the shadow to widen and soften where a string is lifted onto a photograph, and it was built and then taken out again after looking at it: §6.4 forbids `shadowBlur`, so a canvas shadow here is an offset stroke and nothing else, and the only way to say *softer* is to say *wider*. A wider hard-edged stroke disappears into mottled brown cork and becomes a solid grey bar on white paper — so the pass meant to read as a string lifted a paper's thickness off the board read as a stripe ruled along the top of the note. The lift is not lost, only the shadow of it: an `over` string draws above the item layer, so it is visibly on top of what it crosses.
2. **Body** — the main colour, full width, round joins and caps.
3. **Highlight** — a brighter tint at reduced width, offset perpendicular to the light by about a pixel.

Three `stroke()` calls, and it reads as a lit cylinder. Twist and fibre come from a subtle repeating variation along the length rather than from simulation.

Default red is not a pure red — it's a slightly desaturated, slightly dark cotton red, because saturated red on brown cork vibrates unpleasantly. A taut string is very slightly thinner than a slack one.

### 4.7 Ageing and wear

Boards accumulate. Items gain, slowly and subtly, over board time rather than wall-clock time: paper yellowing at the edges, occasional coffee rings, dog-eared corners, small creases, faint fading on photographs. Ageing is deterministic from the item's seed and its age, never random per render, and it is always subtle enough that nobody consciously notices it — they just find that an old board feels older.

Ageing can be turned off entirely for anyone who finds it precious.

### 4.8 Typography

Handwriting for note text, captions and annotations — a decent connected hand for body text, plus a rougher marker-style face for annotations. Per-character jitter in baseline, rotation and size, seeded by character index so it's stable.

UI chrome is the opposite: a clean, quiet, neutral sans, low contrast, staying out of the way. The board is the loud part. Toolbars are dark, translucent, and float over the cork without pretending to be physical objects — a fake wooden toolbar would be skeuomorphism, which §1.3 rules out.

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
2. Project distance constraints between neighbours, several iterations, each pass moving both particles halfway to satisfaction.
3. Re-pin the endpoints to their pins' current world positions.
4. Resolve item collisions if the string is on the `over` layer (§5.6).

Working numbers, to be tuned: particles spaced 10–14 board units, so 12–20 per segment; 6 constraint iterations; damping around 0.98; gravity tuned by feel rather than by physical accuracy.

Fixed timestep of 1/120 s with an accumulator and a cap of four substeps per frame, so behaviour doesn't change with frame rate and a stalled tab doesn't explode on resume.

> **Tuned, and one of those numbers was wrong — see D-17.** Six constraint iterations leaves a rope settled **23% longer than its own rest length**, hanging 19 board units below the analytic pose, because position-based dynamics holds a load by holding a violation and the error is therefore permanent rather than transient. Iterating harder barely helps; halving the timestep quarters it. Shipped: sixteen micro-steps inside each fixed 1/120 s step, two alternating constraint passes each. The fixed step, the accumulator and the four-substep cap above are unchanged — those are what framerate independence is measured in.
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
- **If the user drags pins further apart than the rest length**, don't let the solver fight it. The string goes taut and pulls; if the coupling in §5.7 is on, it tugs at the item.

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


### 5.7 String pulling back on items

Ships **one-way by default**: items drive string, string doesn't drive items.

Behind a flag, and worth pursuing, is the reverse: a taut string exerting a capped, heavily damped torque on a **single-pin** item, so a photo pulled tight by a thread hangs slightly askew toward it. It is the detail that would most make the board feel physically coupled.

It's flagged rather than default because item → rope → torque → item is a feedback loop, and feedback loops oscillate. Mitigations: cap the torque hard, apply it only to single-pin items, disable it entirely while any endpoint of that string is being dragged by anyone, and keep the global off-switch.

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

Two LOD tiers, both about removing the things that cost most at small scales:

- **Below 35% zoom** — items become simplified cards: flat paper, baked shadow, and text swapped for a pre-rasterised snapshot. Live text layout is by far the largest cost when many items are visible. Ink renders at quarter resolution.
- **Below 15% zoom** — items are flat coloured rectangles, string draws as straight one-pixel chords with no sag, pins hide, board ink comes from tile thumbnails.

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

**Drags don't write per frame.** The live pose goes over the ephemeral channel; one transaction is written on release. A throttled write every half second guards against a crash losing work, merged into the same undo entry.

**Strokes commit as one record.** Everything up to pen-up is local and ephemeral. On release the stroke is simplified, quantised, delta-encoded and packed into a byte array — roughly 3–4 bytes per point against 50-odd for JSON floats. One stroke is one document entry, one undo step, one delete.

**Erasing deletes strokes.** The default eraser removes whole stroke records, which is tiny and merges cleanly. Rasterising and flattening ink would destroy both undo and merge, and is never done.

### 7.4 Ephemeral state, and why physics isn't synced

Cursors, selections, live drag poses, in-progress strokes and camera positions travel over an ephemeral awareness channel, not the document. They vanish on disconnect, which is correct.

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

Assets move as a side channel on the same connection: peers advertise what they hold, request what they need, and transfer in verified chunks, prioritised by what's near each peer's viewport. Since peers broadcast their camera, a seeder can push what someone is about to look at before they ask.

**The tradeoff, stated plainly:** we own uptime, authentication and NAT traversal, and in LAN mode the hosting peer has to stay online. In exchange: no vendor dependency, no per-user cost, genuine offline-first operation, one protocol to debug, and a relay that doubles as the asset seed — which is the part that's actually hard.

### 7.8 The file

A `.schizo` bundle: a zip containing a manifest, a document snapshot and the assets. **Export always embeds assets**, so a board you hand to someone is never half a board.

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

**2 · Rope jitter under remote drags.** The interpolation buffer is fiddly: too much delay feels laggy, too little jitters the rope at the sample rate. *Mitigation:* the interpolated pose drives the anchor, never the raw sample; a debug overlay drawing both; and a guaranteed fallback of critically-damped spring anchors, which are jitter-proof if slightly less responsive.

**3 · Concurrent mid-string insertion.** Two people splitting the same segment at once, both computing their split from the same prior state. *Mitigation:* slack on the node rather than in a parallel array; a renderer that tolerates invalid nodes rather than crashing; cascades in single transactions; and a fuzz harness running two documents through randomised concurrent operation sequences, asserting that no string survives with fewer than two valid nodes, no slack goes negative, and nothing ever becomes `NaN`.

**4 · The photograph that never arrives.** In LAN mode an asset can exist only on a peer who has since left. *Mitigation:* first-class placeholder states that keep the item fully usable; a recommended seeding relay; export that always embeds; and a board-level notice naming which peer holds what's missing.

**5 · Document growth.** Ink-heavy boards accumulate tombstones. *Mitigation:* binary packed strokes, stroke-deletion as the default eraser, periodic snapshot compaction, a bounded undo stack, and document size on the dev HUD with a hard alert.

### 11.2 Open questions

- **Does the string pulling back on items (§5.7) survive contact with reality?** It's the highest-value fidelity detail and the one most likely to oscillate. Prototype it in phase 3 even though it ships later.
- **How much ageing is too much?** Needs a real board and a week of living with it.
- **Is `under` string discoverable?** Tucking a string behind a photo is a lovely detail nobody may ever find. Possibly it should happen automatically when a photo is dropped on top of a string.
- **What's the right handwriting face,** and does per-character jitter hold up at small sizes or turn to mush?
- **Should search do anything beyond flying the camera?** Highlighting matches without hiding non-matches might be within the pillar. Filtering is not.
- **Do we need an explicit "board time" for ageing,** or is wall-clock adequate?

---

*Companion documents: [`DATA-MODEL.md`](./DATA-MODEL.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md)*
