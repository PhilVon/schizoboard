# Schizoboard

An infinite corkboard for organising information that hasn't decided what shape it is yet.

You know the board. It's in every conspiracy film: a wall of photographs and clippings and index cards, half of them annotated in marker, all of it connected by red string that someone ran between pushpins at three in the morning. It's a genuinely good thinking tool, and it survives in fiction because it works — it lets you hold a mess in your hands and find the shape by feel, rather than deciding the structure up front.

Schizoboard is that board. Paste a photo and it lands as a polaroid. Paste text and it lands on paper. Draw on any of it with a marker or a highlighter. Then run red string between the pins — pin to pin, through as many pins as you like, and when you want a new connection you grab the string mid-run and pull a fresh pin out of it.

The string sags under gravity, swings when you move a photograph, drapes over whatever it crosses, and settles. That matters more than it sounds: the moment string stops behaving like string, it becomes an arrow, and the whole thing collapses back into a flowchart.

**Status:** design phase. No implementation yet.

---

## Documents

| | |
|---|---|
| **[DESIGN.md](./docs/DESIGN.md)** | The main document — vision, interaction, art direction, physics, rendering, roadmap |
| **[DATA-MODEL.md](./docs/DATA-MODEL.md)** | The schema contract every other part depends on |
| **[ARCHITECTURE.md](./docs/ARCHITECTURE.md)** | Module boundaries, the frame loop, the native split, sync protocols |

Start with `DESIGN.md`.

---

## Shape of the thing

- **Tauri v2** desktop app — Rust shell, TypeScript frontend
- **Hybrid renderer** — DOM and CSS for items, canvas for string, one camera transform
- **Verlet rope**, seeded from an analytic catenary, asleep whenever nothing is moving
- **Yjs CRDT** with a self-hosted relay, so boards are collaborative and offline-first
- **Content-addressed assets**, never inside the document — an item is usable before its photograph arrives

## Design pillars

**Physical, not skeuomorphic.** Not a leather texture on a calendar — a small volume of the world with two-and-a-bit dimensions, one light source, and things that hang and swing.

**The string is the product.** Everything else is in service of getting string between things.

**Nothing blocks thinking.** No dialogs, no choosing a type, no naming things before you have them.

**Mess is a feature.** Nothing snaps to a grid. There is no auto-layout and there will never be a tidy-up button. A board that looks organised has stopped being useful.
